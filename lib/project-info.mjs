/**
 * dsh-opensource-board —— 文本清洗 / 解析 / 转义（纯函数，无 I/O）
 * ============================================================================
 * 这里处理的数据全部来自「本机磁盘上的陌生仓库」：package.json 的 description、
 * 分支名、commit 标题、remote URL 都可能包含任意字符。分两层处理：
 *
 *   1. sanitizeText()：去掉控制字符、压平换行、截断长度 —— 保证进 JSON / 日志安全；
 *   2. escapeHtml()：把 & < > " ' ` 转成实体 —— 只在「真的拼 HTML」时用（导出报表）。
 *
 * 前端走 React 文本节点，本身不会再解析 HTML；导出 HTML 报表是唯一需要转义的出口，
 * 由 renderProjectsHtml() 统一走 escapeHtml()，selftest 覆盖。
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
}

/**
 * 把任意输入压成「可以安全放进 JSON / 界面」的单行文本。
 * - null / undefined → ''
 * - 去掉 C0 控制字符（保留换行，随后压平成空格）
 * - 折叠连续空白、去掉首尾空白
 * - 超过 maxLen 截断并补 `…`
 */
export function sanitizeText(input, maxLen = 400) {
  if (input == null) return ''
  let s = String(input).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
  s = s
    .split('\n')
    .map((line) => line.replace(/[\t\v\f ]+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
  if (maxLen > 0 && s.length > maxLen) {
    s = s.slice(0, maxLen - 1) + '…'
  }
  return s
}

/** HTML 实体转义（`&` 必须先转，否则会二次转义）。 */
export function escapeHtml(input) {
  return String(input == null ? '' : input).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch])
}

/**
 * 解析 package.json。只取我们需要且确定是字符串的三个字段，
 * 结构不对就返回 error，而不是抛异常。
 */
export function parsePackageJson(text) {
  const out = { name: '', version: '', description: '', error: '' }
  if (typeof text !== 'string' || !text.trim()) {
    out.error = 'package.json 为空'
    return out
  }
  let obj
  try {
    obj = JSON.parse(text)
  } catch (e) {
    out.error = 'JSON 解析失败：' + sanitizeText(e && e.message, 120)
    return out
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    out.error = 'package.json 顶层不是对象'
    return out
  }
  out.name = sanitizeText(obj.name, 120)
  out.version = sanitizeText(obj.version, 60)
  out.description = sanitizeText(obj.description, 240)
  return out
}

/**
 * `git status --porcelain` 的未提交改动数（行数）。
 * porcelain v1 每条改动一行；空行不算。重命名条目也只是同一行里的 `old -> new`。
 */
export function countPorcelainChanges(output) {
  if (typeof output !== 'string' || !output) return 0
  let n = 0
  for (const line of output.split(/\r?\n/)) {
    if (line.trim()) n += 1
  }
  return n
}

/**
 * 解析 `git log -1 --format=%cI%n%s`：
 * 第一行是 committer 时间（ISO 8601 带时区），其余是 commit 标题。
 */
export function parseLastCommit(output) {
  const out = { at: '', subject: '', error: '' }
  if (typeof output !== 'string' || !output.trim()) {
    out.error = '没有提交记录'
    return out
  }
  const lines = output.split(/\r?\n/)
  const at = lines[0].trim()
  if (!at) {
    out.error = '提交时间为空'
    return out
  }
  if (!Number.isFinite(new Date(at).getTime())) {
    out.error = '提交时间格式不认识：' + sanitizeText(at, 60)
    return out
  }
  out.at = at
  out.subject = sanitizeText(lines.slice(1).join(' '), 240)
  return out
}

/**
 * 解析 `git rev-parse --abbrev-ref HEAD`。
 * detached HEAD 时 Git 输出 `HEAD`，调用方需要再取一次短 sha 作为展示分支。
 */
export function parseBranch(output) {
  const raw = sanitizeText(output, 240)
  if (!raw) return { branch: '', detached: false }
  if (raw === 'HEAD') return { branch: '', detached: true }
  return { branch: raw, detached: false }
}

/**
 * remote URL 里可能带凭据（https://user:token@host/...）。
 * 只做「遮掉密码部分」——看板会把 URL 显示出来，不能顺手把 token 也贴上去。
 */
export function redactUrlCredentials(url) {
  const s = sanitizeText(url, 500)
  if (!s) return ''
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i, (all, scheme, userinfo) => {
    const user = String(userinfo).split(':')[0]
    return scheme + user + ':***@'
  })
}

