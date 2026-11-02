#!/usr/bin/env node
/**
 * 开源前自检（opensource pre-flight check）
 * ============================================================================
 * 用法：
 *   node tools/check.mjs                 检查当前目录
 *   node tools/check.mjs <目录>           检查指定仓库
 *   node tools/check.mjs --root <目录>    扫描该目录下所有含 .git 的仓库
 *   node tools/check.mjs --json          只输出 JSON
 *   node tools/check.mjs --save          把报告写进 <DSH_HOME>/opensource-board/reports/
 *   node tools/check.mjs --no-color      纯文本（重定向到文件时自动）
 *
 * 退出码：0 = 没有阻断项；1 = 有阻断项（此时不该上传）；2 = 用法错误。
 *
 * 设计原则：
 *   · 默认只拦真会出事的（密钥、本机路径、缺 LICENSE），其余全是警告；
 *   · 每条问题都给「怎么改」，不只说哪里错；
 *   · 放行要有记录：accepted.json 里写过的，下次不再报；
 *   · 扫描通过 ≠ 可以公开，最终判断在人。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

/* ── 路径与常量 ─────────────────────────────────────────────────────────── */

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const BOARD_DIR = path.join(HOME, 'opensource-board')
const REPORT_DIR = path.join(BOARD_DIR, 'reports')
const ACCEPTED_PATH = path.join(BOARD_DIR, 'accepted.json')
const CONFIG_PATH = path.join(BOARD_DIR, 'config.json')

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.tmp', 'coverage', '.cache', '.next', '.nuxt'])
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonc', '.md', '.markdown',
  '.yml', '.yaml', '.css', '.scss', '.html', '.htm', '.svg', '.txt', '.sh', '.ps1', '.bat',
  '.cmd', '.py', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.ini', '.toml',
  '.gitignore', '.gitattributes', '.env.example', '.editorconfig',
])
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.7z', '.rar', '.mp4', '.mov', '.mp3', '.woff', '.woff2'])
const LARGE_FILE_BYTES = 50 * 1024 * 1024
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/* ── 规则 ───────────────────────────────────────────────────────────────── */

const TOKEN_RE = /\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/
const PEM_RE = /BEGIN [A-Z ]*PRIVATE KEY/
/** Windows 盘符路径；前面是字母的不算（排除 https:// 里的 s://） */
const ABS_WIN_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>)\]]+/
const ABS_UNIX_RE = /(?<![\w:/.])[\\/](?:home|Users)\/[A-Za-z0-9._-]+/
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE_RE = /(?<![\d])1[3-9]\d{9}(?![\d])/
const EXAMPLE_MAIL_DOMAINS = /@(example\.(com|org|net)|test\.com|localhost)$/i

const SENSITIVE_FILES = [
  [/^\.env$/i, '.env 环境变量文件'],
  [/^\.env\.(?!example$)/i, '.env 环境变量文件'],
  [/\.pem$/i, 'PEM 证书/私钥'],
  [/\.key$/i, '私钥文件'],
  [/^id_rsa/i, 'SSH 私钥'],
  [/^id_ed25519/i, 'SSH 私钥'],
  [/^credentials/i, '凭据文件'],
  [/\.pfx$|\.p12$/i, '证书文件'],
  [/^\.npmrc$/i, '.npmrc（可能含 token）'],
]

/** 命中认定：返回 {level, message, suggestion} 或 null */
function judgeToken(m) {
  return {
    level: 'block',
    message: '疑似密钥 / token：「' + redact(m) + '」',
    suggestion: '立刻删掉这一行并到对应平台吊销该凭据；如果这是示例，改成 <YOUR_TOKEN> 之类占位符。',
  }
}

function redact(s) {
  const t = String(s)
  if (t.length <= 8) return t.slice(0, 2) + '****'
  return t.slice(0, 6) + '****' + t.slice(-2)
}

/* ── 参数 ───────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { dir: null, root: null, json: false, save: false, color: process.stdout.isTTY === true }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') { out.root = argv[++i] || null }
    else if (a === '--json') out.json = true
    else if (a === '--save') out.save = true
    else if (a === '--no-color') out.color = false
    else if (a === '--help' || a === '-h') out.help = true
    else if (a.startsWith('--')) { /* 忽略未知参数 */ }
    else rest.push(a)
  }
  if (rest.length) out.dir = rest[0]
  return out
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'))
}

function listRepoDirs(root) {
  const out = []
  let ents = []
  try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
    const p = path.join(root, e.name)
    if (isGitRepo(p)) out.push(p)
  }
  return out
}

