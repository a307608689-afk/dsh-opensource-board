# dsh-opensource-board · DSH 开源项目看板

在 DSH（DeepSeek Harness）设置页新增一栏「开源项目」：把本机的 git 仓库列成卡片/列表，一眼看到版本、分支、未提交改动、最近一次提交和远程地址。

**只读。全部数据来自本机 git。不连 GitHub，不存 token，不上传任何数据。**

---

## 功能

| 卡片上的字段 | 来源 |
| --- | --- |
| 项目名 / 版本 | 仓库根目录 `package.json` 的 `name` / `version`（没有 `package.json` 时用目录名） |
| 一句话描述 | `package.json` 的 `description` |
| 当前 git 分支 | `git rev-parse --abbrev-ref HEAD`（detached HEAD 显示短 sha 并标注「分离 HEAD」） |
| 未提交改动数 | `git status --porcelain` 的行数，0 显示「干净」 |
| 最近一次提交 | `git log -1 --format=%cI%n%s` → 本地时间 + 标题 |
| 远程仓库 URL | `git remote get-url origin`（没有 origin 显示 `—`） |

界面还带：

- **刷新**按钮（`?refresh=1` 绕过 3 秒缓存，强制重扫）
- **导出 HTML**：把当前看板导成一个自包含的 HTML 页面（新窗口打开）
- **空状态提示**：没有发现项目时引导你去加扫描根目录
- **加载失败提示**：接口挂了会显示具体错误 + 重试按钮，不会把设置页打白
- **扫描根目录编辑器**：增删目录、保存后立即重扫
- 扫描告警：某个根目录不存在 / 越界 / 项目数超上限时，单独列出来，不影响其他项目显示

---

## 安装

插件是**零依赖**的纯 ESM，不需要 `npm install`，把目录放到本机任意位置即可。

### 方式 A：DSH 插件管理界面（如果你的版本有）

设置 → 插件 → 添加本地插件 → 选到本目录 `<插件目录绝对路径>`。

### 方式 B：手工写进 profile（当前的桌面版就是这种方式）

编辑当前 profile 的 `package.json`，路径是
`%USERPROFILE%\.dsh\profiles\desktop\package.json`，两处改动：

```jsonc
{
  "dependencies": {
    // 加这一行（其他依赖保持原样）
    "dsh-opensource-board": "link:<插件目录绝对路径>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // 在末尾追加
        "dsh-opensource-board"
      ]
    }
  }
}
```

然后**完全退出并重启 DSH**（不是刷新页面——服务端插件只在启动时加载）。

> 依据：这些字段形状是从本机已在用的插件（`dsh-session-trash`、`dsh-command-fuse`）的
> `package.json` 与 profile 配置里读出来的，不是猜的；`cordis.yml` 里明确写着
> 「Edit cordis.patch.yml, not this file.」，所以插件自身的 `cordis.patch.yml` 用
> `- insert: - id: dsh-opensource-board / name: dsh-opensource-board` 三行声明。

### 启用后

打开 **设置 → 开源项目**。插件会扫描配置里的根目录（默认指向本机工作区，
可在设置里改成你自己的项目目录），子目录中含 `.git` 的仓库都会出现在列表里。

---

## 配置

### 配置文件

默认位置：`%USERPROFILE%\.dsh\opensource-board\config.json`
（`DSH_HOME` 存在时是 `$DSH_HOME/opensource-board/config.json`）

```json
{
  "roots": ["D:\\Documents\\deepseek-harness\\default-workspace"],
  "maxProjects": 200
}
```

- `roots`：扫描根目录数组，**只扫描这些目录下「直接子目录里含 `.git`」的一层**，不递归。
- `maxProjects`：项目总数上限，1–1000，默认 200。

