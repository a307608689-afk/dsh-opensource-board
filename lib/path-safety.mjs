/**
 * dsh-opensource-board —— 路径安全（纯函数，不碰文件系统）
 * ============================================================================
 * 为什么单独抽出来：扫描根目录是用户可配的，git / package.json 路径都从磁盘读，
 * 任何一处少做一次「规范化 + 前缀校验」都可能读到根目录外面去。
 * 这里只做字符串层面的判定，真实路径（realpath）复核在 lib/discover.mjs 里做，
 * 两层都过才算安全。
 */

import { resolve, sep, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

/** Windows 上路径大小写不敏感；比较前统一小写，避免 C:\Foo 与 c:\foo 被当成两个目录。 */
const CASE_INSENSITIVE = process.platform === 'win32'

function fold(p) {
  return CASE_INSENSITIVE ? p.toLowerCase() : p
}

/** 两个已规范化路径是否相等（Windows 忽略大小写）。 */
export function samePath(a, b) {
  return fold(resolve(a)) === fold(resolve(b))
}

/**
 * target 是否在 base 内部（含 base 本身）。
 * 先 resolve 再按分隔符比较，避免 `C:\a\bc` 被当成 `C:\a\b` 的子路径。
 */
export function pathInside(base, target) {
  const b = resolve(base)
  const p = resolve(target)
  const fb = fold(b)
  const fp = fold(p)
  if (fp === fb) return true
  return fp.startsWith(fb.endsWith(sep) ? fb : fb + sep)
}

/**
 * 规范化一个「扫描根目录」配置值。
 * - 支持 `~` / `~/xxx` / `~\xxx` 展开到用户主目录；
 * - 支持 Windows 习惯的 `%VAR%` 环境变量展开（未定义时原样保留，随后会因为不是绝对路径被拒）；
 * - 必须是绝对路径（resolve 后总能得到绝对路径，所以对「相对路径」我们额外按原值判定）；
 * - 拒绝空串、控制字符、超长路径。
 *
 * 返回 { ok: true, path } 或 { ok: false, error }。
 */
export function normalizeRoot(input) {
  const raw = input == null ? '' : String(input).trim()
  if (!raw) return { ok: false, error: '路径为空' }
  if (raw.length > 512) return { ok: false, error: '路径过长（超过 512 字符）' }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: '路径包含控制字符' }

  let p = raw
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = join(homedir(), p.slice(1))
  }
  p = p.replace(/%([^%]+)%/g, (all, name) => {
    const v = process.env[name]
    return v == null || v === '' ? all : v
  })

  // 上面展开之后仍是相对路径的，直接拒绝：不做「按 cwd 瞎猜」的兜底。
  if (!isAbsolute(p)) return { ok: false, error: '必须是绝对路径：' + raw }

  return { ok: true, path: resolve(p) }
}

/**
 * 把记录里的相对路径拼到 base 下，并保证结果不越界。
 * 拒绝：空串、绝对路径、盘符开头、`..` 逃逸、控制字符。
 */
export function safeJoinInside(base, rel) {
  const raw = rel == null ? '' : String(rel)
  if (!raw.trim()) return { ok: false, code: 'BAD_PATH', error: '路径为空' }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, code: 'BAD_PATH', error: '路径包含控制字符：' + raw }
  }
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, code: 'BAD_PATH', error: '不允许绝对路径：' + raw }
  }
  const dest = resolve(base, raw)
  if (!pathInside(base, dest)) return { ok: false, code: 'BAD_PATH', error: '路径越界：' + raw }
  return { ok: true, dest }
}