function walkFiles(dir) {
  const files = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p)
        continue
      }
      if (!e.isFile()) continue
      files.push(p)
    }
  }
  return files
}

function git(dir, args) {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function rel(dir, file) {
  return path.relative(dir, file).split(path.sep).join('/')
}

/* ── 单个仓库检查 ───────────────────────────────────────────────────────── */

function checkRepo(dir) {
  const findings = []
  const accepted = loadAccepted()
  const username = os.userInfo().username
  const homeBase = os.homedir()
  const selfPath = path.resolve(process.argv[1] || '')

  const files = walkFiles(dir)
  const pkg = readJson(path.join(dir, 'package.json'), null)
  const name = (pkg && pkg.name) || path.basename(dir)
  const version = (pkg && pkg.version) || null

  const textFiles = []
  const binaryFiles = []
  const largeFiles = []

  for (const f of files) {
    const ext = path.extname(f).toLowerCase()
    let st
    try { st = fs.statSync(f) } catch { continue }
    if (st.size > LARGE_FILE_BYTES) largeFiles.push(f)
    if (BINARY_EXT.has(ext)) { binaryFiles.push(f); continue }
    if (!TEXT_EXT.has(ext) && !ext && path.basename(f).startsWith('.')) { textFiles.push(f); continue }
    if (!TEXT_EXT.has(ext)) continue
    if (path.resolve(f) === selfPath) continue
    textFiles.push(f)
  }

  // ── 1. 敏感文件 ──
  for (const f of files) {
    const base = path.basename(f)
    for (const [re, label] of SENSITIVE_FILES) {
      if (!re.test(base)) continue
      if (/\.example$/i.test(base)) continue
      add(findings, accepted, {
        id: 'sensitive-file',
        level: 'block',
        file: rel(dir, f),
        message: '仓库里有敏感文件：' + label,
        suggestion: '删除该文件并加进 .gitignore；如果已经提交过，还要清 git 历史（git filter-repo）。',
      })
      break
    }
  }

  // ── 2. 逐文件内容扫描 ──
  for (const f of textFiles) {
    let text
    try {
      const st = fs.statSync(f)
      if (st.size > MAX_TEXT_BYTES) continue
      text = fs.readFileSync(f, 'utf8')
    } catch { continue }
    if (text.includes('\u0000')) continue
    const lines = text.split(/\r?\n/)
    const rf = rel(dir, f)
    const base = path.basename(f)
    const isDoc = /^(README|LICENSE|CHANGELOG|NOTICE|DISCLAIMER)/i.test(base) || rf.startsWith('docs/')
    const isTestFile = /(^|\/)(test|tests|__tests__)\//.test(rf) || /(selftest|smoke|spec)/i.test(base)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line || line.length > 4000) continue
      const ln = i + 1

      const tok = line.match(TOKEN_RE)
      if (tok) add(findings, accepted, { id: 'secret-token', level: 'block', file: rf, line: ln, message: judgeToken(tok[0]).message, suggestion: judgeToken(tok[0]).suggestion })

      if (PEM_RE.test(line)) add(findings, accepted, { id: 'private-key', level: 'block', file: rf, line: ln, message: '出现私钥头（BEGIN PRIVATE KEY）', suggestion: '务必删除；私钥进过 git 历史就只能换钥匙。' })

      const win = line.match(ABS_WIN_RE)
      if (win && !/^\s*\/\//.test(line)) {
        const cls = classifyAbsPath(win[0], { username, homeBase, isTestFile })
        add(findings, accepted, {
          id: 'abs-path',
          level: cls.level,
          file: rf, line: ln,
          message: cls.message,
          suggestion: cls.suggestion,
        })
      }
      const unix = line.match(ABS_UNIX_RE)
      if (unix) {
        const lower = unix[0].toLowerCase()
        const hitUser = username && lower.includes('/' + username.toLowerCase())
        add(findings, accepted, {
          id: 'abs-path',
          level: hitUser ? 'block' : isTestFile ? 'info' : 'warn',
          file: rf, line: ln,
          message: hitUser ? '出现本机用户目录：「' + unix[0] + '」' : '出现绝对路径：「' + unix[0] + '」',
          suggestion: '改成 ~/ 或环境变量占位（如 $HOME）。',
        })
      }

      if (username && username.length >= 3) {
        const ure = new RegExp('(?<![\\w])' + escapeRe(username) + '(?![\\w])')
        if (ure.test(line) && !line.includes('user.name')) {
          add(findings, accepted, {
            id: 'username',
            level: 'block',
            file: rf, line: ln,
            message: '出现本机用户名「' + username + '」',
            suggestion: '改成 <你的用户名> 或环境变量占位。',
          })
        }
      }

      const mail = line.match(EMAIL_RE)
      const mailEnd = mail ? line.indexOf(mail[0]) + mail[0].length : -1
      // git@github.com:owner/repo.git 这种 SCP 写法不是邮箱
      const isScpUrl = mail ? /[:/]/.test(line[mailEnd] || '') : false
      if (mail && !EXAMPLE_MAIL_DOMAINS.test(mail[0]) && !isScpUrl) {
        if (isDoc && /^(LICENSE|DISCLAIMER)/i.test(base)) {
          add(findings, accepted, { id: 'email', level: 'info', file: rf, line: ln, message: '许可证里的联系邮箱：「' + mail[0] + '」', suggestion: '如果是公开联系邮箱可保留；不想公开就删掉。' })
        } else if (!isDoc) {
          add(findings, accepted, { id: 'email', level: 'warn', file: rf, line: ln, message: '源码里出现邮箱：「' + mail[0] + '」', suggestion: '确认是否愿意公开；不需要就删掉。' })
        }
      }

      const phone = line.match(PHONE_RE)
      if (phone) add(findings, accepted, { id: 'phone', level: 'warn', file: rf, line: ln, message: '疑似手机号：「' + phone[0] + '」', suggestion: '删掉或改成占位符。' })
    }
  }

  // ── 3. LICENSE ──
  const licenseFile = files.find((f) => /^LICEN[CS]E(\.(md|txt))?$/i.test(path.basename(f)))
  if (!licenseFile) {
    add(findings, accepted, {
      id: 'missing-license',
      level: 'block',
      file: null,
      message: '仓库里没有 LICENSE 文件',
      suggestion: '加一个（MIT 最简单，去 choosealicense.com 生成）。没有许可证，别人不敢用，法律上也不好说。',
    })
  } else {
    const lt = (() => { try { return fs.readFileSync(licenseFile, 'utf8') } catch { return '' } })()
    const pkgLicense = pkg && pkg.license
    if (pkgLicense && lt && !new RegExp(escapeRe(String(pkgLicense)), 'i').test(lt)) {
      add(findings, accepted, { id: 'license-mismatch', level: 'warn', file: rel(dir, licenseFile), message: 'package.json 写的是 ' + pkgLicense + '，LICENSE 文件里没找到这个词', suggestion: '统一一下，两边写的许可证要一致。' })
    }
  }

  // ── 4. 版本一致性 ──
  const latestTag = git(dir, ['describe', '--tags', '--abbrev=0']).replace(/^v/, '')
  const changelog = files.find((f) => /^CHANGELOG(\.md)?$/i.test(path.basename(f)))
  let changelogVer = null
  if (changelog) {
    try {
      const txt = fs.readFileSync(changelog, 'utf8')
      const m = txt.match(/\b(\d+\.\d+\.\d+)\b/)
      if (m) changelogVer = m[1]
    } catch { /* ignore */ }
  }
  if (version && latestTag && version !== latestTag) {
    add(findings, accepted, { id: 'version-mismatch', level: 'warn', file: 'package.json', message: 'package.json 是 ' + version + '，最新 tag 是 v' + latestTag, suggestion: '这次要发版就打新 tag；不发版就先把版本号对齐。' })
  }
  if (version && changelogVer && version !== changelogVer) {
    add(findings, accepted, { id: 'changelog-mismatch', level: 'warn', file: rel(dir, changelog), message: 'package.json 是 ' + version + '，CHANGELOG 最新一条是 ' + changelogVer, suggestion: '在 CHANGELOG 顶部补一条本次改动。' })
  }

  // ── 5. git 历史 / 提交身份 ──
  const lastEmail = git(dir, ['log', '-1', '--format=%ae'])
  if (lastEmail && !/@users\.noreply\.github\.com$/.test(lastEmail)) {
    add(findings, accepted, { id: 'commit-email', level: 'warn', file: null, message: '最近一次提交用的是真实邮箱：' + lastEmail, suggestion: 'git config user.email 改成 <id>+<username>@users.noreply.github.com。' })
  }

  const histScan = scanGitHistory(dir)
  for (const h of histScan) {
    add(findings, accepted, {
      id: 'history-secret',
      level: 'block',
      file: null,
      message: 'git 历史（' + h.hash + '）里出现疑似密钥',
      suggestion: '历史推上去就撤不回。要么改历史（git filter-repo），要么换掉那把钥匙。',
    })
  }

  // ── 6. 二进制 / 大文件 ──
  for (const f of binaryFiles) {
    add(findings, accepted, { id: 'binary-file', level: 'warn', file: rel(dir, f), message: '二进制/图片文件，自动扫描看不出来里面有什么', suggestion: '自己打开看一眼有没有聊天记录、路径、头像等个人信息。' })
  }
  for (const f of largeFiles) {
    add(findings, accepted, { id: 'large-file', level: 'warn', file: rel(dir, f), message: '文件超过 50MB', suggestion: 'GitHub 单文件上限 100MB，大文件建议用 Git LFS 或放 release 附件。' })
  }

  // ── 7. 文档口径 ──
  const readme = files.find((f) => /^README(\.md|\.markdown)?$/i.test(path.basename(f)))
  if (readme) {
    let txt = ''
    try { txt = fs.readFileSync(readme, 'utf8') } catch { /* ignore */ }
    if (txt && !/非官方|unofficial/i.test(txt)) {
      add(findings, accepted, { id: 'unofficial-notice', level: 'warn', file: rel(dir, readme), message: 'README 里没有「非官方」声明', suggestion: '如果项目依附某个平台，补一句「非官方，与官方无隶属关系」，能少很多麻烦。' })
    }
    if (txt && !/LICENSE/.test(txt)) {
      add(findings, accepted, { id: 'readme-license', level: 'warn', file: rel(dir, readme), message: 'README 里没有链接到 LICENSE', suggestion: '在结尾加一行「许可证：[MIT](LICENSE)」。' })
    }
  }

  // ── 汇总 ──
  findings.sort((a, b) => rank(a.level) - rank(b.level))
  const summary = { block: 0, warn: 0, info: 0, accepted: 0 }
  for (const f of findings) {
    if (f.accepted) summary.accepted++
    else summary[f.level] = (summary[f.level] || 0) + 1
  }
  const verdict = summary.block > 0 ? 'blocked' : summary.warn > 0 ? 'warn' : 'ok'
  return { dir, name, version, verdict, summary, findings }
}