可以直接改文件，也可以在界面上改（界面上改会原子写回这个文件）。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_OPENSOURCE_BOARD_ROOTS` | 用 `;`（`path.delimiter`）分隔的根目录列表。设置后**完全以它为准**，界面上的根目录编辑器变灰、`POST /config` 返回 409。适合多目录只读锁定。 |
| `DSH_OPENSOURCE_BOARD_CONFIG` | 指定配置文件路径（自测用它指向临时文件，不碰你的真实配置）。 |
| `DSH_HOME` | DSH 主目录，决定默认配置文件位置。 |

### 根目录的写法

- 必须是**绝对路径**，相对路径一律拒绝（不会按当前工作目录瞎猜）。
- 支持 `~`（用户主目录）和 Windows 的 `%VAR%` 展开。
- 用 `/` 或 `\` 都行，内部统一 `path.resolve` 规范化。

---

## HTTP 接口

主路由是需求指定的 `/api/dsh-opensource-board`。另外**同时注册了一份别名 `/dsh-opensource-board`**：
DSH 宿主是否把 `/api` 命名空间留给插件、我没有在宿主源码里确认到（安装包是打包过的
`app.asar`，读不到实现），所以两边都注册、前端在主路由 404 时自动回退别名。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-opensource-board/projects` | **返回 JSON 数组**（需求指定形状）。支持 `?refresh=1` 跳过缓存 |
| GET | `/api/dsh-opensource-board/status` | `{ ok, plugin, version, generatedAt, count, roots, envOverride, configFile, truncated, warnings }` |
| GET | `/api/dsh-opensource-board/config` | 当前生效配置 + 默认值 |
| POST | `/api/dsh-opensource-board/config` | `{ roots: [...], maxProjects? }`，非法路径进 `rejected`；被环境变量锁定时 409 |
| GET | `/api/dsh-opensource-board/export.html` | 自包含 HTML 报表（带 CSP `default-src 'none'`） |

`/projects` 真实输出样例（本机跑出来的，两条真实仓库）：

```json
[
  {
    "dir": "D:\\Documents\\deepseek-harness\\default-workspace\\dsh-cost-meter-src",
    "root": "D:\\Documents\\deepseek-harness\\default-workspace",
    "name": "dsh-cost-meter",
    "version": "0.3.0",
    "description": "Per-step token cost ledger with peak/off-peak pricing ...",
    "branch": "main",
    "detached": false,
    "dirtyCount": 31,
    "lastCommit": {
      "at": "2026-09-22T22:01:27+08:00",
      "subject": "fix: restore cost accounting and add weekday-selected peak windows"
    },
    "remoteUrl": "https://github.com/Creakono/dsh-cost-meter",
    "hasPackageJson": true,
    "errors": []
  }
]
```

---

## 安全说明

这是本插件的设计底线，也都有对应代码位置：

1. **不联网、不存 token、不上传数据。** 服务端只做三件事：列目录、读 `package.json`、跑本地 git 读命令。
   没有 `fetch`、没有 HTTP 客户端、没有任何遥测。git 也不会联网：
   `git status/log/rev-parse/remote get-url` 都是纯本地命令，`credential.helper=` 与
   `GIT_TERMINAL_PROMPT=0` 进一步保证不会弹凭据、不会卡在输入密码。
2. **git 调用参数固定，绝不拼接用户输入到 shell。** 用 `child_process.execFile('git', [...固定 argv, '-C', dir, ...固定子命令])`，
   没有 `shell: true`、没有字符串拼接。仓库目录名里出现 `&`、`;`、`|`、引号都只是 argv 的一个普通元素。
3. **路径双重边界校验，禁止越过配置根目录。**
   - 第一道：`lib/path-safety.mjs` 的 `pathInside()`，`resolve` 后按分隔符比较，`C:\a\bc` 不会被当成 `C:\a\b` 的子路径；
   - 第二道：`realpath()` 之后再校验一次 —— junction / symlink 指向根目录外面会被拒（`OUT_OF_ROOT` 警告），不会顺着链接读到别处；
   - 未提交改动、分支等信息只来自 `git -C <已校验目录>`，不读别的路径。
4. **输出到前端的文本做 HTML 转义。** 导出 HTML 是唯一拼接 HTML 的地方，所有外部字段（项目名、描述、分支、
   commit 标题、remote URL、路径）都过 `escapeHtml()`；前端走 React 文本节点（不用 `innerHTML`），
   仓库里的内容不会被当成标签执行。导出页还带 `Content-Security-Policy: default-src 'none'`。
