/**
 * dsh-session-share — Host 半自测。
 *
 * 用 mock ctx（tools/harness.mjs）把 `webServer.register` 截下来直接打端点，
 * 跑的是与运行中的 DSH 完全相同的那份代码。会话数据是**现造的 fixture**：
 * 一个临时 DSH_HOME，里面放一份未压缩的 `session.v4.jsonl`（不用 zstd，
 * 免得测试依赖运行时有没有 zstd 支持）和一颗内容寻址的附件对象。
 *
 * 运行：node test-host.mjs
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let pass = 0;
let failed = 0;
const check = (label, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${extra === undefined ? "" : ` -> ${extra}`}`);
  }
};

/* ---- fixture ------------------------------------------------------------- */
const home = await mkdtemp(join(tmpdir(), "dsh-session-share-test-"));
const SESSION_ID = "session-test-0001";
const SLUG = "--C-Users-test-project--";
const sessionDir = join(home, "sessions", SLUG, SESSION_ID);
await mkdir(sessionDir, { recursive: true });

/** 1x1 透明 PNG —— 只要是真字节就够，测的是「有没有被读出来并内嵌」。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

/** 会话工作目录：正文里按路径引用的图片必须落在这里面（别的路径一律不打包）。 */
const WORKSPACE = join(home, "workspace");
await mkdir(join(WORKSPACE, "crops"), { recursive: true });
await writeFile(join(WORKSPACE, "crops", "sign.jpg"), PNG);
/** 工作目录**之外**的图片：用来验证越界引用会被拒。 */
await writeFile(join(home, "outside.jpg"), PNG);

const IMAGE_SHA = "a".repeat(64);
const TEXT_IMAGE_SHA = "b".repeat(64);
const imageDir = join(home, "attachments", "v1", "objects", IMAGE_SHA.slice(0, 2));
await mkdir(imageDir, { recursive: true });
const textImageDir = join(home, "attachments", "v1", "objects", TEXT_IMAGE_SHA.slice(0, 2));
await mkdir(textImageDir, { recursive: true });
await writeFile(join(imageDir, IMAGE_SHA), PNG);
await writeFile(join(textImageDir, TEXT_IMAGE_SHA), PNG);

const record = (seq, type, data, time = 1790000000000 + seq * 1000) => ({ type, seq, time, data });

/** 正文里的图片引用（含尖括号写法、越界引用、以及围栏内的"假引用"）。 */
const REFERENCE_TEXT = [
  "结论如下：",
  "",
  "![招牌区域](<crops/sign.jpg>)",
  "",
  "![越界引用](../outside.jpg)",
  "",
  `![绝对路径越界](${join(home, "outside.jpg")})`,
  "",
  "```md",
  "![示例](crops/sign.jpg)",
  "```",
  ""
].join("\n");

const records = [
  { type: "session", version: 4, id: SESSION_ID, createdAt: 1789999999000, cwd: WORKSPACE, agentPreset: "cordis" },
  record(0, "permission/preset", { preset: "workspace-write" }),
  record(1, "session/title", { title: "测试 会话标题", messageSeqs: [2] }),
  record(2, "user/message", {
    role: "user",
    id: "m-1",
    content: [
      { type: "image", attachment: { attachmentId: `sha256:${IMAGE_SHA}`, mediaType: "image/png", name: "shot.png" } },
      { type: "text", text: "帮我看看这个崩溃日志" }
    ]
  }),
  // DSH 自动注入的上下文：默认不该出现在分享内容里
  record(3, "user/message", {
    role: "user",
    id: "m-2",
    content: [{ type: "text", text: "<system-reminder>\nInstructions from: ~/.dsh/AGENTS.md\n## 通用\n- 说中文\n</system-reminder>" }]
  }),
  record(4, "assistant/message", {
    turn: 1,
    step: 1,
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "先看日志再动手。草稿里写 ![不该被解析](crops/sign.jpg) 也不算引用。" },
        { type: "text", text: "我来看一下。" },
        { type: "tool-call", id: "call-1", name: "read", arguments: "{\"file_path\":\"C:/tmp/a.log\"}" }
      ]
    }
  }),
  record(5, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      role: "tool",
      toolCallId: "call-1",
      isError: false,
      content: [{ type: "text", text: `${"很长的输出 ".repeat(900)}\n结束` }]
    }
  }),
  // 工具结果里的图片（read_image 之类）：必须真的画进产物，而不是只被打包
  record(6, "assistant/message", {
    turn: 1,
    step: 2,
    message: {
      role: "assistant",
      content: [{ type: "tool-call", id: "call-2", name: "read_image", arguments: "{\"file_path\":\"crops/sign.jpg\"}" }]
    }
  }),
  record(7, "tool/result", {
    turn: 1,
    step: 2,
    message: {
      role: "tool",
      toolCallId: "call-2",
      isError: false,
      content: [
        { type: "text", text: "<path>crops/sign.jpg</path>\n<type>image</type>" },
        { type: "image", attachment: { attachmentId: `sha256:${TEXT_IMAGE_SHA}`, mediaType: "image/png", name: "sign.png" } }
      ]
    }
  }),
  // 正文里按路径引用的工作区图片：能解析的要打包，越界的要拒绝，围栏里的不算
  record(8, "assistant/message", {
    turn: 1,
    step: 3,
    message: { role: "assistant", content: [{ type: "text", text: REFERENCE_TEXT }] }
  }),
  record(9, "command/run", { commandId: "cmd-1", name: "permission", args: " read-only" }),
  record(10, "session/end-seed", { inherited: false }),
  // 未知类型：必须被计入 skippedTypes 而不是渲染成垃圾
  record(11, "future/unknown-event", { anything: true })
];
// 坏行：只计数，不该让整次导出失败
const raw = `${records.map((row) => JSON.stringify(row)).join("\n")}\n{ 这不是 JSON\n`;
await writeFile(join(sessionDir, "session.v4.jsonl"), raw, "utf8");