function rank(level) {
  const order = { block: 0, warn: 1, info: 2 }
  return order[level] ?? 3
}

function add(findings, accepted, f) {
  if (isAccepted(accepted, f)) {
    findings.push(Object.assign({}, f, { accepted: true }))
    return
  }
  findings.push(f)
}

/* ── 放行记录 ───────────────────────────────────────────────────────────── */

function loadAccepted() {
  const doc = readJson(ACCEPTED_PATH, null)
  if (!doc || !Array.isArray(doc.items)) return []
  return doc.items
}

function isAccepted(items, f) {
  return items.some((it) =>
    it && it.id === f.id &&
    (it.file === undefined || it.file === null || it.file === f.file) &&
    (it.message === undefined || !f.message || it.message === f.message),
  )
}

/* ── git 历史扫描（最近 50 条提交）─────────────────────────────────────── */

function scanGitHistory(dir) {
  const out = []
  const log = git(dir, ['log', '-n', '50', '--format=COMMIT:%h', '-p', '--', '.'])
  if (!log) return out
  let hash = ''
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('COMMIT:')) { hash = line.slice(7); continue }
    if (line.startsWith('+') && TOKEN_RE.test(line)) {
      if (!out.some((x) => x.hash === hash)) out.push({ hash })
      if (out.length >= 5) break
    }
  }
  return out
}

