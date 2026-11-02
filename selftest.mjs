/**
 * selftest.mjs —— 离线单元自检（不联网、不依赖真实 git、不写仓库）
 * ============================================================================
 *   node selftest.mjs
 *
 * 覆盖：
 *   1. 路径校验（normalizeRoot / pathInside / safeJoinInside）
 *   2. git / package.json 输出解析（分支、改动数、提交、remote、转义）
 *   3. 目录扫描（正常仓库、空根目录、根目录不存在、junction 越界）
 *   4. index.js 的配置形状校验与对外字段白名单
 *
 * 用假 deps 注入，因此可以在任何机器上跑，不会执行 git、不会碰用户目录。
 */

import assert from 'node:assert/strict'
import { resolve, join, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { normalizeRoot, pathInside, safeJoinInside, samePath } from './lib/path-safety.mjs'
import {
  escapeHtml,
  sanitizeText,
  parsePackageJson,
  countPorcelainChanges,
  parseLastCommit,
  parseBranch,
  parseRemoteUrl,
  redactUrlCredentials,
  formatLocalIso,
  renderProjectsHtml,
} from './lib/project-info.mjs'
import { discoverProjects, inspectRepo, mapLimit } from './lib/discover.mjs'
import { normalizeConfigShape, publicProject, DEFAULT_ROOT } from './index.js'

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push({ name, error: e })
    console.log('  FAIL ' + name + ' —— ' + (e && e.message))
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push({ name, error: e })
    console.log('  FAIL ' + name + ' —— ' + (e && e.message))
  }
}

function section(title) {
  console.log('\n[' + title + ']')
}

/** 造一个绝对假根目录，不落盘。 */
function fakeRoot(tag) {
  return resolve(tmpdir(), 'dsh-ob-selftest-' + tag)
}

function dirEntry(name) {
  return { name, isDirectory: () => true, isSymbolicLink: () => false }
}

const isWin = process.platform === 'win32'

// ── 1. 路径校验 ────────────────────────────────────────────────────────────
section('路径校验')

test('normalizeRoot 接受绝对路径并规范化', () => {
  const root = fakeRoot('a')
  const r = normalizeRoot(root)
  assert.equal(r.ok, true)
  assert.equal(r.path, resolve(root))
})

test('normalizeRoot 去掉首尾空格', () => {
  const r = normalizeRoot('  ' + fakeRoot('b') + '  ')
  assert.equal(r.ok, true)
})

test('normalizeRoot 拒绝空 / 纯空格', () => {
  assert.equal(normalizeRoot('').ok, false)
  assert.equal(normalizeRoot('   ').ok, false)
  assert.equal(normalizeRoot(null).ok, false)
})

test('normalizeRoot 拒绝相对路径', () => {
  assert.equal(normalizeRoot('relative/dir').ok, false)
  assert.equal(normalizeRoot('./x').ok, false)
})

test('normalizeRoot 拒绝控制字符与超长路径', () => {
  assert.equal(normalizeRoot(fakeRoot('c') + '\u0000x').ok, false)
  assert.equal(normalizeRoot(fakeRoot('d') + '\u0007').ok, false)
  assert.equal(normalizeRoot('C:' + sep + 'x'.repeat(600)).ok, false)
})

test('normalizeRoot 展开 %VAR% 环境变量', () => {
  process.env.DSH_OB_SELFTEST_ROOT = fakeRoot('env')
  const r = normalizeRoot('%DSH_OB_SELFTEST_ROOT%')
  assert.equal(r.ok, true)
  assert.equal(r.path, resolve(fakeRoot('env')))
})

test('pathInside：相等 / 子路径 / 前缀陷阱', () => {
  const base = fakeRoot('p')
  assert.equal(pathInside(base, base), true)
  assert.equal(pathInside(base, join(base, 'sub')), true)
  assert.equal(pathInside(base, join(base, '..', 'other')), false)
  // 前缀相同的兄弟目录不能被当成子目录
  assert.equal(pathInside(join(base, 'a'), join(base, 'ab')), false)
  assert.equal(pathInside(join(base, 'a'), join(base, 'a2', 'x')), false)
})

test('pathInside：Windows 大小写不敏感', () => {
  if (!isWin) return
  const base = 'C:\\Workspace\\Root'
  assert.equal(pathInside(base, 'c:\\workspace\\root\\sub'), true)
})

