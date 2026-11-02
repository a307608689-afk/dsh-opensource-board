/**
 * tools/smoke.mjs —— 端到端冒烟：真的起一个 HTTP 服务，真的请求接口
 * ============================================================================
 * 不依赖 DSH 宿主：伪造一个最小的 ctx / webServer（只实现 register），
 * 把插件注册的 handler 挂到 127.0.0.1 的临时端口上，然后用 fetch 真跑一遍：
 *
 *   GET  /api/dsh-opensource-board/projects   → JSON 数组（真实 git 数据）
 *   GET  /api/dsh-opensource-board/status     → 状态与告警
 *   GET  /api/dsh-opensource-board/config     → 当前配置
 *   POST /api/dsh-opensource-board/config     → 非法根目录必须被拒
 *   GET  /api/dsh-opensource-board/export.html→ HTML 报表（含转义）
 *   GET  /dsh-opensource-board/projects       → 别名路由也通
 *
 * 配置指向临时文件，不会改动用户真实的 ~/.dsh/opensource-board/config.json。
 *
 *   node tools/smoke.mjs            # 打印 PASS + 真实 JSON 样例
 */

import http from 'node:http'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, '.tmp')
const TMP_CONFIG = join(OUT_DIR, 'smoke-config.json')

await fsp.mkdir(OUT_DIR, { recursive: true })
await fsp.unlink(TMP_CONFIG).catch(() => {})

// 让插件读临时配置，避免碰用户的真实配置
process.env.DSH_OPENSOURCE_BOARD_CONFIG = TMP_CONFIG
delete process.env.DSH_OPENSOURCE_BOARD_ROOTS

// 默认扫描根指向本仓库所在的工作区（真实存在 git 仓库），不依赖任何机器特定路径
if (!process.env.DSH_BOARD_ROOT) process.env.DSH_BOARD_ROOT = join(HERE, '..', '..')

const { apply, DEFAULT_ROOT } = await import('../index.js')

const routes = new Map()
const disposers = []
const webServer = {
  register({ kind, path, handler }) {
    assert.equal(kind, 'exact', '宿主 API 只见过 kind=exact')
    routes.set(path, handler)
    return () => routes.delete(path)
  },
}
const ctx = {
  get(key) {
    if (key === 'webServer') return webServer
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}

apply(ctx)

assert.ok(routes.size > 0, 'apply() 必须注册路由')
assert.ok(routes.has('/api/dsh-opensource-board/projects'), '主路由 /api/... 必须存在')
assert.ok(routes.has('/dsh-opensource-board/projects'), '别名路由必须存在')

const server = http.createServer(async (req, res) => {
  let pathname = '/'
  try {
    pathname = new URL(req.url, 'http://127.0.0.1').pathname
  } catch {
    pathname = '/'
  }
  const handler = routes.get(pathname)
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'no route' }))
    return
  }
  try {
    await handler(req, res)
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    } else {
      res.end()
    }
  }
})

const listening = new Promise((resolvePromise, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port))
})
const port = await listening
const base = 'http://127.0.0.1:' + port
const API = base + '/api/dsh-opensource-board'

async function getJson(path, init) {
  const res = await fetch(API + path, init)
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { res, text, body }
}

const started = Date.now()
const failures = []
async function check(name, fn) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push({ name, error: e })
    console.log('  FAIL ' + name + ' —— ' + (e && e.message))
  }
}

console.log('\n[smoke] 服务已监听 ' + base + '（临时配置 ' + TMP_CONFIG + '）\n')

// ── /projects ──────────────────────────────────────────────────────────────
let projects = []
await check('GET /projects 返回 JSON 数组', async () => {
  const { res, body } = await getJson('/projects?refresh=1')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /application\/json/)
  assert.ok(Array.isArray(body), '顶层必须是数组')
  projects = body
})
const projectsMs = Date.now() - started

await check('每条记录字段齐全且类型正确', async () => {
  for (const p of projects) {
    assert.equal(typeof p.dir, 'string')
    assert.equal(typeof p.root, 'string')
    assert.equal(typeof p.name, 'string')
    assert.equal(typeof p.version, 'string')
    assert.equal(typeof p.description, 'string')
    assert.equal(typeof p.branch, 'string')
    assert.equal(typeof p.detached, 'boolean')
    assert.ok(p.dirtyCount === null || typeof p.dirtyCount === 'number')
    assert.ok(p.lastCommit === null || (typeof p.lastCommit.at === 'string' && typeof p.lastCommit.subject === 'string'))
    assert.ok(p.remoteUrl === null || typeof p.remoteUrl === 'string')
    assert.equal(typeof p.hasPackageJson, 'boolean')
    assert.ok(Array.isArray(p.errors))
  }
})

