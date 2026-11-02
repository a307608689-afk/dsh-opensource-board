/**
 * dsh-opensource-board —— 项目发现（只读，无网络）
 * ============================================================================
 * 规则（需求原文）：扫描每个配置根目录下「含 .git 的直接子目录」，一层，不递归。
 *
 * 安全边界：
 *   · 子目录先做字符串前缀校验（pathInside），再 realpath 后**重新**校验一次；
 *     这样 junction / symlink 指向根目录之外时会被拒掉，不会顺着链接读到别处；
 *   · 所有 git 调用由外部注入的 git(dir, args) 执行，参数是固定数组，不经过 shell；
 *   · 单个目录读失败只影响这一条记录，不影响整块看板。
 *
 * 可测试性：文件系统与 git 都通过 deps 注入（默认实现走 node:fs），
 * selftest 用假 git 输出验证解析逻辑，不需要真的建仓库、不联网。
 */

import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { pathInside, normalizeRoot } from './path-safety.mjs'
import {
  countPorcelainChanges,
  parseBranch,
  parseLastCommit,
  parsePackageJson,
  parseRemoteUrl,
  sanitizeText,
} from './project-info.mjs'

export const DEFAULT_MAX_PROJECTS = 200
export const DEFAULT_CONCURRENCY = 4
const PACKAGE_MAX_BYTES = 512 * 1024

/** 默认依赖：真实文件系统。git 必须由调用方注入（index.js 用 child_process 实现）。 */
export const REAL_DEPS = {
  async listDir(dir) {
    return fsp.readdir(dir, { withFileTypes: true })
  },
  async statPath(p) {
    try {
      return await fsp.lstat(p)
    } catch (e) {
      if (e && e.code === 'ENOENT') return null
      throw e
    }
  },
  async readTextFile(p, maxBytes = PACKAGE_MAX_BYTES) {
    let st
    try {
      st = await fsp.stat(p)
    } catch (e) {
      if (e && e.code === 'ENOENT') return null
      throw e
    }
    if (!st.isFile()) return null
    if (st.size > maxBytes) {
      const err = new Error('文件过大（' + st.size + ' 字节）')
      err.code = 'TOO_LARGE'
      throw err
    }
    return fsp.readFile(p, 'utf8')
  },
  async realpath(p) {
    return fsp.realpath(p)
  },
  git() {
    throw new Error('未注入 git 执行器')
  },
  now() {
    return Date.now()
  },
}

function withDefaults(deps) {
  const d = { ...REAL_DEPS, ...(deps || {}) }
  if (typeof d.git !== 'function') d.git = REAL_DEPS.git
  return d
}

function shortErr(err) {
  const msg = err && err.message ? err.message : String(err)
  if (err && err.killed) return 'git 超时（' + (err.timeout ? err.timeout + 'ms' : '超时') + '）'
  return sanitizeText(msg, 200)
}

/** 并发受限的 map；单个任务抛错不会拖垮整批（该位置得到 null）。 */
export async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : []
  const out = new Array(list.length)
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1))
  let cursor = 0
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= list.length) return
      try {
        out[index] = await fn(list[index], index)
      } catch {
        out[index] = null
      }
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 读取一个仓库的看板信息。
 * 返回的记录无论 git 是否可用都会返回（dir 有效），失败信息放 git/errors 里。
 */
export async function inspectRepo(dir, root, deps = {}) {
  const d = withDefaults(deps)
  const errors = []
  const warnings = []
  const record = {
    dir,
    root,
    dirName: basename(dir),
    name: '',
    version: '',
    description: '',
    packageJsonPath: join(dir, 'package.json'),
    hasPackageJson: false,
    branch: '',
    detached: false,
    dirtyCount: null,
    lastCommit: null,
    remoteUrl: null,
    git: { ok: false, error: '' },
    warnings,
    errors,
  }

  // ── package.json（没有就用目录名，不算错） ──────────────────────────
  let pkg = { name: '', version: '', description: '', error: '' }
  try {
    const text = await d.readTextFile(join(dir, 'package.json'))
    if (text == null) {
      warnings.push('没有 package.json，项目名用目录名')
    } else {
      record.hasPackageJson = true
      pkg = parsePackageJson(text)
      if (pkg.error) warnings.push('package.json 解析失败：' + pkg.error)
    }
  } catch (e) {
    warnings.push('读取 package.json 失败：' + shortErr(e))
  }
  record.name = pkg.name || sanitizeText(basename(dir), 120)
  record.version = pkg.version
  record.description = pkg.description

  // ── git：四个固定参数调用并行跑，单个失败只丢对应字段 ──────────────
  const git = (args) => d.git(dir, args)
  const [branchR, statusR, logR, remoteR] = await Promise.allSettled([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
    git(['log', '-1', '--format=%cI%n%s']),
    git(['remote', 'get-url', 'origin']),
  ])

  if (branchR.status === 'fulfilled') {
    const parsed = parseBranch(branchR.value)
    record.branch = parsed.branch
    record.detached = parsed.detached
    if (parsed.detached) {
      try {
        const sha = sanitizeText(await git(['rev-parse', '--short', 'HEAD']), 40)
        if (sha) record.branch = sha
      } catch (e) {
        errors.push('detached HEAD 短 sha 读取失败：' + shortErr(e))
      }
    }
  } else {
    errors.push('分支读取失败：' + shortErr(branchR.reason))
  }

  if (statusR.status === 'fulfilled') {
    record.dirtyCount = countPorcelainChanges(statusR.value)
  } else {
    errors.push('git status 读取失败：' + shortErr(statusR.reason))
  }

  if (logR.status === 'fulfilled') {
    const parsed = parseLastCommit(logR.value)
    if (parsed.error) {
      warnings.push(parsed.error)
    } else {
      record.lastCommit = { at: parsed.at, subject: parsed.subject }
    }
  } else {
    const msg = shortErr(logR.reason)
    // 空仓库（还没有第一笔提交）是正常状态，不当成错误
    if (/does not have any commits|bad default revision|unknown revision/i.test(msg)) {
      warnings.push('还没有任何提交')
    } else {
      errors.push('git log 读取失败：' + msg)
    }
  }

  if (remoteR.status === 'fulfilled') {
    record.remoteUrl = parseRemoteUrl(remoteR.value)
  } else {
    // 没有 origin 是常见情况，不算错误
    record.remoteUrl = null
  }

  record.git.ok = branchR.status === 'fulfilled' && statusR.status === 'fulfilled'
  record.git.error = errors.length ? errors[0] : ''
  return record
}