test('samePath', () => {
  const base = fakeRoot('s')
  assert.equal(samePath(base, join(base, '.', 'x', '..')), true)
})

test('safeJoinInside 拦截越界与绝对路径', () => {
  const base = fakeRoot('j')
  assert.equal(safeJoinInside(base, 'ok').ok, true)
  assert.equal(safeJoinInside(base, join(base, 'sub', 'x')).ok, false) // 传进来就是绝对路径
  assert.equal(safeJoinInside(base, '../../x').ok, false)
  assert.equal(safeJoinInside(base, '').ok, false)
  if (isWin) {
    assert.equal(safeJoinInside(base, '..\\x').ok, false)
    assert.equal(safeJoinInside(base, 'D:\\other').ok, false)
    assert.equal(safeJoinInside(base, 'C:/other').ok, false)
  } else {
    assert.equal(safeJoinInside(base, '/etc/passwd').ok, false)
  }
})

// ── 2. git / package.json 解析 ─────────────────────────────────────────────
section('git / package.json 解析')

test('parsePackageJson 正常读取三字段', () => {
  const pkg = parsePackageJson(JSON.stringify({ name: 'demo', version: '1.2.3', description: '一句话描述' }))
  assert.equal(pkg.error, '')
  assert.equal(pkg.name, 'demo')
  assert.equal(pkg.version, '1.2.3')
  assert.equal(pkg.description, '一句话描述')
})

test('parsePackageJson 坏 JSON / 非对象 / 空 都不抛异常', () => {
  assert.ok(parsePackageJson('{oops').error)
  assert.ok(parsePackageJson('[1,2]').error)
  assert.ok(parsePackageJson('').error)
  assert.ok(parsePackageJson(null).error)
})

test('parsePackageJson 缺字段时留空', () => {
  const pkg = parsePackageJson('{"name":"only-name"}')
  assert.equal(pkg.name, 'only-name')
  assert.equal(pkg.version, '')
  assert.equal(pkg.description, '')
})

test('countPorcelainChanges 按行计数', () => {
  assert.equal(countPorcelainChanges(''), 0)
  assert.equal(countPorcelainChanges('\n\n'), 0)
  assert.equal(countPorcelainChanges(' M a.js\n'), 1)
  assert.equal(countPorcelainChanges(' M a.js\n?? b/\nA  c.md\n'), 3)
  assert.equal(countPorcelainChanges('R  old -> new\n'), 1) // 重命名只算一处
  assert.equal(countPorcelainChanges(' M a.js\r\n?? b/\r\n'), 2) // CRLF 也按行
})

test('parseLastCommit 解析 %cI + 标题', () => {
  const p = parseLastCommit('2026-11-01T12:34:56+08:00\nfeat: 加看板\n\n更多说明')
  assert.equal(p.error, '')
  assert.equal(p.at, '2026-11-01T12:34:56+08:00')
  assert.equal(p.subject, 'feat: 加看板 更多说明')
})

test('parseLastCommit 空仓库 / 坏时间', () => {
  assert.ok(parseLastCommit('').error)
  assert.ok(parseLastCommit('not-a-date\ntitle').error)
})

test('parseBranch 普通分支 / 分离 HEAD', () => {
  assert.deepEqual(parseBranch('main\n'), { branch: 'main', detached: false })
  assert.deepEqual(parseBranch('feature/x\r\n'), { branch: 'feature/x', detached: false })
  assert.deepEqual(parseBranch('HEAD\n'), { branch: '', detached: true })
  assert.deepEqual(parseBranch(''), { branch: '', detached: false })
})

test('redactUrlCredentials 遮掉 token 但保留用户名', () => {
  const s = redactUrlCredentials('https://user:ghp_secret@github.com/a/b.git')
  assert.equal(s, 'https://user:***@github.com/a/b.git')
  assert.equal(redactUrlCredentials('https://github.com/a/b.git'), 'https://github.com/a/b.git')
  assert.equal(redactUrlCredentials('git@github.com:a/b.git'), 'git@github.com:a/b.git')
})

test('parseRemoteUrl 无 origin 时返回 null', () => {
  assert.equal(parseRemoteUrl(''), null)
  assert.equal(parseRemoteUrl('   '), null)
  assert.equal(parseRemoteUrl('https://github.com/a/b.git\n'), 'https://github.com/a/b.git')
})

