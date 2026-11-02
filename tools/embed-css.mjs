/**
 * tools/embed-css.mjs —— 把 ui.css 内联进 client.js 的 CSS 模板字符串
 * ============================================================================
 * DSH 客户端插件没有「加载外部 css 文件」的公开协议（已上线插件都是把 CSS
 * 字符串直接 append 到 document.head），所以 ui.css 是源文件，client.js 里
 * 的 CSS 常量由本脚本生成。改样式后跑一次：
 *
 *   node tools/embed-css.mjs            # 写入
 *   node tools/embed-css.mjs --check    # 只检查是否同步（CI/自检用）
 *
 * 通过 `// @css-begin` / `// @css-end` 两个标记定位，标记之间只放一行
 * `const CSS = ...`。CSS 里不允许出现反引号或 `${`，否则模板字符串会坏掉。
 */

import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CSS_FILE = join(ROOT, 'ui.css')
const CLIENT_FILE = join(ROOT, 'client.js')
const BEGIN = '// @css-begin'
const END = '// @css-end'

function buildBlock(css) {
  return [BEGIN, '    const CSS = `', css.replace(/\r\n/g, '\n').replace(/`/g, '\\`').replace(/\$\{/g, '\\${'), '`', END].join('\n')
}

async function main() {
  const check = process.argv.includes('--check')
  const css = await fsp.readFile(CSS_FILE, 'utf8')
  const client = await fsp.readFile(CLIENT_FILE, 'utf8')

  if (css.includes('`') || css.includes('${')) {
    console.error('FAIL ui.css 里不能出现反引号或 ${（会破坏模板字符串）')
    process.exit(1)
  }

  const start = client.indexOf(BEGIN)
  const end = client.indexOf(END)
  if (start < 0 || end < 0 || end < start) {
    console.error('FAIL client.js 里找不到 ' + BEGIN + ' / ' + END + ' 标记')
    process.exit(1)
  }

  const head = client.slice(0, start)
  const tail = client.slice(end + END.length)
  const next = head + buildBlock(css) + tail

  if (check) {
    if (next !== client) {
      console.error('FAIL client.js 内联的 CSS 与 ui.css 不一致，请跑 node tools/embed-css.mjs')
      process.exit(1)
    }
    console.log('PASS client.js 内联 CSS 与 ui.css 一致（' + css.length + ' 字符）')
    return
  }

  if (next === client) {
    console.log('OK 已是最新，无需写入（' + css.length + ' 字符）')
    return
  }
  await fsp.writeFile(CLIENT_FILE, next, 'utf8')
  console.log('OK 已把 ui.css（' + css.length + ' 字符）内联进 client.js')
}

main().catch((e) => {
  console.error('FAIL ' + ((e && e.stack) || e))
  process.exit(1)
})