5. **凭据遮蔽。** remote URL 里如果带 `https://user:token@host/...`，只显示 `https://user:***@host/...`。
6. **配置写入受限。** 配置只能是绝对路径的根目录列表；`POST /config` 有 64KB 请求体上限、
   原子写（临时文件 + rename）、被环境变量锁定时拒绝改写。
7. **只读。** 插件不写仓库、不执行 checkout/pull/commit；除配置文件和自测临时目录外不写任何路径。

---

## 开发与自检

零第三方依赖，Node 20+（本机 Node v24.21.0 上验证）。

```bash
node --check index.js        # 服务端入口语法
node --check client.js       # 浏览器入口语法
node selftest.mjs            # 离线单元自检：37 项
node tools/smoke.mjs         # 真实 HTTP + 真实 git 的端到端冒烟（13 项）
node tools/client-smoke.mjs  # 用假 React/假 fetch 真渲染组件（9 项）
node tools/embed-css.mjs     # 改完 ui.css 后把样式内联进 client.js
node tools/embed-css.mjs --check   # 校验 client.js 内联 CSS 与 ui.css 同步
```

- `selftest.mjs`：不联网、不执行 git、不写仓库。假 deps 注入，覆盖路径校验（越界/相对路径/控制字符）、
  git 输出解析（分支、porcelain 计数、`%cI%n%s`）、空目录、根目录不存在、junction 越界、HTML 转义。
- `tools/smoke.mjs`：伪造 `ctx`/`webServer`，把插件注册的 handler 挂到 `127.0.0.1` 临时端口，
  用 `fetch` 真请求 `/projects`、`/status`、`/config`（含非法输入 400/405）、`/export.html`、别名路由。
  配置指向 `.tmp/smoke-config.json`，不会改你的真实配置。
- `tools/client-smoke.mjs`：不依赖浏览器与真实 React，验 `settings.section` 注册参数、卡片字段、
  空状态、失败态、别名回退，以及「仓库内容按文本节点渲染」。

### 目录结构

```
dsh-opensource-board/
├─ index.js                服务端：路由注册、配置读写、git 调用、缓存
├─ client.js               浏览器端：设置页「开源项目」一栏（CSS 已内联）
├─ ui.css                  样式源文件（由 tools/embed-css.mjs 内联进 client.js）
├─ lib/
│  ├─ path-safety.mjs      路径规范化 / 前缀校验 / 根目录白名单
│  ├─ project-info.mjs     文本清洗、git 输出解析、HTML 转义、HTML 报表
│  └─ discover.mjs         扫描根目录、找 .git 子目录、并发读取仓库信息
├─ locale/{zh,en}.json     文案
├─ cordis.patch.yml        DSH bundle 插入声明
├─ selftest.mjs            离线自检
├─ tools/{smoke,client-smoke,embed-css}.mjs
├─ README.md / LICENSE / .gitignore
```

---

## 已知限制

- **必须在 DSH 重启后生效**：服务端插件不会热加载。
- **只扫一层**：`<根目录>/<项目>/.git`，不递归找多层嵌套仓库。
- **`/api` 前缀的所有权未确认**：宿主安装包是打包过的 asar，读不到路由实现，所以本插件
  额外提供 `/dsh-opensource-board` 别名并让前端自动回退。若宿主确实占用 `/api`，主路由注册可能被拒，
  别名仍然工作。
- **配置没有宿主级 schema**：已装插件都是自己管一个 JSON 文件，本插件沿用这一做法；
  如果 DSH 之后提供官方配置 API，这里可以换过去。
- **git 命令 8 秒超时**：网络盘上的超大仓库可能读超时，此时该项目的 `errors` 字段会有说明，其他项目不受影响。
- 未在 DSH GUI 里做人工截图验收（需要改本机 profile 并重启 DSH）；组件渲染是用
  `tools/client-smoke.mjs` 的无头冒烟验证的。

---

## License

MIT © 2026 a307608689-afk