// 第二个会话：新建的空会话（没有工件）—— 用来验证「没内容可分享」的提示
await mkdir(join(home, "sessions", SLUG, "session-test-empty"), { recursive: true });

process.env.DSH_HOME = home;
// 自测不弹窗口：只算命令，不真的拉起资源管理器 / 编辑器（见 README「已知边界」）
process.env.DSH_SESSION_SHARE_NO_SPAWN = "1";
const { call, health, flushLogs } = await import("./tools/harness.mjs");

/* ---- 端点 ---------------------------------------------------------------- */
console.log("\n[health]");
const info = await health();
check("health 报出 sessionsRoot", info.sessionsRoot === join(home, "sessions"));
check("health 报出默认导出目录（绝对路径）", typeof info.defaultDir === "string" && info.defaultDir.length > 2);
check("health 声明需要调用头", String(info.requiresCallHeader).includes("x-dsh-plugin-call"));

console.log("\n[门禁]");
const blocked = await call("POST", "/preview", { sessionId: SESSION_ID }, { headers: null });
check("没有调用头 -> 403", blocked?.ok === false && blocked.code === "forbidden", JSON.stringify(blocked));

console.log("\n[清单]");
const list = await call("GET", "/sessions?limit=10");
const listed = (list.result?.sessions ?? []).find((row) => row.sessionId === SESSION_ID);
check("清单里能找到 fixture 会话", listed !== undefined);
check("清单读出了标题", listed?.title === "测试 会话标题", listed?.title);
check("清单读出了消息条数", listed?.messages === 5, String(listed?.messages));

console.log("\n[预览]");
const preview = await call("POST", "/preview", { sessionId: SESSION_ID });
check("预览成功", preview?.ok === true, JSON.stringify(preview)?.slice(0, 200));
const result = preview.result;
check("标题来自 session/title", result.meta.title === "测试 会话标题", result.meta.title);
check("模型/工作目录带上了", result.meta.cwd === WORKSPACE, result.meta.cwd);
check("统计：1 条用户消息（注入的那条被滤掉）", result.stats.userMessages === 1, String(result.stats.userMessages));
check("统计：滤掉 1 条注入上下文", result.stats.injectedDropped === 1, String(result.stats.injectedDropped));
check("统计：2 次工具调用 / 2 条工具结果", result.stats.toolCalls === 2 && result.stats.toolResults === 2,
  `${result.stats.toolCalls}/${result.stats.toolResults}`);
