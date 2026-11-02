/**
 * dsh-opensource-board —— 服务端入口（DSH 插件）
 * ============================================================================
 * 只读看板：读本机 git 仓库信息，返回 JSON 给设置页前端。
 * 不联网、不存 token、不上传任何数据。
 *
 * DSH 插件 API 依据（不是凭空写的）：
 *   · 服务端入口形状 `export const name / inject / apply(ctx)`，路由用
 *     `ctx.get('webServer').register({ kind:'exact', path, handler })` 注册，
 *     注册动作包在 `ctx.effect(...)` 里以便卸载 —— 读自本机已上线的
 *     `dsh-session-trash/index.js` 与 `dsh-command-fuse/index.js`；
 *   · 宿主没有暴露「插件配置 schema」API（未在任何已装插件里见到），因此
 *     配置沿用这些插件的做法：插件自己的 JSON 文件，原子写。
 *
 * 路径 / 配置优先级：
 *   1. 环境变量 DSH_OPENSOURCE_BOARD_ROOTS（path.delimiter 分隔）—— 只读，锁定
 *   2. 配置文件（默认 $DSH_HOME/opensource-board/config.json，可用
 *      DSH_OPENSOURCE_BOARD_CONFIG 指定）
 *   3. 内置默认根目录 DEFAULT_ROOT
 */

import { promises as fsp } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { discoverProjects, DEFAULT_MAX_PROJECTS, DEFAULT_CONCURRENCY } from './lib/discover.mjs'
import { normalizeRoot } from './lib/path-safety.mjs'
import { renderProjectsHtml, sanitizeText } from './lib/project-info.mjs'

const execFileAsync = promisify(execFile)

export const name = 'dsh-opensource-board'
export const version = '0.1.1'
export const inject = ['webServer']

/** 需求指定的主路由；alias 是为了兜底宿主对 `/api` 命名空间的所有权（见 README）。 */
const ROUTE = '/api/dsh-opensource-board'
const ALIAS_ROUTE = '/dsh-opensource-board'

/** 默认扫描根目录：可用 DSH_BOARD_ROOT 覆盖，否则按当前用户主目录推导，不硬编码任何机器路径。 */
export const DEFAULT_ROOT = process.env.DSH_BOARD_ROOT || join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace')

/**
 * 「我的 GitHub 账号」默认值。只用于本地字符串比对（判断项目是不是自己传的），
 * 不联网、不校验这个账号真实存在 —— 配置里写了 githubUser 就以配置为准。
 */
export const DEFAULT_GITHUB_USER = 'a307608689-afk'

/** 自检报告目录：$DSH_HOME/opensource-board/reports/latest.json（由外部脚本生成）。 */
const REPORTS_FILE_LIMIT = 1024 * 1024

const GIT_TIMEOUT_MS = 8000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const CONFIG_BODY_LIMIT = 64 * 1024
const CACHE_TTL_MS = 3000

/** 固定参数：不拼 shell、关掉 fsmonitor / 分页 / 签名校验 / 凭据助手。 */
const GIT_BASE_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.quotepath=false',
  '-c', 'color.ui=false',
  '-c', 'log.showSignature=false',
  '-c', 'credential.helper=',
]

/**
 * git 子进程环境：禁交互、禁分页、不读系统级 git 配置。
 *
 * 注意：这里**没有**用 `GIT_CONFIG_GLOBAL=os.devNull` 去屏蔽全局配置 ——
 * Windows 上 devNull 是 `\\.\nul`，git 会当成 URL 去访问并报
 * `fatal: unable to access '\\.\nul': Invalid argument`（实测过）。
 * 依赖的加固改为上面的 `-c` 覆盖项，且 GIT_TERMINAL_PROMPT=0 保证不会卡在输入密码。
 */
function gitEnv() {
  const env = { ...process.env }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_PAGER = 'cat'
  env.LC_ALL = 'C'
  delete env.GIT_ASKPASS
  delete env.GIT_CONFIG_GLOBAL
  return env
}

/**
 * 执行 git。argv 全是固定常量，dir 只作为 `-C` 的**单个 argv 元素**传入，
 * 永远不经过 shell —— 仓库目录名里出现 `&`、`;`、引号都不会被解析。
 */
async function runGit(dir, args) {
  const argv = [...GIT_BASE_ARGS, '-C', dir, ...args]
  const { stdout } = await execFileAsync('git', argv, {
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: 'utf8',
    env: gitEnv(),
  })
  return stdout
}

// ── 配置 ──────────────────────────────────────────────────────────────────

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function configPath() {
  const override = process.env.DSH_OPENSOURCE_BOARD_CONFIG
  if (override && override.trim()) return override.trim()
  return join(dshHome(), 'opensource-board', 'config.json')
}

