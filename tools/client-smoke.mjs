/**
 * tools/client-smoke.mjs —— 客户端组件冒烟（不需要浏览器、不需要真 React）
 * ============================================================================
 * client.js 依赖 DSH 的 `window.__ModuleLoader__` 和真实 React。这里用最小替身：
 *
 *   · 假 window.__ModuleLoader__：捕获 load({ id, factory }) 的参数；
 *   · 假 React：只实现 createElement / Component（setState 同步合并）；
 *   · 假 fetch：按 URL 返回固定 JSON；
 *   · 假 slots：记录 inject / register 收到的定义；
 *
 * 然后真的调用 factory → apply → 取到 "开源项目" 一栏的渲染函数 →
 * 真的 new 出组件、跑 componentDidMount、跑 render，把元素树序列化成文本，
 * 断言真实文案出现在里面。这样能在没有 DSH GUI 的情况下验证这一栏能渲染。
 *
 *   node tools/client-smoke.mjs
 */

import assert from 'node:assert/strict'

const failures = []
let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push({ name, error: e })
    console.log('  FAIL ' + name + ' —— ' + (e && e.message))
  }
}

// ── 假 React ──────────────────────────────────────────────────────────────
function createElement(type, props, ...children) {
  const next = Object.assign({}, props)
  const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  if (kids !== undefined) next.children = kids
  return { type, props: next, key: props && props.key != null ? props.key : null }
}

class Component {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }

  setState(patch, cb) {
    this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch)
    if (typeof cb === 'function') cb()
  }
}

const fakeReact = { createElement, Component, Fragment: Symbol('Fragment') }

// ── 假 DOM / loader / fetch ───────────────────────────────────────────────
const styleNodes = []
let loaderArgs = null
globalThis.window = {
  __ModuleLoader__: {
    load(opts) {
      loaderArgs = opts
    },
  },
}
globalThis.document = {
  createElement() {
    const node = {
      attrs: {},
      textContent: '',
      parentNode: null,
      setAttribute(k, v) {
        node.attrs[k] = v
      },
      remove() {
        if (node.parentNode) node.parentNode.removeChild(node)
      },
    }
    return node
  },
}
const fakeHead = {
  appendChild(node) {
    node.parentNode = fakeHead
    styleNodes.push(node)
  },
  removeChild(node) {
    const i = styleNodes.indexOf(node)
    if (i >= 0) styleNodes.splice(i, 1)
    node.parentNode = null
  },
}
globalThis.document.head = fakeHead

const NOW = '2026-11-02T00:00:00+08:00'
const SAMPLE_PROJECTS = [
  {
    dir: 'D:\\ws\\alpha',
    root: 'D:\\ws',
    name: 'alpha',
    version: '1.2.3',
    description: '一句话描述',
    branch: 'main',
    detached: false,
    dirtyCount: 3,
    lastCommit: { at: '2026-11-01T12:00:00+08:00', subject: 'feat: 首提交' },
    remoteUrl: 'https://github.com/acme/alpha.git',
    hasPackageJson: true,
    errors: [],
  },
  {
    dir: 'D:\\ws\\beta',
    root: 'D:\\ws',
    name: '<b>beta</b>',
    version: '',
    description: '',
    branch: '',
    detached: true,
    dirtyCount: 0,
    lastCommit: null,
    remoteUrl: null,
    hasPackageJson: false,
    errors: ['分支读取失败：demo'],
  },
]

let mode = 'ok' // ok | empty | fail
const fetchCalls = []

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init })
  if (mode === 'fail') throw new Error('connect ECONNREFUSED 127.0.0.1')
  const u = String(url)
  let body
  if (u.includes('/projects')) {
    body = mode === 'empty' ? [] : SAMPLE_PROJECTS
  } else if (u.includes('/status')) {
    body = {
      ok: true,
      plugin: 'dsh-opensource-board',
      version: '0.1.0',
      generatedAt: NOW,
      count: mode === 'empty' ? 0 : SAMPLE_PROJECTS.length,
      roots: ['D:\\ws'],
      envOverride: false,
      configFile: 'C:\\Users\\x\\.dsh\\opensource-board\\config.json',
      warnings: mode === 'empty' ? [] : [{ code: 'ROOT_MISSING', error: '演示告警：目录不存在' }],
    }
  } else if (u.includes('/config')) {
    body = { ok: true, config: { roots: ['D:\\ws'], maxProjects: 200 }, envOverride: false, defaults: {} }
  } else {
    return { ok: false, status: 404, text: async () => 'not found' }
  }
  const text = JSON.stringify(body)
  return { ok: true, status: 200, text: async () => text }
}