/** 解析 `git remote get-url origin`：没有 origin 时返回 null（不算错误）。 */
export function parseRemoteUrl(output) {
  const s = redactUrlCredentials(output)
  return s || null
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；解析不了就原样返回。 */
export function formatLocalIso(iso) {
  const raw = sanitizeText(iso, 64)
  if (!raw) return ''
  const d = new Date(raw)
  if (!Number.isFinite(d.getTime())) return raw
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  )
}

/**
 * 生成「导出 HTML 报表」。这是插件里唯一拼接 HTML 的地方，
 * 因此所有外部文本都必须过 escapeHtml()。
 */
export function renderProjectsHtml(projects, opts = {}) {
  const title = sanitizeText(opts.title || '开源项目看板', 120) || '开源项目看板'
  const generatedAt = sanitizeText(opts.generatedAt || new Date().toISOString(), 64)
  const roots = Array.isArray(opts.roots) ? opts.roots : []
  const warnings = Array.isArray(opts.warnings) ? opts.warnings : []
  const list = Array.isArray(projects) ? projects : []

  const rows = list.map((p) => {
    const name = escapeHtml(p.name)
    const ver = p.version ? '<span class="ver">v' + escapeHtml(p.version) + '</span>' : ''
    const desc = p.description ? '<div class="ds">' + escapeHtml(p.description) + '</div>' : ''
    const dir = '<div class="pt">' + escapeHtml(p.dir) + '</div>'
    const branch = p.branch
      ? escapeHtml(p.branch) + (p.detached ? '（分离 HEAD）' : '')
      : '—'
    const dirty = p.dirtyCount == null ? '—' : p.dirtyCount === 0 ? '干净' : String(p.dirtyCount) + ' 项'
    const when = p.lastCommit && p.lastCommit.at ? formatLocalIso(p.lastCommit.at) : '—'
    const subject = p.lastCommit && p.lastCommit.subject ? escapeHtml(p.lastCommit.subject) : ''
    const remote = p.remoteUrl ? escapeHtml(p.remoteUrl) : '—'
    return (
      '<tr><td><div class="nm">' + name + ver + '</div>' + desc + dir + '</td>' +
      '<td>' + branch + '</td>' +
      '<td>' + dirty + '</td>' +
      '<td>' + escapeHtml(when) + (subject ? '<div class="ds">' + subject + '</div>' : '') + '</td>' +
      '<td class="url">' + remote + '</td></tr>'
    )
  }).join('\n')

  const rootLine = roots.length
    ? '<p>扫描根目录：' + roots.map((r) => '<code>' + escapeHtml(r) + '</code>').join('、') + '</p>'
    : ''
  const warningLine = warnings.length
    ? '<div class="warn"><b>扫描时有问题：</b><ul>' +
      warnings.map((w) => '<li>' + escapeHtml(w && (w.error || w.code) || String(w)) + '</li>').join('') +
      '</ul></div>'
    : ''
  const body = list.length
    ? '<table><thead><tr><th>项目</th><th>分支</th><th>未提交</th><th>最近提交</th><th>远程仓库</th></tr></thead><tbody>' +
      rows + '</tbody></table>'
    : '<p class="empty">没有找到项目。把包含 <code>.git</code> 的目录加进扫描根目录后刷新。</p>'

  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>' +
    'body{font:13px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#1d1d1f;background:#fff}' +
    'h1{font-size:18px;margin:0 0 4px}p{color:#666;font-size:12px;margin:4px 0 14px}' +
    'table{border-collapse:collapse;width:100%;max-width:1100px}th,td{border-bottom:1px solid #e5e5ea;padding:9px 10px;text-align:left;vertical-align:top}' +
    'th{font-size:12px;color:#666;font-weight:600;background:#fafafa}' +
    '.nm{font-weight:600}.ver{display:inline-block;margin-left:8px;padding:0 6px;border:1px solid #d2d2d7;border-radius:5px;font-size:11px;color:#555;font-weight:400}' +
    '.ds{color:#666;font-size:12px;margin-top:2px}.pt{color:#999;font-size:11px;margin-top:3px;word-break:break-all}' +
    '.url{word-break:break-all;font-size:12px}.warn{margin:10px 0;padding:10px 12px;border-radius:8px;background:#fff6e5;color:#8a5a00;font-size:12px}' +
    '.warn ul{margin:4px 0 0 18px;padding:0}.empty{padding:24px 0;color:#666}' +
    '</style></head><body>' +
    '<h1>' + escapeHtml(title) + '</h1>' +
    '<p>生成时间：' + escapeHtml(generatedAt) + ' · 共 ' + list.length + ' 个项目 · 数据来自本机 git，未联网</p>' +
    rootLine + warningLine + body +
    '</body></html>\n'
}