check("统计：2 张附件图片", result.stats.images === 2, String(result.stats.images));
check("坏行被计数", result.stats.malformed === 1, String(result.stats.malformed));
check("未知类型进 skippedTypes", result.stats.skippedTypes["future/unknown-event"] === 1);
check("预览里没有 system-reminder", !result.sample.includes("system-reminder"));
check("预览带默认目录", typeof result.defaultDir === "string" && result.defaultDir.length > 2);
check("预览给的是片段而不是全文", result.sample.length <= 8000 && result.sampleTruncated === false);
// 正文里按路径引用的图片：能解析的 1 处（`<crops/sign.jpg>`），越界的 2 处被拒
check("统计：正文图片引用 3 处（围栏里的不算）", result.textImageRefs === 3, String(result.textImageRefs));
check("正文引用：打包 1 张", result.textImagesResolved === 1, String(result.textImagesResolved));
check("正文引用：越界的 2 处被跳过并如实报出", result.textImagesSkipped === 2
  && result.textImageSkippedTargets.includes("../outside.jpg"));
check("预览里改写成了打包后的相对路径",
  /!\[招牌区域\]\(<[^>]*\.assets\/ref-01-sign\.jpg>\)/.test(result.sample), result.sample.match(/!\[招牌区域\][^\n]*/)?.[0]);
check("越界引用原样留在正文里（不静默改）", result.sample.includes("../outside.jpg"));

const kept = await call("POST", "/preview", { sessionId: SESSION_ID, includeInjected: true });
check("打开开关后注入上下文保留", kept.result.stats.userMessages === 2 && kept.result.stats.injectedDropped === 0);
check("保留时明确标注「自动注入」", kept.result.sample.includes("自动注入"));