function envRootsOverride() {
  const raw = process.env.DSH_OPENSOURCE_BOARD_ROOTS
  if (!raw || !raw.trim()) return null
  const parts = raw
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : null
}

function defaultConfig() {
  return { roots: [DEFAULT_ROOT], maxProjects: DEFAULT_MAX_PROJECTS, githubUser: DEFAULT_GITHUB_USER }
}

/** 账号名归一：去掉 @ 前缀与空白，空值回退默认账号。 */
export function normalizeGithubUser(raw) {
  const s = sanitizeText(raw, 80).replace(/^@+/, '').trim()
  return s || DEFAULT_GITHUB_USER
}

export function normalizeConfigShape(input) {
  const out = { roots: [], maxProjects: DEFAULT_MAX_PROJECTS, githubUser: DEFAULT_GITHUB_USER, warnings: [] }
  if (!input || typeof input !== 'object') {
    out.warnings.push('配置不是对象，已使用默认值')
    return { ...out, ...defaultConfig() }
  }
  out.githubUser = normalizeGithubUser(input.githubUser)
  const roots = Array.isArray(input.roots) ? input.roots : []
  for (const raw of roots) {
    const norm = normalizeRoot(raw)
    if (!norm.ok) {
      out.warnings.push('忽略无效根目录 ' + sanitizeText(raw, 120) + '：' + norm.error)
      continue
    }
    if (!out.roots.includes(norm.path)) out.roots.push(norm.path)
  }
  if (!out.roots.length) out.warnings.push('没有可用的根目录')
  const n = Number(input.maxProjects)
  out.maxProjects = Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n), 1000)) : DEFAULT_MAX_PROJECTS
  return out
}

async function loadConfig() {
  const override = envRootsOverride()
  const file = configPath()
  if (override) {
    // 环境变量模式：根目录完全以环境变量为准，但「我的账号」仍从配置文件读（不联网）
    let ghUser = DEFAULT_GITHUB_USER
    try {
      const text = await fsp.readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      ghUser = normalizeGithubUser(parsed && parsed.githubUser)
    } catch {
      // 读不到 / 坏 JSON：用默认账号，不影响扫描
    }
    return {
      config: { roots: override, maxProjects: DEFAULT_MAX_PROJECTS, githubUser: ghUser },
      warnings: [],
      file,
      envOverride: true,
    }
  }
  let text = ''
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { config: defaultConfig(), warnings: [], file, envOverride: false }
    }
    return {
      config: defaultConfig(),
      warnings: ['读取配置失败(' + (e && e.code || 'ERROR') + ')，使用默认值'],
      file,
      envOverride: false,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      config: defaultConfig(),
      warnings: ['配置文件不是合法 JSON，使用默认值'],
      file,
      envOverride: false,
    }
  }
  const norm = normalizeConfigShape(parsed)
  return {
    config: {
      roots: norm.roots.length ? norm.roots : defaultConfig().roots,
      maxProjects: norm.maxProjects,
      githubUser: norm.githubUser,
    },
    warnings: norm.warnings,
    file,
    envOverride: false,
  }
}