/**
 * 扫描一批根目录，返回 { projects, warnings, scannedRoots, truncated }。
 * projects 已按项目名排序；warnings 描述被跳过的根目录 / 越界目录 / 超限。
 */
export async function discoverProjects(roots, deps = {}) {
  const d = withDefaults(deps)
  const maxProjects = Math.max(1, Math.min(Number(d.maxProjects) || DEFAULT_MAX_PROJECTS, 1000))
  const concurrency = Math.max(1, Math.min(Number(d.concurrency) || DEFAULT_CONCURRENCY, 8))
  const projects = []
  const warnings = []
  const scannedRoots = []
  const seenDirs = new Set()

  const addWarning = (code, extra) => warnings.push({ code, ...extra })

  for (const rootInput of Array.isArray(roots) ? roots : []) {
    const norm = normalizeRoot(rootInput)
    if (!norm.ok) {
      addWarning('BAD_ROOT', { root: String(rootInput), error: norm.error })
      continue
    }

    let realRoot
    try {
      realRoot = await d.realpath(norm.path)
    } catch (e) {
      addWarning('ROOT_MISSING', { root: norm.path, error: shortErr(e) })
      continue
    }

    let st
    try {
      st = await d.statPath(realRoot)
    } catch (e) {
      addWarning('ROOT_UNREADABLE', { root: realRoot, error: shortErr(e) })
      continue
    }
    if (!st || !st.isDirectory()) {
      addWarning('ROOT_NOT_DIR', { root: realRoot, error: '不是目录' })
      continue
    }

    let entries
    try {
      entries = await d.listDir(realRoot)
    } catch (e) {
      addWarning('ROOT_UNREADABLE', { root: realRoot, error: shortErr(e) })
      continue
    }
    scannedRoots.push(realRoot)

    // 找出「含 .git 的直接子目录」
    const repos = []
    for (const entry of entries) {
      if (!entry || !(entry.isDirectory() || entry.isSymbolicLink())) continue
      const name = String(entry.name || '')
      if (!name || name.startsWith('.')) continue

      const child = join(realRoot, name)
      // 第一道闸：字符串层面必须在根目录内
      if (!pathInside(realRoot, child)) {
        addWarning('OUT_OF_ROOT', { root: realRoot, path: child, error: '路径越界，已跳过' })
        continue
      }

      // 第二道闸：解析链接后的真实路径仍必须在根目录内
      let realChild
      try {
        realChild = await d.realpath(child)
      } catch {
        continue // 断链 / 无权限，安静跳过
      }
      if (!pathInside(realRoot, realChild)) {
        addWarning('OUT_OF_ROOT', { root: realRoot, path: child, error: '链接指向根目录之外，已跳过' })
        continue
      }

      let dotGit = null
      try {
        dotGit = await d.statPath(join(realChild, '.git'))
      } catch {
        dotGit = null
      }
      if (!dotGit) continue
      repos.push(realChild)
    }

    let room = maxProjects - projects.length
    if (room <= 0) {
      addWarning('LIMIT', { root: realRoot, error: '项目数达到上限 ' + maxProjects + '，后面的根目录不再扫描' })
      break
    }
    if (repos.length > room) {
      addWarning('LIMIT', { root: realRoot, error: '项目数超过上限，只取前 ' + room + ' 个' })
      repos.length = room
    }

    const records = await mapLimit(repos, concurrency, async (repoDir) => {
      const key = process.platform === 'win32' ? repoDir.toLowerCase() : repoDir
      if (seenDirs.has(key)) return null // 同一仓库被多个根目录覆盖时只显示一次
      seenDirs.add(key)
      return inspectRepo(repoDir, realRoot, { ...d, maxProjects, concurrency })
    })

    for (const record of records) {
      if (record) projects.push(record)
    }
  }

  projects.sort((a, b) => {
    const an = String(a.name || a.dirName).toLowerCase()
    const bn = String(b.name || b.dirName).toLowerCase()
    if (an !== bn) return an < bn ? -1 : 1
    return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
  })

  return {
    projects,
    warnings,
    scannedRoots,
    truncated: warnings.some((w) => w.code === 'LIMIT'),
  }
}