/* ── 绝对路径分级 ───────────────────────────────────────────────────────── */

/** 测试夹具/示例里常见的假路径段 */
const PLACEHOLDER_SEG = /(^|[\\/])(ws|root|other|path|to|example|sample|foo|bar|demo|test|tmp|a|b|alpha|beta|x|y)([\\/]|$)/i

function classifyAbsPath(raw, ctx) {
  // 源码里写成 'D:\\ws' 时匹配到的是双反斜杠，先归一化再判断
  const norm = String(raw).replace(/\\+/g, '\\')
  const lower = norm.toLowerCase()
  const home = (ctx.homeBase || '').toLowerCase().replace(/\\+/g, '\\')

  if (ctx.username && lower.includes(ctx.username.toLowerCase())) {
    return {
      level: 'block',
      message: '出现本机绝对路径（含用户名）：「' + norm + '」',
      suggestion: '改成 <你的用户名> 或环境变量占位。',
    }
  }
  if (home && lower.startsWith(home)) {
    return {
      level: 'block',
      message: '出现你本机的用户目录：「' + norm + '」',
      suggestion: '改成 %USERPROFILE% 或 ~/ 占位。',
    }
  }
  if (PLACEHOLDER_SEG.test(norm)) {
    return {
      level: 'info',
      message: '示例/测试夹具路径：「' + norm + '」',
      suggestion: '看起来是测试用例里的假路径，一般不用改；确认一下不是真机路径就行。',
    }
  }
  if (ctx.isTestFile) {
    return {
      level: 'info',
      message: '测试文件里的绝对路径：「' + norm + '」',
      suggestion: '测试夹具路径，确认不是本机真实路径即可。',
    }
  }
  return {
    level: 'warn',
    message: '出现绝对路径：「' + norm + '」',
    suggestion: '改成相对路径，或写成 <项目根>/... 这种占位；README 里可以直接写 ~/your-project。',
  }
}