/** 原子写配置：先写临时文件再 rename，避免半截 JSON。 */
async function saveConfig(next) {
  const file = configPath()
  await fsp.mkdir(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  const body = JSON.stringify(next, null, 2) + '\n'
  await fsp.writeFile(tmp, body, 'utf8')
  try {
    await fsp.rename(tmp, file)
  } catch (e) {
    try {
      await fsp.unlink(tmp)
    } catch {}
    throw e
  }
  return file
}

// ── 扫描 + 缓存 ───────────────────────────────────────────────────────────

let cache = { at: 0, payload: null }

async function scan({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.payload && now - cache.at < CACHE_TTL_MS) return cache.payload

  const loaded = await loadConfig()
  const result = await discoverProjects(loaded.config.roots, {
    git: runGit,
    maxProjects: loaded.config.maxProjects,
    concurrency: DEFAULT_CONCURRENCY,
  })
  const payload = {
    projects: result.projects,
    warnings: [...loaded.warnings.map((error) => ({ code: 'CONFIG', error })), ...result.warnings],
    scannedRoots: result.scannedRoots,
    truncated: result.truncated,
    roots: loaded.config.roots,
    githubUser: loaded.config.githubUser,
    envOverride: loaded.envOverride,
  }
  cache = { at: Date.now(), payload }
  return payload
}

function invalidateCache() {
  cache = { at: 0, payload: null }
}

/** 对外输出的项目记录：显式列字段，避免把内部字段漏出去。 */
export function publicProject(p, opts = {}) {
  const gh = String(opts.githubUser || '').trim().toLowerCase()
  const owner = p.owner || null
  // mine 纯本地字符串比对：不联网、不调 API、不缓存 token
  const mine = !!(owner && gh && owner.toLowerCase() === gh)
  return {
    dir: p.dir,
    root: p.root,
    name: p.name,
    version: p.version || '',
    description: p.description || '',
    branch: p.branch || '',
    detached: !!p.detached,
    dirtyCount: typeof p.dirtyCount === 'number' ? p.dirtyCount : null,
    lastCommit: p.lastCommit ? { at: p.lastCommit.at, subject: p.lastCommit.subject } : null,
    remoteUrl: p.remoteUrl || null,
    owner,
    mine,
    ahead: typeof p.ahead === 'number' ? p.ahead : null,
    behind: typeof p.behind === 'number' ? p.behind : null,
    syncState: p.syncState || 'unknown',
    recentCommits: Array.isArray(p.recentCommits)
      ? p.recentCommits.slice(0, 3).map((c) => ({ at: c.at, hash: c.hash, subject: c.subject }))
      : [],
    latestTag: p.latestTag || null,
    hasPackageJson: !!p.hasPackageJson,
    errors: Array.isArray(p.errors) ? p.errors : [],
  }
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function sendText(res, code, body, type) {
  const text = String(body)
  res.writeHead(code, {
    'content-type': type || 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseUrl(req) {
  try {
    return new URL(req.url || '/', 'http://localhost')
  } catch {
    return null
  }
}

// ── 每个路由的 handler ────────────────────────────────────────────────────

async function handleProjects(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '只支持 GET', code: 'METHOD_NOT_ALLOWED' })
    return
  }
  const url = parseUrl(req)
  const force = !!(url && (url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true'))
  const onlyMine = !!(url && (url.searchParams.get('onlyMine') === '1' || url.searchParams.get('onlyMine') === 'true'))
  const data = await scan({ force })
  // 需求：这个接口直接返回 JSON 数组
  let list = data.projects.map((p) => publicProject(p, { githubUser: data.githubUser }))
  if (onlyMine) list = list.filter((p) => p.mine)
  sendJson(res, 200, list)
}

async function handleStatus(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '只支持 GET', code: 'METHOD_NOT_ALLOWED' })
    return
  }
  const url = parseUrl(req)
  const force = !!(url && url.searchParams.get('refresh') === '1')
  const data = await scan({ force })
  const loaded = await loadConfig()
  sendJson(res, 200, {
    ok: true,
    plugin: name,
    version,
    generatedAt: new Date().toISOString(),
    count: data.projects.length,
    roots: data.roots,
    githubUser: data.githubUser,
    envOverride: data.envOverride,
    configFile: loaded.file,
    truncated: data.truncated,
    warnings: data.warnings,
  })
}

async function handleConfig(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const loaded = await loadConfig()
    sendJson(res, 200, {
      ok: true,
      config: loaded.config,
      configFile: loaded.file,
      envOverride: loaded.envOverride,
      defaults: defaultConfig(),
      warnings: loaded.warnings,
    })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 GET / POST', code: 'METHOD_NOT_ALLOWED' })
    return
  }
  if (envRootsOverride()) {
    sendJson(res, 409, {
      ok: false,
      error: '扫描根目录已被环境变量 DSH_OPENSOURCE_BOARD_ROOTS 锁定，界面不能修改',
      code: 'ENV_OVERRIDE',
    })
    return
  }

  let body
  try {
    body = await readBody(req, CONFIG_BODY_LIMIT)
  } catch (e) {
    const code = e && e.code === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'BAD_BODY'
    sendJson(res, 413, { ok: false, error: '请求体读取失败：' + (e && e.message || 'error'), code })
    return
  }

  let input
  try {
    input = JSON.parse(body || '{}')
  } catch {
    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON', code: 'BAD_JSON' })
    return
  }
  if (!input || typeof input !== 'object' || !Array.isArray(input.roots)) {
    sendJson(res, 400, { ok: false, error: 'roots 必须是数组', code: 'BAD_CONFIG' })
    return
  }
  if (input.roots.length > 50) {
    sendJson(res, 400, { ok: false, error: '根目录最多 50 个', code: 'BAD_CONFIG' })
    return
  }

  const accepted = []
  const rejected = []
  for (const raw of input.roots) {
    const norm = normalizeRoot(raw)
    if (!norm.ok) {
      rejected.push({ root: sanitizeText(raw, 200), error: norm.error })
      continue
    }
    if (!accepted.includes(norm.path)) accepted.push(norm.path)
  }
  if (!accepted.length) {
    sendJson(res, 400, { ok: false, error: '没有有效的绝对路径根目录', code: 'BAD_CONFIG', rejected })
    return
  }

  // 请求体没带 githubUser 就沿用当前配置里的账号，避免保存根目录时把账号冲掉
  const current = await loadConfig()
  const ghUser = input.githubUser === undefined ? current.config.githubUser : normalizeGithubUser(input.githubUser)
  const next = normalizeConfigShape({ roots: accepted, maxProjects: input.maxProjects, githubUser: ghUser })
  const saved = { roots: next.roots, maxProjects: next.maxProjects, githubUser: next.githubUser }
  let file
  try {
    file = await saveConfig(saved)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: '配置写入失败：' + (e && e.message || 'error'), code: 'WRITE_FAILED' })
    return
  }
  invalidateCache()
  sendJson(res, 200, { ok: true, config: saved, configFile: file, rejected })
}