const chat = await call("POST", "/preview", { sessionId: SESSION_ID, scope: "chat" });
check("仅对话模式：没有工具调用小节", !chat.result.sample.includes("🔧"), chat.result.sample.slice(0, 200));
check("仅对话模式：没有思考过程小节", !chat.result.sample.includes("思考过程"));
check("仅对话模式：正文还在", chat.result.sample.includes("帮我看看这个崩溃日志"));
// 回归：同一轮的助手是**分步**落消息的，逐条渲染会留下一串只有标题+时间的空壳
// （`## 🤖 助手 / <sub>…</sub> / ---`）。仅对话要把同一轮合成一段，空分段整段不出现。
check("仅对话：同一轮的助手分步消息合并成一段",
  (chat.result.sample.match(/## 🤖 助手/g) ?? []).length === 1,
  String((chat.result.sample.match(/## 🤖 助手/g) ?? []).length));
check("仅对话：合并后两段正文都在",
  chat.result.sample.includes("我来看一下。") && chat.result.sample.includes("结论如下："));
check("仅对话：没有「空标题 + 分隔线」的空壳小节",
  !/## (?:🤖 助手|🧑 用户)\n\n<sub>[^\n]*<\/sub>\n\n---/.test(chat.result.sample),
  chat.result.sample.match(/## 🤖 助手\n\n<sub>[^\n]*<\/sub>[\s\S]{0,24}/)?.[0]);
const fullAgain = await call("POST", "/preview", { sessionId: SESSION_ID, scope: "full" });
check("完整记录保持逐步（不合并）",
  (fullAgain.result.sample.match(/## 🤖 助手/g) ?? []).length === 3,
  String((fullAgain.result.sample.match(/## 🤖 助手/g) ?? []).length));

console.log("\n[Markdown]");
const markdown = await call("POST", "/markdown", { sessionId: SESSION_ID });
check("拿到 Markdown 全文", markdown?.ok === true && markdown.result.markdown.startsWith("# 测试 会话标题"));
check("附件图片按 .assets 相对路径引用", /!\[shot\.png\]\(<[^>]*\.assets\/img-01-shot\.png>\)/.test(markdown.result.markdown),
  markdown.result.markdown.match(/!\[shot\.png\][^\n]*/)?.[0]);
// 回归 1：工具结果里的图片早先只被打包、从不渲染，于是产物里躺着 base64 却一张都看不到
check("工具结果里的图片被真的放进正文", /!\[sign\.png\]\(<[^>]*\.assets\/img-02-sign\.png>\)/.test(markdown.result.markdown),
  markdown.result.markdown.match(/!\[sign\.png\][^\n]*/)?.[0]);
// 回归 2：正文里按路径引用的工作区图片要改写并打包
check("正文引用的工作区图片被改写", /!\[招牌区域\]\(<[^>]*\.assets\/ref-01-sign\.jpg>\)/.test(markdown.result.markdown),
  markdown.result.markdown.match(/!\[招牌区域\][^\n]*/)?.[0]);
check("围栏里的示例引用不被改写", markdown.result.markdown.includes("![示例](crops/sign.jpg)"));
check("命令记录留痕", markdown.result.markdown.includes("/permission read-only"));
check("长正文没把围栏撑破", (markdown.result.markdown.match(/^`{3,}/gm) ?? []).length % 2 === 0);
// 回归 4：默认**不截断**（早期默认把工具结果/参数截到 4000/1200，用户看到的是残缺记录）
const LONG_RESULT = `${"很长的输出 ".repeat(900)}\n结束`.trim();
check("默认不截断：长工具结果原样在", markdown.result.markdown.includes(LONG_RESULT),
  String(markdown.result.markdown.length));
check("默认不截断：没有任何截断标记", !markdown.result.markdown.includes("已截断"));
const capped = await call("POST", "/markdown", { sessionId: SESSION_ID, maxToolChars: 100 });
check("显式传 maxToolChars 时才截断", capped.result.markdown.includes("已截断，原文")
  && !capped.result.markdown.includes(LONG_RESULT));
check("截断时元信息写明上限", capped.result.markdown.includes("超过 100 字符的部分按截断处理"));
check("不截断时元信息不写截断那行", !markdown.result.markdown.includes("按截断处理"));
// 回归 3：资源目录名可能带空格/括号，裸写会让 CommonMark 在空格处断开
check("含空格的链接目标用尖括号包住", markdown.result.markdown.includes("](<") && !/\]\([^)<>\n]*\s[^)\n]*\)/.test(markdown.result.markdown),
  markdown.result.markdown.match(/\]\([^)]*\s[^)]*\)/)?.[0] ?? "(无裸空格目标)");

console.log("\n[导出]");
const outDir = join(home, "out");
const md = await call("POST", "/export", { sessionId: SESSION_ID, format: "md", dir: outDir });
check("导出 md 成功", md?.ok === true, JSON.stringify(md)?.slice(0, 200));
const mdFile = md.result.files.find((file) => file.kind === "markdown");
const mdFolder = join(outDir, md.result.baseName);
const assetsDir = join(mdFolder, `${md.result.baseName}.assets`);
check("md 文件真的落盘了", existsSync(mdFile.path));
check("md 与 .assets 都装进新建的同名文件夹", md.result.folder === mdFolder && dirname(mdFile.path) === mdFolder
  && dirname(assetsDir) === mdFolder, `${md.result.folder} / ${assetsDir}`);
check("附件图片落进同名 .assets 目录", existsSync(join(assetsDir, "img-01-shot.png")));
check("工具结果里的图片也落盘了", existsSync(join(assetsDir, "img-02-sign.png")));
check("正文引用的工作区图片被复制进 .assets", existsSync(join(assetsDir, "ref-01-sign.jpg")));
check("文件内容与 /markdown 一致", (await readFile(mdFile.path, "utf8")) === markdown.result.markdown);
check("导出结果如实说明图片未内嵌", md.result.imagesEmbedded === false
  && md.result.imagesWritten === 3 && md.result.imageCount === 3, JSON.stringify({
  written: md.result.imagesWritten, count: md.result.imageCount
}));
check("导出结果报出越界引用数", md.result.textImagesSkipped === 2 && md.result.textImagesResolved === 1);

const again = await call("POST", "/export", { sessionId: SESSION_ID, format: "md", dir: outDir });
check("同名不覆盖，顺延 (2)", again.result.baseName === `${md.result.baseName} (2)`, again.result.baseName);
check("顺延的是整个文件夹（不是往里塞同名文件）", again.result.folder === join(outDir, `${md.result.baseName} (2)`)
  && existsSync(join(again.result.folder, `${again.result.baseName}.md`)));
check("两次导出各自成文件夹", (await readdir(outDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).length === 2);

const html = await call("POST", "/export", { sessionId: SESSION_ID, format: "html", dir: outDir });
const htmlFile = html.result.files.find((file) => file.kind === "html");
const htmlText = await readFile(htmlFile.path, "utf8");
check("导出 html 成功", html?.ok === true && existsSync(htmlFile.path));
check("单文件 HTML 内嵌图片", htmlText.includes("data:image/png;base64,"));
check("HTML 里说明了图片内嵌", html.result.imagesEmbedded === true && html.result.imagesWritten === 0);
// 一次导出里「有几张图」和「文档里有几个 <img>」必须对上：
// 早先正文里明明有 3 张图，页面里却只有 1 个 <img>（图和规划都在，就是没画出来）。
const imgCount = (htmlText.match(/<img /g) ?? []).length;
const figureCount = (htmlText.match(/<figure>/g) ?? []).length;
check("每张图片都在 HTML 里画出来了", imgCount === html.result.imageCount && figureCount === imgCount,
  `img=${imgCount} figure=${figureCount} imageCount=${html.result.imageCount}`);
check("HTML 里没有「图片未打包/未内嵌」的占位", !htmlText.includes("图片未"));
check("HTML 转义了尖括号", htmlText.includes("&lt;system-reminder&gt;") || !htmlText.includes("<system-reminder>"));
check("HTML 自带样式与折叠", htmlText.includes("<style>") && htmlText.includes("<details>"));

console.log("\n[错误路径]");
const relative = await call("POST", "/export", { sessionId: SESSION_ID, format: "md", dir: "relative/path" });
check("相对目录被拒（400）", relative?.ok === false && relative.code === "bad-request", JSON.stringify(relative));
const missing = await call("POST", "/preview", { sessionId: "session-does-not-exist" });
check("会话不存在（404）", missing?.ok === false && missing.code === "not-found");
const empty = await call("POST", "/preview", { sessionId: "session-test-empty" });
check("空会话（409 + 明确提示）", empty?.ok === false && empty.code === "empty", JSON.stringify(empty));
const badId = await call("POST", "/preview", { sessionId: "../../etc/passwd" });
check("非法会话 id 被拒（400）", badId?.ok === false && badId.code === "bad-request");
const notFound = await call("GET", "/nope");
check("未知端点 404", notFound?.ok === false);

console.log("\n[reveal 白名单与打开链]");
const foreign = await call("POST", "/reveal", { path: join(home, "sessions") });
check("没导出过的路径不给定位（403）", foreign?.ok === false && foreign.code === "forbidden", JSON.stringify(foreign));
const traversal = await call("POST", "/reveal", { path: join(outDir, "..", "..", "sessions") });
check("绕过目录的路径也不给（403）", traversal?.ok === false && traversal.code === "forbidden");

// 允许的路径：测试环境设了 DSH_SESSION_SHARE_NO_SPAWN=1，只算命令不拉窗口
const select = await call("POST", "/reveal", { path: mdFile.path, mode: "select" });
check("定位导出过的文件：返回实情", select?.ok === true, JSON.stringify(select)?.slice(0, 200));
check("只算命令、不真的拉窗口（自测不弹窗）", select.result?.via === "spawn" && select.result?.spawned === false,
  JSON.stringify(select.result));
check("Windows 定位用 explorer /select,", process.platform !== "win32"
  || (select.result?.command === "explorer.exe" && select.result?.mode === "select"),
  JSON.stringify(select.result));
// 回归：`/select,<路径>` 遇空格会被 libuv 把**整个参数**（含开关）加引号，Explorer 认不出
// 开关、退去打开默认目录（带 ` (2)` 的导出目录实测会打开"文档"）。
// 必须 `/select,"<路径>"` + 原样传参：引号只包路径。
check("定位参数把引号只包在路径上", process.platform !== "win32"
  || select.result?.args?.[0] === `/select,"${mdFile.path}"`,
  JSON.stringify(select.result?.args));
check("定位参数原样传给 explorer（不让 libuv 再加工）", process.platform !== "win32"
  || select.result?.verbatim === true, String(select.result?.verbatim));
// 回归：原来用 `rundll32 url.dll,FileProtocolHandler` 打开文件，实测对中文/空格路径
// **静默失败**（用户看到的就是"点了没反应"）；`explorer.exe <文件>` 实测能拉起关联程序。
const open = await call("POST", "/reveal", { path: mdFile.path, mode: "open" });
check("打开文件：命令行方式不谎报成功",
  open?.ok === true && open.result?.via === "spawn" && open.result?.opened === undefined,
  JSON.stringify(open.result));
check("Windows 打开文件用 explorer.exe（不是 rundll32）", process.platform !== "win32"
  || (open.result?.command === "explorer.exe" && open.result?.mode === "open"),
  JSON.stringify(open.result));
const missingPath = await call("POST", "/reveal", { path: join(mdFolder, "不存在.md") });
check("路径不存在（404）", missingPath?.ok === false && missingPath.code === "not-found");

console.log("\n[fixture 没被弄脏]");
check("会话工件仍是 fixture 内容", (await stat(join(sessionDir, "session.v4.jsonl"))).size === Buffer.byteLength(raw, "utf8"));
flushLogs();

await rm(home, { recursive: true, force: true });

console.log(`\n${pass}/${pass + failed} 通过`);
process.exitCode = failed === 0 ? 0 : 1;
