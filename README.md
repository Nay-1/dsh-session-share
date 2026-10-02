# dsh-session-share

给 [DeepSeek Harness](https://github.com/) 侧栏「会话行 ⋯ 菜单」加一项 **分享会话** —— 位置在「归档会话」和兄弟插件的「删除会话」之间。

点开后是一个面板：选内容范围 → 看预览 → **复制 Markdown** / **导出 .md** / **导出单文件 HTML**。整个插件**只读**：除了往你选的目录里写导出文件，不碰任何 DSH 数据。

## 它加在哪

菜单就是插槽 `sidebar.workspaces.session.menu.item`，内置四项的 `order` 是：

| 条目 | 来源 | order |
|---|---|---|
| 置顶会话 | 内置 | 100 |
| 重命名 | 内置 | 200 |
| 分叉会话 | 内置 | 300 |
| 归档会话 | 内置 | 400 |
| **分享会话** | **本插件** | **450** |
| 删除会话 | [dsh-session-menu-delete](../dsh-session-menu-delete/README.md) | 500 |

450 是刻意的：分享是**只读**动作，排在破坏性动作前面。图标用 primitives 的 `IconShareOutlineRegular`（与内置菜单项同一套）。

面板本体注册在框架级浮层 `shell.overlay` 上（`id: session-share.panel`），由 primitives 的 `Modal` 渲染 —— 所以菜单一关、侧栏一滚，面板都不受影响；`Escape` 与点遮罩关闭、焦点归位都由它接管。

## 面板里的四件事

| 控件 | 说明 |
|---|---|
| **内容范围** | `完整记录`（用户/助手 + 思考过程 + 工具调用与结果）／`仅对话`（只有用户与助手的正文）。切换即重新取预览 |
| **包含 DSH 自动注入的上下文** | 默认**关**。打开后 `system-reminder`（工作区指令）、运行环境快照这类注入消息会被保留，并明确标注「由 DSH 自动注入」 |
| **预览** | 与导出**同一份** Markdown 的前 8000 字符（同一段代码渲染，所见即所得）。框高**固定 240px**、内容自己滚，切换范围时面板不会上下抽动 |
| **保存目录** | 默认 `下载` → `桌面` → 家目录（取第一个存在的）；可改，改完记在 `localStorage` 里下次直接用 |

三个动作分别是 `复制 Markdown`（走 `writeClipboard`，带 `execCommand` 兜底）、`导出 .md`、`导出 HTML`。导出完面板下方会多出 `复制路径` / `打开所在文件夹` / `打开文件`。

### 切换内容范围为什么不"闪"

第一版每次切换都 `data: undefined` + 切 loading，于是：预览塌成一行「读取中…」、面板高度猛跳、三个按钮一起 `disabled`（主按钮 `opacity:.4` 尤其明显），响应回来再弹回去 —— 观感就是"屏幕闪一下"。现在三条一起改掉：

1. **保留旧内容**（stale-while-revalidate）：换范围只是在旧预览上压一层 `data-stale`（透明度 `.5` + 150ms 过渡）当进度提示，内容不消失、文案不跳动；只有**换会话**才清空（旧会话的预览留在新会话窗口里是错的）。
2. **预览框固定 240px 高**：`完整记录` 与 `仅对话` 的正文长度差很多，高度跟着内容走就会每切一次跳一次。超出由内容区滚动，卡片高度交给内置 Modal 的 `max-height` 约束。
3. **切换期间不禁用按钮**：只要有可用预览就不 `disabled`，禁用只留给"还没有任何内容"和"有动作正在跑"。范围重新取预览期间点导出是安全的 —— 请求体里带的就是**新的** scope。

按钮文案在忙碌时会从「导出 .md」变「处理中…」，所以页脚按钮统一给了 `min-width`：右对齐的一排不会因为某个按钮变宽而整体左右挪动。

## 会导出成什么

### Markdown（`.md`）

**产物是一个新建的同名文件夹**，正文与图片一起装在里面 —— 分享时整个文件夹拖走就是完整一份，不会在下载目录里散成"一个 .md + 一个图片夹"两半：

```
下载/会话标题-20261002-1830/
├─ 会话标题-20261002-1830.md          ← 正文（图片按相对路径引用）
└─ 会话标题-20261002-1830.assets/     ← 图片：附件图 + 工具结果图 + 正文引用的工作区图
   ├─ img-01-image.png
   └─ ref-01-01_signboard.jpg
```

同名不覆盖：文件夹名已被占就顺延 `(2)`、`(3)`（顺延的是**整个文件夹**，不是往里塞同名文件）。HTML 是单文件，不建文件夹。

正文结构：

```markdown
# 会话标题

> 由 **DeepSeek Harness** 导出的会话记录
- 会话 ID：`session-…`
- 模型：`provider/model`
- 工作目录：`C:\…`
- 创建时间：… · 导出时间：…
- 规模：N 条用户消息 · M 条助手回复 · K 次工具调用 · J 张图片
- 内容范围：完整记录

---

## 🧑 用户

<sub>2026-10-02 18:30:26</sub>

![image.png](会话标题-20261002-1830.assets/img-01-image.png)

（正文原样）

---

## 🤖 助手

<details>
<summary>💭 思考过程（125 字符）</summary>

（推理正文）

</details>

<details>
<summary>🔧 pwsh · List workspace contents</summary>

```json
{ "command": "…" }
```

**结果**

```text
（工具输出）
```
</details>
```

图片会**复制**到同目录的同名资源文件夹 `<文件名>.assets/`，正文里用相对路径引用 —— 整个目录拷给别人就能直接看。链接目标含空格或括号时（资源目录名取自会话标题，很容易带空格）会自动用 `<...>` 包住：裸写的话 CommonMark 会在空格处断开，图直接不显示。

### 图片有三个来源，都要处理

| 来源 | 例子 | 怎么拿到 |
|---|---|---|
| **附件对象** | 用户贴的图、`read_image` 读进来的图 | 记录里的 `attachmentId`（`sha256:…`），内容寻址对象在 `<DSH_HOME>/attachments/v1/objects/<前2位>/<sha256>` |
| **工具结果里的图** | `read_image` 的返回块 | 与上面同一套附件对象，挂在 `tool/result` 上 |
| **正文里按路径引用的图** | agent 写报告时的 `![招牌区域](.tmp-image-analysis/crops/01_signboard.jpg)` | 对话正文里的文本，**要按会话工作目录解析** |

第三类是"我明明写了图，导出后却没有"的根源：它不是 DSH 的结构化附件，导出侧得自己去解析路径并复制文件。规则（都写死在 host 半）：

- 只能引用**会话工作目录（`session` header 的 `cwd`）以内**的文件：相对路径按 cwd 解析，绝对路径也必须在 cwd 之内，`..` 越界、`http:` / `data:` / `file:` / 网络路径一律不认；
- 只认图片扩展名（png/jpg/jpeg/gif/webp/bmp/svg），单张 ≤ 20 MB，整篇最多 50 张；
- **围栏代码块里的 `![](...)` 不算引用**（示例代码不是图），`reasoning`（思考过程）与工具结果正文里的也不算 —— 那些地方是原文照登的，改了反而失真；
- 解析不了的引用**原样留在正文里**，不静默删掉，同时在结果里报数（`textImagesSkipped`），面板状态行也会写「另有 N 处正文图片引用不在会话工作目录内，未打包」。

### 单文件 HTML（`.html`）

自包含：样式内联、图片内嵌成 `data:` URI、深浅色跟随系统、思考与工具调用用 `<details>` 折叠（带「展开全部／折叠全部」）。**双击就能在浏览器里看，发给别人也只需要这一个文件。**

图片总量超过 25 MB 时不再内嵌（避免生成一个打不开的巨型文件），改为写同名 `.assets/` 目录 + 相对引用，并在面板与 API 结果里如实说明 —— 不会出现"一半内嵌一半外链"的怪文件。

### 截断：默认**不截断**

导出的就是原样，一个字都不省。要截断得显式要求：API 传 `maxToolChars` / `maxReasoningChars` / `maxArgumentChars`（三者都收 `N` 字符，`0` = 不截断），或 CLI 加 `--max-chars N`；截断时超限部分以「…（已截断，原文 N 字符）」收尾，元信息里也会写明上限。

> 早期版本默认把工具结果/思考截到 4000、工具参数截到 1200，理由是"单条 5 万字符的 JSON 插在对话中间没人看得下去"。那是我替用户做的取舍，而"我要完整记录"是更常见的诉求 —— 现在默认全量，代价是导出可能到 MB 级。

**另有一种截断不是本插件做的**：DSH 自己会把超大的工具输出 spill 到临时文件，日志里只留约 50 KB，并写上一句

```
(Omitted 14469 bytes. Full formatted result stored at C:\...\Temp\dsh-spill-...txt.)
```

那句话**是会话记录本身的内容**，原文根本不在日志里 —— 导出侧无从恢复（除非去读那个临时文件，那是另一个安全面，本插件不碰）。所以看到这句时，缺的那部分不是分享插件吃掉的。

## 内容取舍

会话日志是 DSH 的内部格式，版本之间会加新事件。这里**只认白名单**，其余一律跳过并计数（`stats.skippedTypes`）：渲染未知类型成垃圾，比不渲染更糟；留下计数，出问题时能一眼看出漏了什么。

| 记录类型 | 处理 |
|---|---|
| `user/message` / `developer/message` | 用户消息（含图片附件） |
| `assistant/message` | 助手正文 + 思考过程 + 工具调用 |
| `tool/result` | 按 `toolCallId` 挂到对应的工具调用上；失败结果标「失败」 |
| `command/run` | 人类敲的斜杠命令（`/permission read-only` 之类）留一行痕迹 |
| `session/title`、`model/selection`、`request/header`、`request/context`、`session` | 只取标题 / 模型 / 工作目录等元信息 |
| 类型里带 `compaction` 的 | 留一行「此处发生上下文压缩」——模型侧已被摘要替换，人类可读的记录还在，不标出来读者会以为模型当时看得到全部上下文 |
| 其它一切（`step/*`、`turn/*`、`system/message`、`approval/*`、`session/end-seed`…） | 跳过，计数 |

两条额外的规矩：

- **DSH 自动注入的上下文默认滤掉**：`<system-reminder>`、`Current runtime context.`、文件策略／审批策略这类消息是发给模型的输入、不是用户说的话 —— 直接分享出去会让读者误以为是用户写的，还会把本机的策略与路径散出去。判定要求「整条消息都是纯文本且以已知标记开头」，真实用户消息（可能带附件、正文里也可能引用这些字样）不会误伤。
- **坏行只计数**：工件是多帧 zstd 拼接的文本，一行脏数据不该废掉整次导出（`stats.malformed`）。

## HTTP 端点

**所有端点都要求一个调用头 `x-dsh-plugin-call: 1`，缺了或者值不对一律 `403`。**

理由与兄弟插件相同：插件的前缀路由**不经 DSH 的鉴权网关**（实测 DSH 自身路由 `GET /` → 401，插件路由 `GET …/api/health` → 200），handler 也不看 `Origin` / `Content-Type`。没有这道门时，你浏览器里打开的**任意网页**都能 POST 进来让本插件往磁盘写文件（网页用 `Content-Type: text/plain` 发 POST 属于"简单请求"，不触发 CORS 预检）。要一个自定义头即可封死：自定义头必然触发预检，而本服务从不返回 CORS 头 → 预检失败 → 网页发不出去。同源 fetch（client 半）与本地脚本带头即可。

| 方法与路径 | 作用 |
|---|---|
| `GET /session-share/api/health` | 存活检查：各根目录、默认导出目录、截断上限、调用头要求 |
| `GET /session-share/api/sessions?limit=N` | 最近改动的会话清单（id / 标题 / 时间 / 条数），给 CLI 与排查用 |
| `POST /session-share/api/preview` | `{ sessionId, scope?, includeInjected?, sampleChars? }` → 统计 + Markdown 前 8000 字符 |
| `POST /session-share/api/markdown` | 同上 → **完整** Markdown（复制到剪贴板走这条） |
| `POST /session-share/api/export` | `{ sessionId, scope?, format: 'md'\|'html', dir?, maxToolChars? }` → 落盘（md 建同名文件夹），返回 `folder`、文件路径与图片去向 |
| `POST /session-share/api/reveal` | `{ path, mode?: 'select'\|'open' }` → 在资源管理器里定位／用默认程序打开 |

`reveal` 有一道白名单：**只能定位本次进程导出过的路径**（或它所在目录），否则 `403` —— 不让它变成一个「用插件拉起任意本地路径」的口子。

## 命令行工具（`tools/`）

`tools/export.mjs` **不依赖正在运行的 DSH**：它用 mock 的 cordis ctx 把插件真实的 host 半加载起来，直接调它自己的 HTTP 端点 —— 跑的是与界面完全相同的那份代码，所以改完插件不必等重启就能验证。`DSH_HOME` 环境变量优先，缺省 `~/.dsh`。

```powershell
node tools/export.mjs --list                       # 最近会话（id / 标题 / 时间 / 条数）
node tools/export.mjs <sessionId> --preview        # 只看预览，不落盘
node tools/export.mjs <sessionId> --format html --dir D:/share
node tools/export.mjs <sessionId> --scope chat --format md --reveal
node tools/export.mjs <sessionId> --max-chars 4000        # 想截断时才截断（默认不截断）
```

MSYS/Git Bash 下注意：`--dir` 传的是 **host 视角的绝对路径**（`D:/share`、`C:/Users/…`）。

## 安装

```powershell
dsh plugin --profile desktop add "file:<本仓库所在目录的绝对路径>"
```

装完还必须让 DSH 知道要加载它，二选一：

- 在 DSH 的 **「插件」页面**里启用（会写 `dsh.profile.bundles`）；
- 或手工把 `"dsh-session-share"` 加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组。

**改动需要重启 DSH 生效**（bundle 与 client 半都在启动时加载）。

> **`file:` 依赖是「拷贝」安装，pnpm 不会替你刷新这份拷贝。**（`nodeLinker: hoisted`）
> 改完源码后 `add` / `install` / `install --force` 都会回一句 `Already up to date` 并留下**旧副本**；
> 可靠的做法是删掉旧目录后手动同步一次：
>
> ```powershell
> $src = "<本仓库绝对路径>"; $dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-share"
> Remove-Item -Recurse -Force $dst
> Copy-Item -Recurse -Force $src $dst
> Remove-Item -Recurse -Force "$dst\.git"
> ```

卸载：

```powershell
dsh plugin --profile desktop remove dsh-session-share
```

再从 `dsh.profile.bundles` 里删掉 `"dsh-session-share"`，重启 DSH 即完全还原。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | host 半：cordis 插件，HTTP 端点 + 落盘 + 定位产物 |
| `lib/session-log.js` | 会话工件定位与读取（多帧 zstd / jsonl、坏行容错、最近会话清单） |
| `lib/render.js` | 记录 → 转写模型 → Markdown / 单文件 HTML |
| `lib/client.js` | client 半：Module Loader 包（`factory(require)`，无构建步骤），菜单项 + 分享面板 |
| `cordis.patch.yml` | bundle 层 patch：往插件树里 insert 一行 |
| `tools/harness.mjs` | 离线脚手架：mock ctx 加载 host 半，把端点暴露成 `call(method, path, body)` |
| `tools/export.mjs` | 命令行导出 / 预览 / 列会话（`--max-chars` 可选截断） |
| `test-host.mjs` | host 半自测（69 项） |
| `test-client.mjs` | client 半自测（60 项） |

自测跑在**临时 `DSH_HOME` + mock 服务**上，全程不碰真实会话数据（host 侧用例还会校验 fixture 一个字节都没被改动）：

```powershell
node test-host.mjs
node test-client.mjs
```

host 侧的 fixture 是**未压缩**的 `session.v4.jsonl`（不依赖运行时有没有 zstd 支持）+ 真实的附件对象 + 一个真的会话工作目录；覆盖：门禁 403、清单、预览与两种范围、注入上下文过滤与保留、坏行与未知类型计数、Markdown 结构（截断 / 围栏不被正文里的 ``` 撑破 / 含空格目标用 `<>` 包住）、**三种来源的图片**（附件图、工具结果图、正文按路径引用的工作区图）、**越界引用被拒且原样保留**、两种格式落盘、同名顺延、相对目录被拒、空会话、非法 id、reveal 白名单。其中有一条专门盯着"图被打包了却没画出来"这个回归：断言 HTML 里 `<img>` 的数量等于结果里报的图片数。

client 侧用一个几十行的迷你 React 运行时（`useState` / `useEffect` / `useRef` / `useCallback` / `useSyncExternalStore`，按依赖数组决定要不要重跑 effect）把面板**真的渲染出来**：菜单注册与点击链路、预览请求与参数、默认目录回填、导出参数与状态行、`localStorage` 记忆、剪贴板内容、范围切换重新取预览、失败路径的禁用与提示、以及 **primitives 整包缺失时仍能降级渲染不抛错**。

## 已知边界

- **只读**：不删、不改、不碰工作区账本与会话文件；导出只往目标目录新建文件。
- **同名不覆盖**：md 的**文件夹**（或 html 文件）已存在就顺延 `(2)`、`(3)`（分享文件重名很常见，静默覆盖是丢数据）。标题里的 Windows 禁用字符、结尾的点与空格都会被清掉。
- **默认不截断**：长输出原样带走，导出体积可能到 MB 级；要小就传 `maxToolChars` / `--max-chars`。DSH 自己 spill 掉的那部分（日志里写着 `(Omitted N bytes …)`）不在日志里，本插件无从恢复。
- **导出目录必须是绝对路径**：相对路径会相对于 DSH 进程的 cwd 解析（那是用户看不见的目录），与其"成功导出到一个找不到的地方"，不如直接 `400` 拒绝。
- **剪贴板里的 Markdown 不含图片文件**：正文里的图片引用指向 `.assets/` 目录，要图就导出 `.md`（面板与状态行都会说明这一点）。
- **空会话分享不了**：还没落盘任何事件的会话会回 `409` 并提示「这个会话还没有落盘内容」。
- **运行时 `node:zlib` 没有 zstd 支持**（Node < 22.15 / 23.8）时，压缩工件读不出来，会如实报错而不是给一份空文档。未压缩的 `.jsonl` 工件仍然可读。
- **正在被写入的会话也能导出**：读的是落盘快照，可能与界面上的最新一条差几秒。
- **工具输出按字符截断**，不做智能摘要 —— 想看全文就调大上限或直接看原会话。
- **旧会话的投影缓存/滚动副本**：一个会话目录里有多个工件时取**最大的那份**（事件是追加写的，大的更全），不是取文件名排序的第一个。
- `reveal` 依赖系统命令：Windows 用 `explorer.exe /select,` 与 `rundll32 url.dll,FileProtocolHandler`，macOS 用 `open`，Linux 用 `xdg-open`。命令拉起失败只记日志，不影响导出结果。
- client 半在 `MenuItemButton` / `Modal` / `SegmentedControl` / `Checkbox` / `Input` / `Button` / `writeClipboard` 任意一个缺失时都会退回自绘实现，**绝不把 `undefined` 交给 `createElement`**（那会让整个侧栏渲染崩掉，而不是少一个按钮）。
- ⚠️ **探测 primitives 组件不能用 `typeof x === "function"`**：`Button` 与 `Input` 是 `forwardRef(...)` 的产物，运行时是**对象**（`{ $$typeof: Symbol(react.forward_ref) }`），只有函数组件才是 function。早先按 function 探测 → 一律判成"不存在" → 静默走自绘兜底按钮，而兜底里硬编码的 `#fff` 文字撞上深色主题的近白 `--dsw-alias-brand-primary`（深色下 brand-primary 是 `#f9fafb`、前景色才是 `#0f1115`），**那个按钮在深色模式下等于隐形**；浅色下 brand-primary 是近黑，所以只在深色暴露。现在统一走 `reactComponent()`（function / string / `$$typeof` 对象都认），兜底的强调态也改成"描边 + 加粗"而不是实心填充 —— 实心必须与前景色配对，而那对变量在浅色下是"近黑底 + 白字"、深色下是"近白底 + 深字"，硬编码任何一种前景色都会在另一个主题里翻车。测试里有一条 forwardRef 形状的用例守着这个坑。

## License

MIT