/* ── 输出 ───────────────────────────────────────────────────────────────── */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m',
}

function render(reports, args) {
  const useColor = args.color && !args.json
  const c = (code, s) => (useColor ? code + s + C.reset : s)

  if (args.json) {
    console.log(JSON.stringify(buildDoc(reports), null, 2))
    return
  }

  for (const r of reports) {
    console.log('')
    console.log(c(C.bold, '=== ' + r.name + (r.version ? ' ' + r.version : '') + ' ==='))
    console.log(c(C.dim, r.dir))
    if (!r.findings.length) {
      console.log(c(C.green, '  ✓ 没有发现问题'))
      continue
    }
    for (const f of r.findings) {
      const tag = f.accepted ? '[已放行]'
        : f.level === 'block' ? c(C.red, '[阻断]')
          : f.level === 'warn' ? c(C.yellow, '[警告]')
            : c(C.dim, '[提示]')
      const loc = f.file ? f.file + (f.line ? ':' + f.line : '') : '(整个仓库)'
      console.log('  ' + tag + ' ' + c(C.cyan, loc))
      console.log('          ' + f.message)
      if (f.suggestion) console.log('          ' + c(C.dim, '建议：' + f.suggestion))
    }
    console.log('')
    const line = '  ' + r.summary.block + ' 阻断 / ' + r.summary.warn + ' 警告 / ' + r.summary.info + ' 提示'
      + (r.summary.accepted ? ' / ' + r.summary.accepted + ' 已放行' : '')
    if (r.verdict === 'blocked') console.log(c(C.red, line + ' → 不能上传'))
    else if (r.verdict === 'warn') console.log(c(C.yellow, line + ' → 建议处理后再传'))
    else console.log(c(C.green, line + ' → 可以上传'))
  }

  const totals = totalsOf(reports)
  console.log('')
  console.log(c(C.bold, '—— 合计：' + totals.block + ' 阻断 / ' + totals.warn + ' 警告 ——'))
  if (totals.block > 0) {
    console.log(c(C.red, '有阻断项，先修掉再上传。'))
  } else {
    console.log(c(C.dim, '扫描通过 ≠ 可以公开：文件名、注释里的一句话、截图内容，这些扫描看不出来，最终判断在你。'))
  }
}

function totalsOf(reports) {
  const t = { block: 0, warn: 0, info: 0 }
  for (const r of reports) for (const k of Object.keys(t)) t[k] += r.summary[k] || 0
  return t
}

function buildDoc(reports) {
  return {
    generatedAt: new Date().toISOString(),
    root: process.cwd(),
    totals: totalsOf(reports),
    projects: reports.map((r) => ({
      dir: r.dir,
      name: r.name,
      version: r.version,
      verdict: r.verdict,
      summary: r.summary,
      findings: r.findings,
    })),
  }
}

function saveReport(reports) {
  const doc = buildDoc(reports)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true })
    fs.writeFileSync(path.join(REPORT_DIR, ts + '.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(REPORT_DIR, 'latest.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8')
    console.log('报告已存入：' + REPORT_DIR)
  } catch (e) {
    console.error('报告保存失败：' + (e && e.message))
  }
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node tools/check.mjs [目录] [--root <目录>] [--json] [--save] [--no-color]')
    return 0
  }

  let targets = []
  if (args.root) {
    const root = path.resolve(args.root)
    if (!fs.existsSync(root)) { console.error('目录不存在：' + root); return 2 }
    targets = listRepoDirs(root)
    if (!targets.length) { console.error('该目录下没有找到 git 仓库：' + root); return 2 }
  } else {
    const dir = path.resolve(args.dir || process.cwd())
    if (!fs.existsSync(dir)) { console.error('目录不存在：' + dir); return 2 }
    targets = [dir]
  }

  const reports = targets.map(checkRepo)
  render(reports, args)
  if (args.save) saveReport(reports)

  return totalsOf(reports).block > 0 ? 1 : 0
}

process.exitCode = main()