test('sanitizeText 压平换行、去控制字符、截断', () => {
  assert.equal(sanitizeText('a\r\nb\tc'), 'a b c')
  assert.equal(sanitizeText('a\u0000\u0007b'), 'ab')
  assert.equal(sanitizeText('x'.repeat(10), 5), 'xxxx…')
  assert.equal(sanitizeText(null), '')
})

test('escapeHtml 转义五类危险字符', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>&`'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#96;',
  )
})

test('escapeHtml 先转 & 不会二次转义', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;')
})

test('formatLocalIso', () => {
  assert.match(formatLocalIso('2026-11-01T12:34:56+08:00'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatLocalIso('garbage'), 'garbage')
  assert.equal(formatLocalIso(''), '')
})

test('renderProjectsHtml 转义注入内容且包含字段', () => {
  const html = renderProjectsHtml(
    [
      {
        name: '<img src=x onerror=alert(1)>',
        version: '9.9.9',
        description: 'a & b',
        dir: 'C:\\ws\\<b>',
        branch: 'main "quoted"',
        detached: false,
        dirtyCount: 3,
        lastCommit: { at: '2026-11-01T12:34:56+08:00', subject: '<script>x</script>' },
        remoteUrl: 'https://github.com/a/b.git?x=<y>',
      },
    ],
    { title: '<h1>t</h1>', generatedAt: '2026-11-02T00:00:00+08:00', roots: ['C:\\ws\\<r>'], warnings: [] },
  )
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(!html.includes('<img src=x'), '项目名必须被转义')
  assert.ok(!html.includes('<script>x</script>'), '提交标题必须被转义')
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(html.includes('a &amp; b'))
  assert.ok(html.includes('v9.9.9'))
  assert.ok(html.includes('3 项'))
})

test('renderProjectsHtml 空列表给出空状态而不是空表格', () => {
  const html = renderProjectsHtml([], { title: '空', roots: [] })
  assert.ok(html.includes('没有找到项目'))
  assert.ok(!html.includes('<table>'))
})

// ── 3. 扫描逻辑 ────────────────────────────────────────────────────────────
section('目录扫描（假 deps，不落盘）')

function makeDeps(opts) {
  const root = opts.root
  const children = opts.children || [] // [{name, realPath?, hasGit}]
  const packages = opts.packages || {} // name -> package.json 文本
  const gitResults = opts.gitResults || {} // name -> { branch, status, log, remote } | 'throw'
  const outside = opts.outside || {}

  return {
    async listDir(dir) {
      if (resolve(dir) !== resolve(root)) {
        const e = new Error('ENOENT')
        e.code = 'ENOENT'
        throw e
      }
      return children.map((c) => dirEntry(c.name))
    },
    async statPath(p) {
      const r = resolve(p)
      if (r === resolve(root)) return { isDirectory: () => true, isSymbolicLink: () => false }
      for (const child of children) {
        const childPath = join(root, child.name)
        if (r === resolve(childPath)) return { isDirectory: () => true, isSymbolicLink: () => false }
        if (r === resolve(join(childPath, '.git')) && child.hasGit) {
          return { isDirectory: () => true, isSymbolicLink: () => false }
        }
      }
      const e = new Error('ENOENT')
      e.code = 'ENOENT'
      throw e
    },
    async readTextFile(p) {
      for (const child of children) {
        if (resolve(p) === resolve(join(root, child.name, 'package.json'))) {
          return packages[child.name] == null ? null : packages[child.name]
        }
      }
      return null
    },
    async realpath(p) {
      const r = resolve(p)
      if (r === resolve(root)) return r
      for (const child of children) {
        if (r === resolve(join(root, child.name))) return outside[child.name] || r
      }
      // 真 fs.realpath 对不存在的路径会 ENOENT，这里保持一致
      const e = new Error('ENOENT: no such file or directory')
      e.code = 'ENOENT'
      throw e
    },
    async git(dir, args) {
      const name = String(dir).split(/[\\/]/).filter(Boolean).pop()
      const spec = gitResults[name]
      if (!spec || spec === 'throw') {
        const e = new Error('not a git repository')
        throw e
      }
      const key = args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'branch'
        : args[0] === 'status' ? 'status'
          : args[0] === 'log' ? 'log'
            : args[0] === 'remote' ? 'remote'
              : 'other'
      if (spec[key] == null) {
        const e = new Error('git failed: ' + args.join(' '))
        throw e
      }
      return spec[key]
    },
  }
}

await testAsync('discoverProjects 解析出完整项目记录', async () => {
  const root = fakeRoot('scan1')
  const deps = makeDeps({
    root,
    children: [
      { name: 'alpha', hasGit: true },
      { name: 'beta', hasGit: true },
      { name: 'plain', hasGit: false },
      { name: '.hidden', hasGit: true },
    ],
    packages: {
      alpha: JSON.stringify({ name: '@acme/alpha', version: '1.0.0', description: '第一个项目' }),
      beta: JSON.stringify({ name: 'beta', version: '0.2.0', description: '第二个项目' }),
    },
    gitResults: {
      alpha: {
        branch: 'main\n',
        status: ' M a.js\n?? b/\n',
        log: '2026-11-01T12:00:00+08:00\nfeat: alpha 首提交\n',
        remote: 'https://github.com/acme/alpha.git\n',
      },
      beta: {
        branch: 'HEAD\n',
        status: '',
        log: '2026-10-31T09:30:00+08:00\nchore: beta\n',
        remote: 'git@github.com:acme/beta.git\n',
      },
    },
  })

  const result = await discoverProjects([root], deps)
  assert.equal(result.projects.length, 2, '只应识别两个真实仓库（跳过 plain 与 .hidden）')
  assert.equal(result.scannedRoots.length, 1)

  const alpha = result.projects.find((p) => p.name === '@acme/alpha')
  assert.ok(alpha, 'alpha 应存在')
  assert.equal(alpha.version, '1.0.0')
  assert.equal(alpha.description, '第一个项目')
  assert.equal(alpha.branch, 'main')
  assert.equal(alpha.detached, false)
  assert.equal(alpha.dirtyCount, 2)
  assert.equal(alpha.lastCommit.at, '2026-11-01T12:00:00+08:00')
  assert.equal(alpha.lastCommit.subject, 'feat: alpha 首提交')
  assert.equal(alpha.remoteUrl, 'https://github.com/acme/alpha.git')
  assert.equal(alpha.hasPackageJson, true)

  const beta = result.projects.find((p) => p.name === 'beta')
  assert.ok(beta)
  assert.equal(beta.dirtyCount, 0)
  assert.equal(beta.remoteUrl, 'git@github.com:acme/beta.git')

  // 排序：@acme/alpha 的排序键 "@acme/alpha" < "beta"
  assert.equal(result.projects[0].name, '@acme/alpha')
})

await testAsync('discoverProjects 空根目录返回空数组而不是报错', async () => {
  const root = fakeRoot('scan2')
  const result = await discoverProjects([root], makeDeps({ root, children: [] }))
  assert.deepEqual(result.projects, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.scannedRoots.length, 1)
})

await testAsync('discoverProjects 根目录不存在 → 警告，不崩', async () => {
  const root = fakeRoot('scan3')
  const deps = makeDeps({ root, children: [] })
  const result = await discoverProjects([join(root, 'nope')], deps)
  assert.deepEqual(result.projects, [])
  assert.ok(result.warnings.some((w) => w.code === 'ROOT_MISSING'))
})

await testAsync('discoverProjects 非法根目录（相对路径）→ BAD_ROOT', async () => {
  const result = await discoverProjects(['relative/path'], makeDeps({ root: fakeRoot('x'), children: [] }))
  assert.ok(result.warnings.some((w) => w.code === 'BAD_ROOT'))
  assert.deepEqual(result.scannedRoots, [])
})

await testAsync('discoverProjects 拦截 junction 指向根目录之外', async () => {
  const root = fakeRoot('scan4')
  const outside = fakeRoot('outside')
  const deps = makeDeps({
    root,
    children: [
      { name: 'evil', hasGit: true },
      { name: 'good', hasGit: true },
    ],
    outside: { evil: outside },
    packages: { good: JSON.stringify({ name: 'good', version: '1.0.0' }) },
    gitResults: {
      good: { branch: 'main\n', status: '', log: '2026-11-01T12:00:00+08:00\nt\n', remote: '' },
    },
  })
  const result = await discoverProjects([root], deps)
  assert.equal(result.projects.length, 1)
  assert.equal(result.projects[0].name, 'good')
  assert.ok(result.warnings.some((w) => w.code === 'OUT_OF_ROOT'))
})

await testAsync('inspectRepo 无 package.json 时用目录名，git 失败也不抛异常', async () => {
  const root = fakeRoot('scan5')
  const dir = join(root, 'weird-repo')
  const deps = makeDeps({ root, children: [{ name: 'weird-repo', hasGit: true }], packages: {} })
  const rec = await inspectRepo(dir, root, deps)
  assert.equal(rec.name, 'weird-repo')
  assert.equal(rec.hasPackageJson, false)
  assert.equal(rec.branch, '')
  assert.equal(rec.dirtyCount, null)
  assert.equal(rec.lastCommit, null)
  assert.equal(rec.git.ok, false)
  assert.ok(rec.warnings.length > 0)
})

await testAsync('inspectRepo 空仓库（无提交）只当作提示', async () => {
  const root = fakeRoot('scan6')
  const dir = join(root, 'fresh')
  const deps = makeDeps({
    root,
    children: [{ name: 'fresh', hasGit: true }],
    packages: {},
    gitResults: {
      fresh: { branch: 'main\n', status: '' },
    },
  })
  const rec = await inspectRepo(dir, root, deps)
  assert.equal(rec.lastCommit, null)
  assert.equal(rec.dirtyCount, 0)
  assert.ok(rec.errors.some((e) => e.indexOf('git log') >= 0), '空仓库的 git log 失败应记录为错误字段')
  assert.ok(rec.warnings.some((w) => w.indexOf('package.json') >= 0), '缺 package.json 应给提示')
})

await testAsync('mapLimit 保持顺序且吞掉单个失败', async () => {
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    if (n === 3) throw new Error('boom')
    return n * 10
  })
  assert.deepEqual(out, [10, 20, null, 40, 50])
})

// ── 4. index.js 配置 / 输出白名单 ──────────────────────────────────────────
section('配置形状与输出字段')

test('normalizeConfigShape 过滤非法根目录、夹紧 maxProjects', () => {
  const root = fakeRoot('cfg')
  const norm = normalizeConfigShape({
    roots: [root, '', 'relative/x', root + '\\', 123],
    maxProjects: 99999,
  })
  assert.deepEqual(norm.roots, [resolve(root)])
  assert.equal(norm.maxProjects, 1000)
  assert.ok(norm.warnings.length >= 2)
})

test('normalizeConfigShape 非对象输入回退默认值', () => {
  const norm = normalizeConfigShape(null)
  assert.deepEqual(norm.roots, [DEFAULT_ROOT])
  assert.ok(norm.warnings.length >= 1)
})

test('DEFAULT_ROOT 是需求指定的目录', () => {
  assert.equal(DEFAULT_ROOT, 'D:\\Documents\\deepseek-harness\\default-workspace')
})

test('publicProject 只暴露白名单字段并保留中文/原始路径', () => {
  const out = publicProject({
    dir: 'D:\\ws\\a',
    root: 'D:\\ws',
    name: '甲',
    version: '1.0.0',
    description: '描述',
    branch: 'main',
    detached: false,
    dirtyCount: 0,
    lastCommit: { at: '2026-11-01T12:00:00+08:00', subject: 's' },
    remoteUrl: null,
    hasPackageJson: true,
    errors: [],
    warnings: ['内部字段'],
    packageJsonPath: 'D:\\ws\\a\\package.json',
    git: { ok: true },
  })
  assert.deepEqual(Object.keys(out).sort(), [
    'branch', 'description', 'detached', 'dir', 'dirtyCount', 'errors',
    'hasPackageJson', 'lastCommit', 'name', 'remoteUrl', 'root', 'version',
  ])
  assert.equal(out.warnings, undefined)
  assert.equal(out.git, undefined)
  assert.equal(out.remoteUrl, null)
})

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(58))
if (failures.length) {
  console.log('FAIL ' + passed + ' passed, ' + failures.length + ' failed')
  for (const f of failures) {
    console.log('\n' + f.name + '\n' + ((f.error && f.error.stack) || f.error))
  }
  process.exit(1)
}
console.log('PASS ' + passed + ' 项自检全部通过（离线、未执行 git、未联网）')