// ── 加载 client.js ────────────────────────────────────────────────────────
await import('../client.js')

/** 把 createElement 产生的元素树序列化成纯文本（函数组件会被真正调用）。 */
function renderText(node, depth = 0) {
  if (node == null || node === false || node === true) return ''
  if (depth > 60) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((n) => renderText(n, depth + 1)).join(' ')
  if (typeof node !== 'object') return ''
  const { type, props } = node
  if (typeof type === 'string') return renderText(props && props.children, depth + 1)
  if (typeof type === 'function') {
    const isClass = type.prototype && typeof type.prototype.render === 'function'
    const el = isClass ? new type(props || {}) : type(props || {})
    const inner = isClass ? el.render() : el
    return renderText(inner, depth + 1)
  }
  return ''
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

console.log('\n[client-smoke] 组件冒烟（假 React + 假 fetch，不联网）\n')

await check('__ModuleLoader__.load 被调用且 id 正确', async () => {
  assert.ok(loaderArgs, 'client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(loaderArgs.id, 'dsh-opensource-board')
  assert.equal(typeof loaderArgs.factory, 'function')
})

const clientModule = loaderArgs.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error('客户端插件只允许 require("react")，出现了：' + id)
})

await check('factory 返回 { inject, apply }', async () => {
  assert.deepEqual(clientModule.inject, ['slots'])
  assert.equal(typeof clientModule.apply, 'function')
})

/** 假 slots：记录 inject / register 的参数，并拿到渲染函数。 */
function makeSlots() {
  const slots = {
    injected: [],
    defs: [],
    renders: [],
    inject(name, register) {
      slots.injected.push(name)
      register()
    },
    register(def, render) {
      slots.defs.push(def)
      slots.renders.push(render)
      return () => {}
    },
  }
  return slots
}

await check('apply 挂上 settings.section 一栏（id / order / label 正确）', async () => {
  const slots = makeSlots()
  const effects = []
  clientModule.apply({
    get: (key) => (key === 'slots' ? slots : undefined),
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
  })
  assert.deepEqual(slots.injected, ['settings.section'])
  assert.equal(slots.defs.length, 1)
  const def = slots.defs[0]
  assert.equal(def.name, 'settings.section')
  assert.equal(def.id, 'opensource-board')
  assert.equal(def.order, 56)
  assert.equal(def.label, '开源项目')
  assert.equal(typeof slots.renders[0], 'function')
  assert.ok(styleNodes.length >= 1, '应把样式注入 document.head')
  assert.ok(effects.some((e) => String(e.label).includes('dsh-opensource-board')), '应注册样式卸载 effect')
  // 卸载后样式应被移除
  for (const e of effects) e.dispose()
  assert.equal(styleNodes.length, 0, '卸载后样式节点应被移除')
  // 恢复样式，供后续渲染断言使用
  clientModule.apply({
    get: (key) => (key === 'slots' ? makeSlots() : undefined),
    effect: () => () => {},
  })
})

/** 取到真正的看板元素并实例化最外层组件类，供渲染断言。 */
async function mountBoard() {
  const slots = makeSlots()
  clientModule.apply({
    get: (key) => (key === 'slots' ? slots : undefined),
    effect: () => () => {},
  })
  const tree = slots.renders[0]()
  // 顶层是 Boundary（class）→ props.children 是看板元素
  const boundary = tree
  const boardEl = boundary.props.children
  assert.equal(typeof boardEl.type, 'function', '看板应是一个类组件')
  const board = new boardEl.type(boardEl.props)
  return board
}