/** 自检报告文件路径（由外部脚本写入，本插件只读）。 */
export function reportPath() {
  return join(dshHome(), 'opensource-board', 'reports', 'latest.json')
}

/**
 * GET /reports/latest —— 读取「上次自检结果」。
 * 文件不存在是正常状态（还没跑过自检），返回 { ok:true, data:null } 而不是 404，
 * 前端据此显示「还没有自检记录」。
 */
async function handleReportsLatest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '只支持 GET', code: 'METHOD_NOT_ALLOWED' })
    return
  }
  const file = reportPath()
  let raw
  try {
    const st = await fsp.stat(file)
    if (!st.isFile()) {
      sendJson(res, 200, { ok: true, data: null })
      return
    }
    if (st.size > REPORTS_FILE_LIMIT) {
      sendJson(res, 200, { ok: true, data: null, warning: '报告文件过大（' + st.size + ' 字节），已忽略' })
      return
    }
    raw = await fsp.readFile(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      sendJson(res, 200, { ok: true, data: null })
      return
    }
    sendJson(res, 200, {
      ok: true,
      data: null,
      warning: '读取报告失败：' + sanitizeText((e && e.code) || (e && e.message), 80),
    })
    return
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    sendJson(res, 200, { ok: true, data: null, warning: 'latest.json 不是合法 JSON' })
    return
  }
  sendJson(res, 200, { ok: true, data, reportFile: file })
}

async function handleExport(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '只支持 GET', code: 'METHOD_NOT_ALLOWED' })
    return
  }
  const url = parseUrl(req)
  const force = !!(url && url.searchParams.get('refresh') === '1')
  const data = await scan({ force })
  const html = renderProjectsHtml(
    data.projects.map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      dir: p.dir,
      branch: p.branch,
      detached: p.detached,
      dirtyCount: p.dirtyCount,
      lastCommit: p.lastCommit,
      remoteUrl: p.remoteUrl,
    })),
    {
      title: '开源项目看板',
      generatedAt: new Date().toISOString(),
      roots: data.roots,
      warnings: data.warnings,
    },
  )
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  })
  res.end(html)
}

/** 路由表：path → handler。kind 恒为 exact（宿主 API 只见过 exact）。 */
const ROUTES = {
  '/projects': handleProjects,
  '/status': handleStatus,
  '/config': handleConfig,
  '/reports/latest': handleReportsLatest,
  '/export.html': handleExport,
}

export function apply(ctx) {
  const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  const web = server || ctx.webServer
  if (!web || typeof web.register !== 'function') {
    // 宿主这个版本没有 webServer：安静跳过，不抛异常拖垮整个 DSH 启动
    return
  }

  const disposers = []
  for (const base of [ROUTE, ALIAS_ROUTE]) {
    for (const [suffix, handler] of Object.entries(ROUTES)) {
      const path = base + suffix
      const dispose = web.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (e) {
            if (!res.headersSent) {
              sendJson(res, 500, {
                ok: false,
                error: '内部错误：' + sanitizeText(e && e.message, 200),
                code: (e && e.code) || 'INTERNAL',
              })
            } else {
              try {
                res.end()
              } catch {}
            }
          }
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {}
        }
      },
      'dsh-opensource-board: routes',
    )
  }
}

/** 供 selftest / smoke 使用（非 DSH 入口协议的一部分）。 */
export const __internal = {
  ROUTES,
  ROUTE,
  ALIAS_ROUTE,
  DEFAULT_ROOT,
  DEFAULT_GITHUB_USER,
  dshHome,
  configPath,
  reportPath,
  loadConfig,
  saveConfig,
  normalizeConfigShape,
  normalizeGithubUser,
  publicProject,
  scan,
  invalidateCache,
  runGit,
  handleProjects,
  handleReportsLatest,
}
