/**
 * dsh-opensource-board —— 浏览器端入口
 * ============================================================================
 * 在 DSH 设置页新增一栏「开源项目」：卡片列表 + 刷新 + 空状态 + 失败提示。
 *
 * DSH 客户端插件 API 依据（读自本机已上线插件，未凭空捏造）：
 *   · 入口形状：window.__ModuleLoader__.load({ id, factory: (require) => {...} })
 *     返回 { inject: ['slots'], apply(ctx) } —— 见 dsh-session-trash/client.js；
 *   · 挂一栏：slots.inject('settings.section', () => slots.register(
 *       { name:'settings.section', id, order, label }, () => 组件))；
 *   · 只能 require('react')，CSS 由插件自己 append 到 document.head，
 *     用 ctx.effect(...) 注册卸载清理。
 *
 * 数据全部走同源 HTTP（与宿主同一端口），不外部请求、不写 localStorage 里的凭据。
 * 文本一律作为 React 文本节点渲染（不拼 innerHTML），因此不会被仓库里的内容注入。
 */

window.__ModuleLoader__.load({
  id: 'dsh-opensource-board',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/dsh-opensource-board'
    // 兜底路由：如果宿主占用了 /api 命名空间，服务端同时注册了不带前缀的别名
    const ALIAS_API = '/dsh-opensource-board'
    const SECTION_ID = 'opensource-board'
    const SECTION_LABEL = '开源项目'
    const SECTION_ORDER = 56

    // @css-begin
    const CSS = `
/* dsh-opensource-board —— 设置页「开源项目」样式
 * 只作用于 .dsh-ob 作用域内，不污染 DSH 其他界面。
 * 颜色全部基于 currentColor / 半透明灰，浅色与深色主题都能用。
 */

.dsh-ob {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0 24px;
  font-size: 13px;
  line-height: 1.55;
  min-width: 0;
}

/* ── 顶部工具条 ───────────────────────────────────────────── */
.dsh-ob__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.dsh-ob__bar-title {
  font-size: 14px;
  font-weight: 600;
  margin-right: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dsh-ob__count {
  font-weight: 400;
  font-size: 12px;
  opacity: 0.6;
}

.dsh-ob__btn {
  appearance: none;
  border: 1px solid rgba(127, 127, 127, 0.32);
  background: rgba(127, 127, 127, 0.06);
  color: inherit;
  border-radius: 7px;
  padding: 5px 12px;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.dsh-ob__btn:hover:not(:disabled) {
  background: rgba(127, 127, 127, 0.14);
}

.dsh-ob__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.dsh-ob__btn--primary {
  border-color: rgba(64, 132, 255, 0.55);
  background: rgba(64, 132, 255, 0.12);
  color: inherit;
  font-weight: 600;
}

.dsh-ob__btn--primary:hover:not(:disabled) {
  background: rgba(64, 132, 255, 0.2);
}

.dsh-ob__meta {
  font-size: 12px;
  opacity: 0.62;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.dsh-ob__meta code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.12);
  word-break: break-all;
}

/* ── 提示块 ───────────────────────────────────────────────── */
.dsh-ob__notice {
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 12px;
  border: 1px solid transparent;
}

.dsh-ob__notice--error {
  background: rgba(214, 58, 58, 0.1);
  border-color: rgba(214, 58, 58, 0.35);
}

.dsh-ob__notice--warn {
  background: rgba(200, 140, 0, 0.1);
  border-color: rgba(200, 140, 0, 0.32);
}

.dsh-ob__notice-title {
  font-weight: 600;
  margin-bottom: 2px;
}

.dsh-ob__notice ul {
  margin: 4px 0 0 18px;
  padding: 0;
}

.dsh-ob__notice li {
  word-break: break-word;
}

/* ── 卡片网格 ─────────────────────────────────────────────── */
.dsh-ob__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}

.dsh-ob__card {
  border: 1px solid rgba(127, 127, 127, 0.26);
  border-radius: 10px;
  padding: 11px 12px;
  background: rgba(127, 127, 127, 0.04);
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.dsh-ob__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.dsh-ob__name {
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-ob__ver {
  flex: none;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid rgba(127, 127, 127, 0.32);
  opacity: 0.85;
}

.dsh-ob__desc {
  font-size: 12px;
  opacity: 0.75;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.dsh-ob__path {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  opacity: 0.5;
  word-break: break-all;
}

.dsh-ob__rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  font-size: 12px;
  margin-top: 2px;
}

.dsh-ob__k {
  opacity: 0.55;
  white-space: nowrap;
}

.dsh-ob__v {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-ob__v--wrap {
  white-space: normal;
  word-break: break-all;
}

.dsh-ob__badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 11px;
  border: 1px solid transparent;
}

.dsh-ob__badge--clean {
  background: rgba(46, 160, 88, 0.14);
  border-color: rgba(46, 160, 88, 0.36);
}

.dsh-ob__badge--dirty {
  background: rgba(200, 140, 0, 0.16);
  border-color: rgba(200, 140, 0, 0.4);
}

.dsh-ob__badge--unknown {
  background: rgba(127, 127, 127, 0.14);
  border-color: rgba(127, 127, 127, 0.3);
}

/* ── 空状态 / 加载 ────────────────────────────────────────── */
.dsh-ob__empty {
  border: 1px dashed rgba(127, 127, 127, 0.38);
  border-radius: 10px;
  padding: 26px 16px;
  text-align: center;
  font-size: 12.5px;
  opacity: 0.85;
}

.dsh-ob__empty strong {
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
  opacity: 1;
}

.dsh-ob__empty code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.14);
}

.dsh-ob__loading {
  font-size: 12px;
  opacity: 0.6;
  padding: 6px 0;
}

/* ── 扫描根目录编辑 ───────────────────────────────────────── */
.dsh-ob__roots {
  border: 1px solid rgba(127, 127, 127, 0.26);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dsh-ob__roots-head {
  font-size: 12.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dsh-ob__roots-hint {
  font-weight: 400;
  font-size: 11.5px;
  opacity: 0.6;
}

.dsh-ob__root-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.dsh-ob__input {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px solid rgba(127, 127, 127, 0.32);
  background: rgba(127, 127, 127, 0.06);
  color: inherit;
}

.dsh-ob__input:focus {
  outline: none;
  border-color: rgba(64, 132, 255, 0.6);
}

.dsh-ob__input:disabled {
  opacity: 0.6;
}

/* ── 只看我的 / 同步状态 / 最近提交 / 自检结果 ───────────────── */
.dsh-ob__filter {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
}

.dsh-ob__filter input {
  margin: 0;
  cursor: pointer;
}

.dsh-ob__sync {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid rgba(127, 127, 127, 0.32);
  white-space: nowrap;
}

.dsh-ob__sync--synced { border-color: rgba(52, 168, 83, 0.55); }
.dsh-ob__sync--ahead { border-color: rgba(64, 132, 255, 0.55); }
.dsh-ob__sync--behind { border-color: rgba(234, 134, 0, 0.55); }
.dsh-ob__sync--diverged { border-color: rgba(217, 72, 72, 0.55); }
.dsh-ob__sync--unknown,
.dsh-ob__sync--no-remote { opacity: 0.65; }

.dsh-ob__tag {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(127, 127, 127, 0.12);
}

.dsh-ob__commits-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.dsh-ob__commits {
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.dsh-ob__commit {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 11.5px;
  opacity: 0.85;
  min-width: 0;
}

.dsh-ob__commit-when,
.dsh-ob__commit-hash {
  flex: none;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  opacity: 0.7;
}

.dsh-ob__commit-subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-ob__report {
  border: 1px solid rgba(127, 127, 127, 0.26);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dsh-ob__report-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  font-weight: 600;
}

.dsh-ob__report-head .dsh-ob__btn {
  margin-left: auto;
}

.dsh-ob__report-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  min-width: 0;
}

.dsh-ob__report-verdict--block { color: #d94848; font-weight: 600; }
.dsh-ob__report-verdict--ok { color: #34a853; font-weight: 600; }

.dsh-ob__finding {
  font-size: 11.5px;
  opacity: 0.88;
  padding-left: 10px;
  border-left: 2px solid rgba(127, 127, 127, 0.28);
  margin-top: 3px;
  word-break: break-word;
}

.dsh-ob__finding--block { border-left-color: rgba(217, 72, 72, 0.75); }
.dsh-ob__finding--warn { border-left-color: rgba(234, 134, 0, 0.75); }


`
// @css-end

    let cssEl = null

    function installCss() {
      if (cssEl || typeof document === 'undefined') return
      cssEl = document.createElement('style')
      cssEl.setAttribute('data-plugin-css', 'dsh-opensource-board')
      cssEl.textContent = CSS
      document.head.appendChild(cssEl)
    }

    function removeCss() {
      if (cssEl && cssEl.parentNode) cssEl.parentNode.removeChild(cssEl)
      cssEl = null
    }

    /** 同源请求：优先走无 /api 前缀的别名路由；宿主对 /api/* 可能返回 401（保留命名空间），
     *  401/404 时再退回 /api 前缀。 */
    async function request(path, init) {
      const options = Object.assign({}, init)
      options.headers = Object.assign({ accept: 'application/json' }, (init && init.headers) || {})
      let res = await fetch(ALIAS_API + path, options)
      if (res.status === 404 || res.status === 401) {
        res = await fetch(API + path, options)
      }
      const text = await res.text()
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = null
        }
      }
      if (!res.ok) {
        const msg = (data && data.error) || 'HTTP ' + res.status
        const err = new Error(msg)
        err.code = (data && data.code) || 'HTTP_' + res.status
        throw err
      }
      return data
    }

    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    /** ISO → 本地 `YYYY-MM-DD HH:mm`，解析不了就原样显示。 */
    function formatWhen(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (!Number.isFinite(d.getTime())) return String(iso)
      return (
        d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
      )
    }

    function dirtyBadge(count) {
      if (typeof count !== 'number') {
        return h('span', { className: 'dsh-ob__badge dsh-ob__badge--unknown' }, '未知')
      }
      if (count === 0) return h('span', { className: 'dsh-ob__badge dsh-ob__badge--clean' }, '干净')
      return h('span', { className: 'dsh-ob__badge dsh-ob__badge--dirty' }, count + ' 项改动')
    }

    /** 同步状态只认这几个值，其余一律按 unknown 渲染（防止后端异常值进 className）。 */
    const SYNC_STATES = ['synced', 'ahead', 'behind', 'diverged', 'no-remote', 'unknown']
    const SYNC_LABEL = {
      synced: '已同步',
      ahead: '有未推送',
      behind: '落后远程',
      diverged: '已分叉',
      'no-remote': '无远程',
      unknown: '同步未知',
    }

    function syncBadge(p) {
      const raw = p && typeof p.syncState === 'string' ? p.syncState : 'unknown'
      const state = SYNC_STATES.indexOf(raw) >= 0 ? raw : 'unknown'
      const ahead = p && typeof p.ahead === 'number' ? p.ahead : null
      const behind = p && typeof p.behind === 'number' ? p.behind : null
      let text = SYNC_LABEL[state]
      if (state === 'ahead' && ahead !== null) text = '有 ' + ahead + ' 个未推送'
      else if (state === 'behind' && behind !== null) text = '落后 ' + behind + ' 个提交'
      else if (state === 'diverged') {
        text = '分叉（领先 ' + (ahead === null ? '?' : ahead) + ' / 落后 ' + (behind === null ? '?' : behind) + '）'
      }
      return h('span', { className: 'dsh-ob__sync dsh-ob__sync--' + state }, text)
    }

    function verdictBadge(verdict) {
      if (verdict === 'block') return h('span', { className: 'dsh-ob__report-verdict--block' }, '阻断')
      if (verdict === 'warn') return h('span', null, '有警告')
      return h('span', { className: 'dsh-ob__report-verdict--ok' }, '通过')
    }

    /** 自检报告里「一个项目」的明细（findings 逐条列，最多 20 条防刷屏）。 */
    function ReportProject(props) {
      const p = props.project || {}
      const findings = Array.isArray(p.findings) ? p.findings : []
      const s = p.summary && typeof p.summary === 'object' ? p.summary : {}
      const num = (v) => (typeof v === 'number' ? v : 0)
      return h(
        'div',
        { className: 'dsh-ob__report-row', style: { flexDirection: 'column', alignItems: 'stretch' } },
        h(
          'div',
          { className: 'dsh-ob__report-row', style: { alignItems: 'baseline' } },
          h('span', null, p.name || p.dir || '（未命名）'),
          p.version ? h('span', { className: 'dsh-ob__tag' }, 'v' + p.version) : null,
          verdictBadge(p.verdict),
          h('span', { className: 'dsh-ob__meta' }, '阻断 ' + num(s.block) + ' / 警告 ' + num(s.warn)),
        ),
        findings.length
          ? h(
              'div',
              null,
              findings.slice(0, 20).map((f, i) =>
                h(
                  'div',
                  {
                    className:
                      'dsh-ob__finding dsh-ob__finding--' +
                      (f && f.level === 'block' ? 'block' : f && f.level === 'warn' ? 'warn' : 'info'),
                    key: 'f-' + i,
                  },
                  (f && f.file ? String(f.file) : '') +
                    (f && f.line ? ':' + f.line : '') +
                    ' · ' +
                    (f && f.message ? String(f.message) : '') +
                    (f && f.suggestion ? '（建议：' + f.suggestion + '）' : ''),
                ),
              ),
            )
          : null,
      )
    }

    /** 设置页顶部的「上次自检」面板：没有报告时给出明确的下一步提示，而不是空白。 */
    function ReportPanel(props) {
      const r = props.report
      const warning = props.warning || ''
      if (!r) {
        return h(
          'div',
          { className: 'dsh-ob__report' },
          h('div', { className: 'dsh-ob__report-head' }, '上次自检'),
          h(
            'div',
            { className: 'dsh-ob__meta' },
            warning ? '读取失败：' + warning : '还没有自检记录，在对话里让我跑一次',
          ),
        )
      }
      const totals = r.totals && typeof r.totals === 'object' ? r.totals : {}
      const projects = Array.isArray(r.projects) ? r.projects : []
      const num = (v) => (typeof v === 'number' ? v : 0)
      const open = !!props.expanded
      return h(
        'div',
        { className: 'dsh-ob__report' },
        h(
          'div',
          { className: 'dsh-ob__report-head' },
          '上次自检',
          h(
            'span',
            { className: 'dsh-ob__meta' },
            (r.generatedAt ? formatWhen(r.generatedAt) : '时间未知') +
              ' · ' + num(totals.block) + ' 阻断 / ' + num(totals.warn) + ' 警告',
          ),
          h(
            'button',
            { className: 'dsh-ob__btn', type: 'button', onClick: props.onToggle },
            open ? '收起明细' : '查看明细',
          ),
        ),
        open && projects.length
          ? h(
              'div',
              null,
              projects.map((p, i) => h(ReportProject, { key: 'rp-' + i, project: p })),
            )
          : null,
        open && !projects.length ? h('div', { className: 'dsh-ob__meta' }, '报告里没有项目记录') : null,
      )
    }

    /** 卡片里的一行「键 → 值」，返回两个兄弟节点（键、值），由父级 div 承接。 */
    function metaRow(label, value, opts) {
      const o = opts || {}
      return [
        h('div', { className: 'dsh-ob__k', key: 'k' }, label),
        h('div', {
          className: 'dsh-ob__v' + (o.wrap ? ' dsh-ob__v--wrap' : ''),
          key: 'v',
          title: o.title == null ? undefined : o.title,
        }, value),
      ]
    }

    function ProjectCard(props) {
      const p = props.project
      const branch = p.branch ? p.branch + (p.detached ? '（分离 HEAD）' : '') : p.detached ? '（分离 HEAD）' : '—'
      const last = p.lastCommit
      const commits = Array.isArray(p.recentCommits) ? p.recentCommits : []
      const isOpen = !!props.expanded
      return h(
        'div',
        { className: 'dsh-ob__card' },
        h(
          'div',
          { className: 'dsh-ob__head' },
          h('div', { className: 'dsh-ob__name', title: p.name }, p.name || p.dir),
          p.version ? h('span', { className: 'dsh-ob__ver' }, 'v' + p.version) : null,
          syncBadge(p),
          p.mine === false ? h('span', { className: 'dsh-ob__sync dsh-ob__sync--no-remote' }, '非本人仓库') : null,
        ),
        p.description ? h('div', { className: 'dsh-ob__desc', title: p.description }, p.description) : null,
        h('div', { className: 'dsh-ob__path', title: p.dir }, p.dir),
        h(
          'div',
          { className: 'dsh-ob__rows' },
          metaRow('分支', branch, { title: branch }),
          metaRow('最新 tag', p.latestTag || '—', { title: p.latestTag || '' }),
          metaRow('未提交', dirtyBadge(p.dirtyCount)),
          metaRow('最近提交', last ? formatWhen(last.at) : '—', { title: last ? formatWhen(last.at) : '' }),
          metaRow('提交标题', last && last.subject ? last.subject : '—', {
            wrap: true,
            title: last && last.subject ? last.subject : '',
          }),
          metaRow('远程仓库', p.remoteUrl || '—', { wrap: true, title: p.remoteUrl || '' }),
        ),
        commits.length
          ? h(
              'div',
              { className: 'dsh-ob__commits-wrap' },
              h(
                'button',
                {
                  className: 'dsh-ob__btn',
                  type: 'button',
                  onClick: () => props.onToggleExpand && props.onToggleExpand(p.dir),
                },
                isOpen ? '收起最近提交' : '展开最近 ' + commits.length + ' 条提交',
              ),
              isOpen
                ? h(
                    'ul',
                    { className: 'dsh-ob__commits' },
                    commits.map((c, i) =>
                      h(
                        'li',
                        { className: 'dsh-ob__commit', key: 'c-' + i + '-' + (c.hash || '') },
                        h('span', { className: 'dsh-ob__commit-when' }, formatWhen(c.at)),
                        h('span', { className: 'dsh-ob__commit-hash' }, c.hash || ''),
                        h('span', { className: 'dsh-ob__commit-subject', title: c.subject || '' }, c.subject || ''),
                      ),
                    ),
                  )
                : null,
            )
          : null,
        Array.isArray(p.errors) && p.errors.length
          ? h('div', { className: 'dsh-ob__notice dsh-ob__notice--warn' }, p.errors.join('；'))
          : null,
      )
    }

    function Notice(props) {
      return h(
        'div',
        { className: 'dsh-ob__notice dsh-ob__notice--' + (props.kind || 'error') },
        props.title ? h('div', { className: 'dsh-ob__notice-title' }, props.title) : null,
        props.children,
      )
    }

    function RootsEditor(props) {
      const disabled = !!props.disabled
      const draft = props.draft
      return h(
        'div',
        { className: 'dsh-ob__roots' },
        h(
          'div',
          { className: 'dsh-ob__roots-head' },
          '扫描根目录',
          h(
            'span',
            { className: 'dsh-ob__roots-hint' },
            disabled
              ? '已被环境变量 DSH_OPENSOURCE_BOARD_ROOTS 锁定，界面不可改'
              : '只扫描这些目录下「直接子目录里含 .git」的项目，不会越出根目录',
          ),
        ),
        draft.map((value, index) =>
          h(
            'div',
            { className: 'dsh-ob__root-row', key: 'root-' + index },
            h('input', {
              className: 'dsh-ob__input',
              type: 'text',
              spellCheck: false,
              disabled: disabled,
              value: value,
              placeholder: 'D:\\path\\to\\workspace',
              onChange: (e) => props.onChange(index, e.target.value),
            }),
            h(
              'button',
              {
                className: 'dsh-ob__btn',
                type: 'button',
                disabled: disabled,
                onClick: () => props.onRemove(index),
              },
              '移除',
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsh-ob__root-row' },
          h(
            'button',
            {
              className: 'dsh-ob__btn',
              type: 'button',
              disabled: disabled,
              onClick: props.onAdd,
            },
            '＋ 添加根目录',
          ),
          h(
            'button',
            {
              className: 'dsh-ob__btn dsh-ob__btn--primary',
              type: 'button',
              disabled: disabled || props.saving,
              onClick: props.onSave,
            },
            props.saving ? '保存中…' : '保存并重新扫描',
          ),
          h(
            'button',
            {
              className: 'dsh-ob__btn',
              type: 'button',
              disabled: disabled || props.saving || !props.dirty,
              onClick: props.onReset,
            },
            '还原',
          ),
        ),
        props.error
          ? h(Notice, { kind: 'error', title: '根目录保存失败' }, props.error)
          : null,
        props.savedAt
          ? h('div', { className: 'dsh-ob__meta' }, '已保存并重新扫描：' + props.savedAt)
          : null,
      )
    }

    class OpenSourceBoard extends React.Component {
      constructor(props) {
        super(props)
        this.state = {
          loading: true,
          projects: [],
          status: null,
          config: null,
          draft: [],
          savedDraft: [],
          saving: false,
          saveError: '',
          savedAt: '',
          error: '',
          // 默认只看自己上传的仓库；关掉后显示全部并保留 mine 标记
          onlyMine: true,
          report: null,
          reportWarning: '',
          reportOpen: false,
          expanded: {},
        }
        this.load = this.load.bind(this)
        this.onSave = this.onSave.bind(this)
        this.onToggleOnlyMine = this.onToggleOnlyMine.bind(this)
        this.onToggleExpand = this.onToggleExpand.bind(this)
      }

      componentDidMount() {
        this.load(false)
      }

      componentWillUnmount() {
        this.unmounted = true
      }

      async load(force) {
        this.setState({ loading: true, error: '' })
        try {
          const params = []
          if (force) params.push('refresh=1')
          if (this.state.onlyMine) params.push('onlyMine=1')
          const qs = params.length ? '?' + params.join('&') : ''
          const refreshQs = force ? '?refresh=1' : ''
          const [projects, status, config, report] = await Promise.all([
            request('/projects' + qs),
            request('/status' + refreshQs),
            request('/config'),
            // 自检报告读不到不影响主看板（「还没跑过自检」是正常状态）
            request('/reports/latest').catch(() => null),
          ])
          if (this.unmounted) return
          const roots = config && config.config && Array.isArray(config.config.roots) ? config.config.roots : []
          this.setState({
            loading: false,
            projects: Array.isArray(projects) ? projects : [],
            status: status || null,
            config: config || null,
            report: report && report.data ? report.data : null,
            reportWarning: report && typeof report.warning === 'string' ? report.warning : '',
            draft: roots.slice(),
            savedDraft: roots.slice(),
            error: '',
          })
        } catch (e) {
          if (this.unmounted) return
          this.setState({
            loading: false,
            error: (e && e.message) || '加载失败',
          })
        }
      }

      /** 切换「只看我的」：按新的过滤条件重新请求。 */
      onToggleOnlyMine(next) {
        const onlyMine = !!next
        if (onlyMine === this.state.onlyMine) return
        this.setState({ onlyMine, expanded: {} }, () => this.load(true))
      }

      /** 展开 / 收起某个项目的「最近提交」。 */
      onToggleExpand(dir) {
        const key = String(dir || '')
        if (!key) return
        const expanded = Object.assign({}, this.state.expanded)
        expanded[key] = !expanded[key]
        this.setState({ expanded })
      }

      async onSave() {
        this.setState({ saving: true, saveError: '' })
        try {
          const payload = { roots: this.state.draft.map((s) => String(s).trim()).filter(Boolean) }
          const result = await request('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (this.unmounted) return
          const roots = result && result.config && Array.isArray(result.config.roots) ? result.config.roots : []
          this.setState({
            saving: false,
            draft: roots.slice(),
            savedDraft: roots.slice(),
            savedAt: new Date().toLocaleTimeString(),
            saveError: '',
          })
          this.load(true)
        } catch (e) {
          if (this.unmounted) return
          this.setState({ saving: false, saveError: (e && e.message) || '保存失败' })
        }
      }

      render() {
        const s = this.state
        const status = s.status || {}
        const warnings = Array.isArray(status.warnings) ? status.warnings : []
        const roots = Array.isArray(status.roots) ? status.roots : []
        const envOverride = !!status.envOverride
        const dirty = JSON.stringify(s.draft) !== JSON.stringify(s.savedDraft)

        const errorBlock = s.error
          ? h(
              Notice,
              { kind: 'error', title: '看板加载失败' },
              h('div', null, s.error),
              h(
                'div',
                { style: { marginTop: 6 } },
                h('button', { className: 'dsh-ob__btn', type: 'button', onClick: () => this.load(true) }, '重试'),
              ),
            )
          : null

        const warningBlock = warnings.length
          ? h(
              Notice,
              { kind: 'warn', title: '扫描时有问题（不影响其他项目）' },
              h(
                'ul',
                null,
                warnings.slice(0, 20).map((w, i) =>
                  h('li', { key: 'warn-' + i }, (w && (w.error || w.code)) || String(w)),
                ),
              ),
            )
          : null

        const body = s.loading && !s.projects.length
          ? h('div', { className: 'dsh-ob__loading' }, '正在读取本机 git 仓库…')
          : s.projects.length
            ? h(
                'div',
                { className: 'dsh-ob__grid' },
                s.projects.map((p, i) =>
                  h(ProjectCard, {
                    key: (p && p.dir) || 'p-' + i,
                    project: p,
                    expanded: !!(p && p.dir && s.expanded[p.dir]),
                    onToggleExpand: this.onToggleExpand,
                  }),
                ),
              )
            : h(
                'div',
                { className: 'dsh-ob__empty' },
                h('strong', null, s.onlyMine ? '没有属于你的仓库' : '还没有发现项目'),
                s.onlyMine
                  ? h(
                      'div',
                      null,
                      '当前只显示远程 owner 等于「我的账号」的仓库。把「只看我的」关掉，可以看到全部本地仓库。',
                    )
                  : h(
                      'div',
                      null,
                      '在下面的扫描根目录里加入包含 git 仓库的文件夹（例如 ',
                      h('code', null, '包含 git 仓库的目录'),
                      '），然后点刷新。',
                    ),
              )

        return h(
          'div',
          { className: 'dsh-ob' },
          h(
            'div',
            { className: 'dsh-ob__bar' },
            h(
              'div',
              { className: 'dsh-ob__bar-title' },
              '开源项目',
              h('span', { className: 'dsh-ob__count' }, s.loading ? '读取中…' : '共 ' + s.projects.length + ' 个'),
            ),
            h(
              'label',
              {
                className: 'dsh-ob__filter',
                title: '只显示远程 owner 与「我的账号」一致的仓库；纯本地字符串比对，不联网',
              },
              h('input', {
                type: 'checkbox',
                checked: !!s.onlyMine,
                onChange: (e) => this.onToggleOnlyMine(e.target.checked),
              }),
              '只看我的',
            ),
            h(
              'a',
              { className: 'dsh-ob__btn', href: API + '/export.html', target: '_blank', rel: 'noreferrer' },
              '导出 HTML',
            ),
            h(
              'button',
              { className: 'dsh-ob__btn dsh-ob__btn--primary', type: 'button', disabled: s.loading, onClick: () => this.load(true) },
              s.loading ? '刷新中…' : '刷新',
            ),
          ),
          h(
            'div',
            { className: 'dsh-ob__meta' },
            status.githubUser ? h('span', null, '我的账号：' + status.githubUser) : null,
            roots.length
              ? h('span', null, '扫描根：', roots.map((r, i) => h('code', { key: 'r-' + i }, r)))
              : null,
            status.generatedAt ? h('span', null, '生成时间：' + formatWhen(status.generatedAt)) : null,
            h('span', null, '数据全部来自本机 git · 不联网'),
          ),
          h(ReportPanel, {
            report: s.report,
            warning: s.reportWarning,
            expanded: !!s.reportOpen,
            onToggle: () => this.setState({ reportOpen: !this.state.reportOpen }),
          }),
          errorBlock,
          warningBlock,
          body,
          h(RootsEditor, {
            draft: s.draft,
            disabled: envOverride,
            saving: s.saving,
            dirty,
            error: s.saveError,
            savedAt: s.savedAt,
            onChange: (index, value) => {
              const next = s.draft.slice()
              next[index] = value
              this.setState({ draft: next })
            },
            onRemove: (index) => {
              const next = s.draft.slice()
              next.splice(index, 1)
              this.setState({ draft: next })
            },
            onAdd: () => this.setState({ draft: s.draft.concat(['']) }),
            onReset: () => this.setState({ draft: s.savedDraft.slice() }),
            onSave: this.onSave,
          }),
        )
      }
    }

    /** 渲染异常兜底：一栏里出错不该把整个设置页打白。 */
    class BoardBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'dsh-ob' },
            h(
              'div',
              { className: 'dsh-ob__notice dsh-ob__notice--error' },
              h('div', { className: 'dsh-ob__notice-title' }, '「开源项目」这一栏渲染失败'),
              h('div', null, String((this.state.error && this.state.error.message) || this.state.error)),
            ),
          )
        }
        return this.props.children
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        installCss()
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => () => removeCss(), 'dsh-opensource-board: styles')
        }

        let slots
        if (ctx && typeof ctx.get === 'function') slots = ctx.get('slots')
        if (!slots && ctx) slots = ctx.slots
        if (!slots || typeof slots.inject !== 'function') return

        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: SECTION_LABEL,
            },
            () => h(BoardBoundary, null, h(OpenSourceBoard)),
          ),
        )
      },
    }
  },
})