await check('看板渲染出卡片：名称 / 版本 / 分支 / 改动数 / 提交 / 远程', async () => {
  mode = 'ok'
  const board = await mountBoard()
  board.componentDidMount()
  await flush()
  const text = renderText(board.render())
  assert.ok(text.includes('开源项目'), '缺少标题')
  assert.ok(text.includes('alpha'), '缺少项目名')
  assert.ok(text.includes('v1.2.3'), '缺少版本')
  assert.ok(text.includes('一句话描述'), '缺少描述')
  assert.ok(text.includes('main'), '缺少分支')
  assert.ok(text.includes('3 项改动'), '缺少未提交改动数')
  assert.ok(text.includes('feat: 首提交'), '缺少最近提交标题')
  assert.ok(text.includes('2026-11-01'), '缺少提交时间')
  assert.ok(text.includes('https://github.com/acme/alpha.git'), '缺少远程地址')
  assert.ok(text.includes('分离 HEAD'), '分离 HEAD 应有标注')
  assert.ok(text.includes('演示告警：目录不存在'), '扫描告警应展示')
})

await check('仓库内容按文本节点渲染，不会被当成 HTML/元素', async () => {
  mode = 'ok'
  const board = await mountBoard()
  board.componentDidMount()
  await flush()
  const tree = board.render()
  // 找 <b>beta</b>：必须作为字符串出现，而不是 type='b' 的元素
  const json = JSON.stringify(tree, (k, v) => v)
  assert.ok(json.includes('"<b>beta</b>"'), '项目名必须作为字符串文本节点')
  assert.ok(!json.includes('"type":"b"'), '不能出现 type=b 的元素（即不能被解析成标签）')
})

await check('空目录 → 显示空状态提示', async () => {
  mode = 'empty'
  const board = await mountBoard()
  board.componentDidMount()
  await flush()
  const text = renderText(board.render())
  assert.ok(text.includes('还没有发现项目'), '空状态文案缺失')
  assert.ok(text.includes('扫描根目录'), '空状态应引导配置根目录')
})

await check('接口失败 → 显示失败提示 + 重试按钮', async () => {
  mode = 'fail'
  const board = await mountBoard()
  board.componentDidMount()
  await flush()
  const text = renderText(board.render())
  assert.ok(text.includes('看板加载失败'), '失败标题缺失')
  assert.ok(text.includes('ECONNREFUSED'), '应显示具体错误信息')
  assert.ok(text.includes('重试'), '缺少重试按钮')
})

await check('请求走同源 API 路由', async () => {
  mode = 'ok'
  fetchCalls.length = 0
  const board = await mountBoard()
  board.componentDidMount()
  await flush()
  const urls = fetchCalls.map((c) => c.url)
  assert.ok(urls.some((u) => u.startsWith('/api/dsh-opensource-board/projects')), '缺少 projects 请求')
  assert.ok(urls.some((u) => u.startsWith('/api/dsh-opensource-board/status')), '缺少 status 请求')
  assert.ok(urls.some((u) => u.startsWith('/api/dsh-opensource-board/config')), '缺少 config 请求')
})

await check('主路由 404 时自动退回别名路由', async () => {
  const realFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push(String(url))
    // 只把「/api/...」主路由打成 404，别名路由放行
    if (String(url).startsWith('/api/')) return { ok: false, status: 404, text: async () => '' }
    return realFetch(url, init)
  }
  try {
    mode = 'ok'
    const board = await mountBoard()
    board.componentDidMount()
    await flush()
    assert.ok(seen.some((u) => u.startsWith('/dsh-opensource-board/projects')), '应回退到别名字路由')
    const text = renderText(board.render())
    assert.ok(text.includes('alpha'), '回退后仍应渲染出项目')
  } finally {
    globalThis.fetch = realFetch
  }
})

console.log('\n' + '─'.repeat(58))
if (failures.length) {
  console.log('FAIL ' + passed + ' passed, ' + failures.length + ' failed')
  for (const f of failures) console.log('\n' + f.name + '\n' + ((f.error && f.error.stack) || f.error))
  process.exit(1)
}
console.log('PASS ' + passed + ' 项客户端冒烟通过（未联网、未使用真实 React）')