await check('未出现内部字段泄漏（git / warnings / packageJsonPath）', async () => {
  for (const p of projects) {
    assert.equal(p.git, undefined)
    assert.equal(p.warnings, undefined)
    assert.equal(p.packageJsonPath, undefined)
  }
})

await check('所有项目路径都在扫描根目录内', async () => {
  const { pathInside } = await import('../lib/path-safety.mjs')
  for (const p of projects) {
    assert.ok(pathInside(p.root, p.dir), '越界记录：' + p.dir)
  }
})

await check('真实仓库的 git 读取成功（分支/未提交/最近提交都有值）', async () => {
  assert.ok(projects.length >= 1, '默认根目录下应至少有一个 git 仓库')
  for (const p of projects) {
    assert.deepEqual(p.errors, [], p.name + ' 的 git 调用报错：' + JSON.stringify(p.errors))
    assert.ok(p.branch, p.name + ' 缺分支')
    assert.equal(typeof p.dirtyCount, 'number')
    assert.ok(p.lastCommit && p.lastCommit.at && p.lastCommit.subject, p.name + ' 缺最近提交')
  }
})

// ── /status ────────────────────────────────────────────────────────────────
await check('GET /status 结构与计数一致', async () => {
  const { res, body } = await getJson('/status')
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-opensource-board')
  assert.equal(body.count, projects.length)
  assert.ok(Array.isArray(body.roots))
  assert.ok(Array.isArray(body.warnings))
  assert.ok(body.roots.length >= 1)
})

// ── /config ────────────────────────────────────────────────────────────────
await check('GET /config 返回默认根目录', async () => {
  const { res, body } = await getJson('/config')
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.config.roots, [DEFAULT_ROOT])
  assert.equal(body.envOverride, false)
  assert.equal(body.configFile, TMP_CONFIG)
})

await check('POST /config 拒绝相对路径', async () => {
  const res = await fetch(API + '/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: ['relative/dir'] }),
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'BAD_CONFIG')
})

await check('POST /config 拒绝 JSON 非数组', async () => {
  const res = await fetch(API + '/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: 'C:\\x' }),
  })
  assert.equal(res.status, 400)
})

await check('POST /config 接受合法根目录并写盘', async () => {
  const res = await fetch(API + '/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: [DEFAULT_ROOT, 'relative/x'], maxProjects: 50 }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.config.roots, [DEFAULT_ROOT])
  assert.equal(body.config.maxProjects, 50)
  assert.equal(body.rejected.length, 1)
  const saved = JSON.parse(await fsp.readFile(TMP_CONFIG, 'utf8'))
  assert.deepEqual(saved.roots, [DEFAULT_ROOT])
  assert.equal(saved.maxProjects, 50)
})

await check('GET 方法校验（POST 到 /projects 必须 405）', async () => {
  const res = await fetch(API + '/projects', { method: 'POST', body: '{}' })
  assert.equal(res.status, 405)
})

// ── /export.html ───────────────────────────────────────────────────────────
await check('GET /export.html 返回转义后的 HTML', async () => {
  const res = await fetch(API + '/export.html?refresh=1')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/html/)
  assert.ok((res.headers.get('content-security-policy') || '').includes("default-src 'none'"))
  const html = await res.text()
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('开源项目看板'))
  assert.ok(!/<script/i.test(html), '导出的 HTML 里不能有 <script>')
})

// ── 别名路由 ───────────────────────────────────────────────────────────────
await check('别名路由 /dsh-opensource-board/projects 同样可用', async () => {
  const res = await fetch(base + '/dsh-opensource-board/projects')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body))
  assert.equal(body.length, projects.length)
})

// ── 关闭并汇总 ─────────────────────────────────────────────────────────────
await new Promise((r) => server.close(r))
for (const dispose of disposers) dispose()

const sample = projects.slice(0, 3)
console.log('\n[smoke] projects 共 ' + projects.length + ' 条，'
  + '首次响应耗时约 ' + projectsMs + 'ms（含真实 git 调用）\n')
console.log('── GET /api/dsh-opensource-board/projects 真实输出（前 ' + sample.length + ' 条）──')
console.log(JSON.stringify(sample, null, 2))

await fsp.writeFile(join(OUT_DIR, 'smoke-projects.json'), JSON.stringify(projects, null, 2) + '\n', 'utf8')
console.log('\n[smoke] 完整输出已写入 ' + join(OUT_DIR, 'smoke-projects.json'))

console.log('\n' + '─'.repeat(58))
if (failures.length) {
  console.log('FAIL ' + (failures.length) + ' 项冒烟检查未通过')
  for (const f of failures) console.log('\n' + f.name + '\n' + ((f.error && f.error.stack) || f.error))
  process.exit(1)
}
console.log('PASS 冒烟检查全部通过（真实 HTTP + 真实 git，未联网）')
