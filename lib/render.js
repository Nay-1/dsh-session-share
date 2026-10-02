/**
 * dsh-session-share — 把会话记录渲染成 Markdown 与单文件 HTML。
 *
 * 输入是工件里的原始记录数组（见 session-log.js），输出是可读的转写：
 *   buildTranscript(records)  → 模型（消息流 + 统计 + 图片清单）
 *   renderMarkdown(model, …)  → { markdown, images }
 *   renderHtml(model, …)      → { html, images }
 *
 * 设计约束（都是踩过的坑）：
 *   - **只认白名单记录类型**，其余一律跳过并计数（`stats.skippedTypes`）。
 *     会话日志是 DSH 的内部格式，版本之间会加新事件；未知类型渲染成垃圾，
 *     比不渲染更糟。跳过的东西留下计数，出问题时能一眼看出漏了什么。
 *   - **压缩要标出来**：上下文压缩（compaction）之后，前面的消息在模型侧已经被
 *     摘要替换了。分享出去的是**人类可读的完整记录**，但压缩点必须留痕，
 *     否则读者会以为模型当时看得到全部上下文。
 *   - **代码围栏要按内容加长**：工具输出里经常带着 ``` 片段，用固定三反引号
 *     会把文档结构撕开，所以围栏长度取「正文里最长反引号串 + 1」。
 *   - **不做 Markdown 转义**：正文是原始对话，转义会把代码和路径改得没法看。
 *     HTML 那条路才做转义（那边是拼字符串，不转义就是 XSS）。
 *   - render 这层**不碰文件系统**：图片由调用方通过 `loadImage` 喂进来，
 *     这样两种产物、离线测试、CLI 都能复用同一份渲染代码。
 */

/**
 * 正文截断上限。**默认 0 = 不截断**：分享出去的应该就是原样。
 *
 * 早期默认截到 4000 字符（理由是"单条 5 万字符的 JSON 插在对话中间没人看得下去"），
 * 但那是我替用户做的取舍，而"我要的是完整记录"是更常见的诉求 ——
 * 现在默认全量，要截断的人显式传值（CLI `--max-chars`、API `maxToolChars`）。
 * 代价是导出体积可能到 MB 级，这是用户自己选的结果。
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** 单条工具结果正文上限（字符）；0 = 不截断。 */
  maxToolChars: 0,
  /** 单段思考正文上限（字符）；0 = 不截断。 */
  maxReasoningChars: 0,
  /** 工具调用参数（JSON）上限；0 = 不截断。 */
  maxArgumentChars: 0
});

const TOOL_ARG_HINTS = ["description", "command", "file_path", "path", "pattern", "query", "prompt", "url"];
const ROLE_HEADING = { user: "🧑 用户", assistant: "🤖 助手" };

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const asText = (value) => (typeof value === "string" ? value : "");

/** 本地时间 `YYYY-MM-DD HH:mm:ss`；短版 `YYYY-MM-DD HH:mm`。 */
export const formatDateTime = (ms, withSeconds = true) => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
};

/** 文件名时间戳 `YYYYMMDD-HHmm`（本地时间）。 */
export const timestampSlug = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

/**
 * 清成能当文件名的字符串。
 * Windows 的禁用字符、控制字符、结尾的点和空格（Win32 会静默丢掉，于是
 * 「导出的路径」和「用户看到的文件名」对不上）都在这里处理掉。
 */
export const sanitizeFilename = (name, fallback = "会话分享") => {
  let text = asText(name)
    // eslint-disable-next-line no-control-regex -- 控制字符正是要清掉的东西
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (text.length > 80) text = text.slice(0, 80).trim();
  return text === "" ? fallback : text;
};

/** 按内容取一段够长的反引号围栏，保证不被正文里的 ``` 截断。 */
const fenceFor = (text) => {
  let longest = 0;
  let run = 0;
  for (const char of asText(text)) {
    if (char === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else run = 0;
  }
  return "`".repeat(Math.max(3, longest + 1));
};

const fenced = (text, language) => {
  const body = asText(text);
  const fence = fenceFor(body);
  return `${fence}${language ?? ""}\n${body.replace(/\n+$/, "")}\n${fence}`;
};

const escapeHtml = (text) => asText(text)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const firstLine = (text, limit = 80) => {
  const line = asText(text).split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/** 一条工具调用的人话摘要：取参数里最像「意图」的那个字段。 */
export const summarizeToolCall = (name, argumentText) => {
  let args;
  try { args = JSON.parse(asText(argumentText)); } catch { args = undefined; }
  if (isObject(args)) {
    for (const key of TOOL_ARG_HINTS) {
      const value = args[key];
      if (typeof value === "string" && value.trim() !== "") return firstLine(value);
    }
    const keys = Object.keys(args);
    if (keys.length > 0) return firstLine(keys.slice(0, 4).join(", "));
  }
  return firstLine(argumentText);
};

/** 工具结果里的图片取个扩展名：优先原文件名，其次 mediaType。 */
const extensionFor = (name, mediaType) => {
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(asText(name));
  if (fromName !== null) return `.${fromName[1].toLowerCase()}`;
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp"
  };
  return map[asText(mediaType).toLowerCase()] ?? ".png";
};

/** 附件的磁盘位置：内容寻址 `<objects>/<前2位>/<sha256>`。形状不对返回 undefined。 */
export const attachmentObjectPath = (objectsRoot, attachmentId) => {
  const hash = asText(attachmentId).replace(/^sha256:/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
  return { hash, file: `${objectsRoot}/${hash.slice(0, 2)}/${hash}`, shard: hash.slice(0, 2) };
};

const normalizeBlocks = (content) => {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => isObject(block) && typeof block.type === "string");
};

/**
 * DSH 会往用户消息流里**注入**上下文：工作区指令（`<system-reminder>`）、
 * 运行环境快照（“Current runtime context.”）、文件策略与审批策略。
 * 它们是发给模型的输入，不是用户说的话 —— 直接分享出去会让读者以为是用户写的，
 * 还会把本机的策略/路径散出去。所以默认**滤掉**，需要时用 `includeInjected` 打开。
 *
 * 判定要求「整条消息都是纯文本且以已知标记开头」：真实用户消息可以带附件、
 * 也可以在正文里引用 system-reminder，不能误伤。
 */
const INJECTED_RE = /^\s*(<system-reminder|Current runtime context\.|Current DSH file policy:|Approval policy:)/;
const isInjectedMessage = (blocks) => {
  if (blocks.some((block) => block.type !== "text")) return false;
  const texts = blocks.map((block) => asText(block.text).trim()).filter((text) => text !== "");
  if (texts.length === 0) return false;
  return INJECTED_RE.test(texts[0]);
};

/**
 * 记录数组 → 转写模型。
 * @param records - 工件里的原始记录（第一条通常是 header）。
 * @param options - `{ malformed }`：坏行计数，原样带进统计里。
 */
export function buildTranscript(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const header = list[0]?.type === "session" ? list[0] : undefined;

  const model = {
    sessionId: asText(header?.id),
    title: "",
    createdAt: typeof header?.createdAt === "number" ? header.createdAt : undefined,
    cwd: asText(header?.cwd),
    agentPreset: asText(header?.agentPreset),
    provider: "",
    model: "",
    messages: [],
    toolResults: new Map(),
    images: [],
    stats: {
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      images: 0,
      compactions: 0,
      injectedDropped: 0,
      chars: 0,
      skippedTypes: {},
      malformed: Number.isFinite(options.malformed) ? options.malformed : 0
    }
  };

  const countSkipped = (type) => {
    const key = asText(type) || "<无类型>";
    model.stats.skippedTypes[key] = (model.stats.skippedTypes[key] ?? 0) + 1;
  };

  /** 图片按出现顺序编号，Markdown 与 HTML 两边拿到同一套文件名。 */
  const registerImage = (attachment) => {
    const attachmentId = asText(attachment?.attachmentId);
    if (attachmentId === "") return undefined;
    const mediaType = asText(attachment?.mediaType) || "image/png";
    const rawName = asText(attachment?.name);
    const index = model.images.length + 1;
    const stem = rawName === "" ? `image-${index}` : rawName.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    const file = `img-${String(index).padStart(2, "0")}-${sanitizeFilename(stem, `image-${index}`)}${extensionFor(rawName, mediaType)}`;
    const entry = { attachmentId, mediaType, name: rawName === "" ? file : rawName, file, index };
    model.images.push(entry);
    model.stats.images += 1;
    return entry;
  };

  for (const record of list) {
    const type = asText(record?.type);
    const data = isObject(record?.data) ? record.data : {};

    if (type === "session") continue;

    if (type === "session/title") {
      // 标题会被重新生成：后写的覆盖先写的。
      const title = asText(data.title).trim();
      if (title !== "") model.title = title;
      continue;
    }

    if (type === "model/selection") {
      if (asText(data.provider) !== "") model.provider = asText(data.provider);
      if (asText(data.model) !== "") model.model = asText(data.model);
      continue;
    }

    if (type === "request/context") {
      if (asText(data.provider) !== "" && model.provider === "") model.provider = asText(data.provider);
      if (asText(data.model) !== "" && model.model === "") model.model = asText(data.model);
      continue;
    }

    if (type === "request/header") {
      const config = isObject(data.header?.config) ? data.header.config : undefined;
      if (config !== undefined) {
        if (asText(config.provider) !== "" && model.provider === "") model.provider = asText(config.provider);
        if (asText(config.model) !== "" && model.model === "") model.model = asText(config.model);
      }
      continue;
    }

    if (type === "user/message" || type === "developer/message") {
      // data 本身**就是**消息（不是嵌在 data.message 里）—— 见 dsh-session 的校验分支。
      const blocks = normalizeBlocks(data.content);
      const injected = isInjectedMessage(blocks);
      if (injected && options.includeInjected !== true) {
        model.stats.injectedDropped += 1;
        continue;
      }
      for (const block of blocks) if (block.type === "image") registerImage(block.attachment);
      model.messages.push({
        role: type === "developer/message" ? "developer" : "user",
        time: typeof record.time === "number" ? record.time : undefined,
        injected,
        blocks
      });
      model.stats.userMessages += 1;
      continue;
    }

    if (type === "assistant/message") {
      const blocks = normalizeBlocks(data.message?.content);
      model.messages.push({
        role: "assistant",
        time: typeof record.time === "number" ? record.time : undefined,
        turn: typeof data.turn === "number" ? data.turn : undefined,
        step: typeof data.step === "number" ? data.step : undefined,
        blocks
      });
      for (const block of blocks) if (block.type === "tool-call") model.stats.toolCalls += 1;
      model.stats.assistantMessages += 1;
      continue;
    }

    if (type === "tool/result") {
      const callId = asText(data.message?.toolCallId) || asText(data.message?.source?.callId);
      const blocks = normalizeBlocks(data.message?.content);
      for (const block of blocks) if (block.type === "image") registerImage(block.attachment);
      if (callId !== "") {
        model.toolResults.set(callId, {
          blocks,
          isError: data.message?.isError === true,
          time: typeof record.time === "number" ? record.time : undefined
        });
        model.stats.toolResults += 1;
      } else {
        countSkipped("tool/result(无 callId)");
      }
      continue;
    }

    // 人类敲的斜杠命令（/permission、/compact 之类）是对话的一部分，留一行痕迹。
    if (type === "command/run") {
      const name = asText(data.name);
      const args = asText(data.args);
      model.messages.push({
        role: "command",
        time: typeof record.time === "number" ? record.time : undefined,
        command: `/${name}${args === "" ? "" : ` ${args.trim()}`}`.trim()
      });
      continue;
    }

    // 上下文压缩：模型侧被摘要替换，人类侧的记录还在 —— 必须标出来。
    if (type.includes("compaction")) {
      model.stats.compactions += 1;
      model.messages.push({
        role: "note",
        time: typeof record.time === "number" ? record.time : undefined,
        text: "（此处发生上下文压缩：更早的内容在模型侧已被摘要替换）"
      });
      continue;
    }

    countSkipped(type);
  }

  // 标题兜底：第一条用户消息的头一行；再不行就说「未命名会话」。
  if (model.title === "") {
    const firstUser = model.messages.find((message) => message.role === "user");
    const text = firstUser?.blocks?.find((block) => block.type === "text")?.text;
    model.title = firstLine(text, 40) || "未命名会话";
  }

  model.stats.messages = model.messages.length;
  model.stats.chars = model.messages.reduce((total, message) => {
    if (typeof message.text === "string") return total + message.text.length;
    if (typeof message.command === "string") return total + message.command.length;
    return total + (message.blocks ?? []).reduce((sum, block) => {
      if (block.type === "text" || block.type === "reasoning") return sum + asText(block.text).length;
      if (block.type === "tool-call") return sum + asText(block.arguments).length;
      return sum;
    }, 0);
  }, 0);

  return model;
}

/**
 * 按 `scope` 算出这篇转写会引用到哪些图片，顺序 = 正文出现顺序。
 *
 * 三个地方共用它，所以必须是同一个函数而不是三份「看起来一样」的循环：
 *   - 导出侧先读它，才知道要给 HTML 预读哪几张图（内嵌预算也按它算）；
 *   - 两种渲染器各自编号，靠它保证「同一个会话、同一个 scope」下
 *     Markdown 与 HTML 里的图片文件名一致；
 *   - 离线测试直接断言它，不用把产物渲染出来才知道图片清单。
 */
export function collectImages(model, scope) {
  const wanted = scope === "chat" ? "chat" : "full";
  const seen = new Set();
  const images = [];
  const collect = (blocks) => {
    for (const block of blocks ?? []) {
      if (block.type !== "image") continue;
      const id = asText(block.attachment?.attachmentId);
      if (id === "" || seen.has(id)) continue;
      const entry = model.images.find((item) => item.attachmentId === id);
      if (entry === undefined) continue;
      seen.add(id);
      images.push(entry);
    }
  };
  for (const message of model.messages) {
    if (message.role === "user" || message.role === "developer") collect(message.blocks);
    else if (message.role === "assistant" && wanted !== "chat") {
      for (const block of message.blocks ?? []) {
        if (block.type !== "tool-call") continue;
        const result = model.toolResults.get(asText(block.id));
        if (result !== undefined) collect(result.blocks);
      }
    }
  }
  return images;
}

/** 截断正文并附一句说明（说明本身就是「这里被截过」的证据）。 */
const clamped = (text, limit) => {
  const body = asText(text);
  if (limit <= 0 || body.length <= limit) return { text: body, truncated: false, total: body.length };
  return {
    text: `${body.slice(0, limit)}\n\n…（已截断，原文 ${body.length} 字符）`,
    truncated: true,
    total: body.length
  };
};

const scopeLabel = (scope) => (scope === "chat" ? "仅对话" : "完整记录");

const modelLabel = (model) => {
  const provider = asText(model.provider);
  const name = asText(model.model);
  if (provider === "" && name === "") return "";
  if (provider === "") return name;
  if (name === "") return provider;
  return `${provider}/${name}`;
};

const metaLines = (model, options) => {
  const { scope, limits, now, images, assetsDir } = options;
  const lines = [`- 会话 ID：\`${model.sessionId || "未知"}\``];
  const label = modelLabel(model);
  if (label !== "") lines.push(`- 模型：\`${label}\``);
  if (model.cwd !== "") lines.push(`- 工作目录：\`${model.cwd}\``);
  const created = formatDateTime(model.createdAt);
  if (created !== "") lines.push(`- 创建时间：${created} · 导出时间：${formatDateTime(now)}`);
  lines.push(`- 规模：${model.stats.userMessages} 条用户消息 · ${model.stats.assistantMessages} 条助手回复`
    + ` · ${model.stats.toolCalls} 次工具调用 · ${images.length} 张图片`);
  lines.push(`- 内容范围：${scopeLabel(scope)}`);
  // 只在真的会截断时才写这一行：默认不截断，写"超过 0 字符的部分按截断处理"是胡话。
  if (scope !== "chat" && limits.maxToolChars > 0) {
    lines.push(`- 单条正文超过 ${limits.maxToolChars} 字符的部分按截断处理`);
  }
  if (images.length > 0 && assetsDir !== undefined) {
    lines.push(`- 图片位于同目录的 \`${assetsDir}/\``);
  }
  return lines;
};

/** 一条消息（或命令/备注）的 Markdown 片段。 */
const messageToMarkdown = (message, context) => {
  const { scope, limits } = context;
  const parts = [];

  if (message.role === "command") {
    parts.push(`> ⌨️ \`${message.command}\``);
    return parts.join("\n\n");
  }
  if (message.role === "note") {
    parts.push(`> ⚠️ ${message.text}`);
    return parts.join("\n\n");
  }

  const heading = message.role === "developer" ? "🛠 开发者" : ROLE_HEADING[message.role];
  const stamp = formatDateTime(message.time);
  parts.push(stamp === "" ? `## ${heading}` : `## ${heading}\n\n<sub>${stamp}</sub>`);
  if (message.injected === true) {
    parts.push("> 🧩 以下内容由 DSH 自动注入的上下文，不是用户输入");
  }

  for (const block of message.blocks ?? []) {
    if (block.type === "text") {
      // 正文里的 `![alt](路径)` 若指向会话工作目录内的真实文件，就改写成打包后的
      // 相对路径；解析不了的原样留着（读者至少能看到它原本指向哪里）。
      for (const segment of splitTextByImages(asText(block.text), context.textImage)) {
        if (segment.kind === "image") {
          const alt = segment.alt === "" ? (segment.name ?? segment.target) : segment.alt;
          parts.push(`![${alt}](${mdDestination(segment.href)})`);
        } else {
          const text = segment.text.trim();
          if (text !== "") parts.push(text);
        }
      }
      continue;
    }

    if (block.type === "image") {
      const image = context.imageFiles.get(asText(block.attachment?.attachmentId));
      if (image !== undefined) parts.push(`![${image.name}](${mdDestination(context.imageRef(image))})`);
      continue;
    }

    // 以下是「完整记录」才有的部分。
    if (scope === "chat") continue;

    if (block.type === "reasoning") {
      const body = clamped(block.text, limits.maxReasoningChars);
      if (body.text.trim() === "") continue;
      parts.push(`<details>\n<summary>💭 思考过程（${body.total} 字符）</summary>\n\n${body.text.trim()}\n\n</details>`);
      continue;
    }

    if (block.type === "tool-call") {
      const name = asText(block.name) || "工具";
      const summary = summarizeToolCall(name, block.arguments);
      const args = clamped(block.arguments, limits.maxArgumentChars);
      const result = context.results.get(asText(block.id));
      const resultText = result === undefined
        ? "_（没有结果记录）_"
        : clamped(
          (result.blocks ?? []).filter((part) => part.type === "text").map((part) => asText(part.text)).join("\n"),
          limits.maxToolChars
        ).text.trim() || "_（结果为空）_";
      const head = summary === "" ? name : `${name} · ${summary}`;
      const flag = result?.isError === true ? "失败" : "结果";
      // 工具结果里的图片（`read_image` 之类）必须真的放进正文 —— 早先只把图**打包**
      // 了却从没渲染，于是导出文件里明明躺着 base64，读者却一张都看不到。
      const resultImages = (result?.blocks ?? [])
        .filter((part) => part.type === "image")
        .map((part) => context.imageFiles.get(asText(part.attachment?.attachmentId)))
        .filter((image) => image !== undefined)
        .map((image) => `![${image.name}](${mdDestination(context.imageRef(image))})`);
      parts.push([
        `<details>`,
        `<summary>🔧 ${head}</summary>`,
        "",
        fenced(args.text.trim(), "json"),
        "",
        `**${flag}**`,
        "",
        fenced(resultText, "text"),
        ...(resultImages.length === 0 ? [] : ["", ...resultImages]),
        "",
        `</details>`
      ].join("\n"));
      continue;
    }
  }

  return parts.join("\n\n");
};

/**
 * 把一段正文按「围栏代码块」切开：`{ text, fenced }`。
 *
 * 只对**非围栏**的片段做图片识别 —— 否则示例代码里写着的
 * `![x](path)`（教程、README 片段）会被当成真图片处理。
 */
export const splitFencedSegments = (text) => {
  const segments = [];
  let buffer = [];
  let fenced = false;
  let marker = "";

  const flush = (isFenced) => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer.join("\n"), fenced: isFenced });
    buffer = [];
  };

  for (const line of asText(text).split("\n")) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match === null) {
      buffer.push(line);
      continue;
    }
    if (!fenced) {
      flush(false);
      fenced = true;
      marker = match[1][0];
      buffer.push(line);
      continue;
    }
    if (match[1][0] === marker) {
      buffer.push(line);
      flush(true);
      fenced = false;
      marker = "";
      continue;
    }
    buffer.push(line);
  }
  flush(fenced);
  return segments;
};

/** Markdown 图片语法：`![alt](目标)`，目标可以写成 `<路径>`（含空格时的标准写法）。 */
const IMAGE_SYNTAX = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** `![x](<a b.jpg>)` 里的尖括号是 CommonMark 的写法，解析时要去掉。 */
const normalizeTarget = (raw) => {
  const text = asText(raw).trim();
  return text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text;
};

/**
 * Markdown 链接目标：含空格或括号时**必须**用 `<...>` 包住。
 * 资源目录名取自会话标题（`未命名会话-20261002-1936 (2).assets`），很容易带空格 ——
 * 裸写的话 CommonMark 会在空格处断开，图片在阅读器里直接不显示。
 */
const mdDestination = (target) => (/[\s()<>]/.test(target) ? `<${target}>` : target);

/**
 * 把一段正文切成「文本片段」与「已解析的图片片段」。
 *
 * `resolve(target)` 由调用方给：返回 `{ name, href }` 表示这张图能打包（渲染成图片），
 * 返回 undefined 表示解析不了 —— 那就把原始语法原样留在文本里。
 */
export const splitTextByImages = (text, resolve) => {
  const nodes = [];
  for (const segment of splitFencedSegments(text)) {
    if (segment.fenced || typeof resolve !== "function") {
      nodes.push({ kind: "text", text: segment.text });
      continue;
    }
    IMAGE_SYNTAX.lastIndex = 0;
    let last = 0;
    let match;
    while ((match = IMAGE_SYNTAX.exec(segment.text)) !== null) {
      const target = normalizeTarget(match[2]);
      const resolved = resolve(target);
      if (resolved === undefined) continue;
      if (match.index > last) nodes.push({ kind: "text", text: segment.text.slice(last, match.index) });
      nodes.push({
        kind: "image",
        // target 必须带上：HTML 侧要拿它回查规划（早先漏了，于是页面里只剩一行
        // 「图片未打包：」的空占位 —— 图和规划都在，就是配不上对）。
        target,
        alt: match[1],
        name: resolved.name,
        href: resolved.href
      });
      last = match.index + match[0].length;
    }
    if (last < segment.text.length) nodes.push({ kind: "text", text: segment.text.slice(last) });
  }
  return nodes;
};

/**
 * 正文里引用到的本地图片（去重、按出现顺序）。
 *
 * 只管**消息正文的文本块**（用户/助手/开发者），有意不扫两处：
 *   - `reasoning`（思考过程）：那里的 `![](...)` 往往只是"我打算这样写"的草稿，
 *     而且思考过程是原文照登的，改了反而失真；
 *   - 工具结果正文：它是机器输出，在文档里是**代码块**，里面的图片语法不该被当真。
 * 规划与渲染必须用同一套范围，否则会出现"复制了一张没人引用的图"这种幽灵产物。
 *
 * 只认 Markdown 的 `![](...)` 写法；`<img src="...">` 这种内嵌 HTML 不解析
 * （见 README「已知边界」）。
 */
export const collectTextImageRefs = (model, scope) => {
  const seen = new Set();
  const refs = [];
  const scan = (text) => {
    for (const segment of splitFencedSegments(text)) {
      if (segment.fenced) continue;
      IMAGE_SYNTAX.lastIndex = 0;
      let match;
      while ((match = IMAGE_SYNTAX.exec(segment.text)) !== null) {
        const target = normalizeTarget(match[2]);
        if (target === "" || seen.has(target)) continue;
        seen.add(target);
        refs.push({ target, alt: match[1] });
      }
    }
  };
  for (const message of model.messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "text") continue;
      scan(asText(block.text));
    }
  }
  return refs;
};

/**
 * 模型 → Markdown。
 * @param model - buildTranscript 的产物。
 * @param options - `{ scope, limits, now, assetsDir, textImages }`。
 *                   `textImages` 是 `Map<原始目标, { name, href }>`：正文里引用的
 *                   工作区图片在打包后的落点（由 host 半解析，见 lib/index.js）。
 * @returns `{ markdown, images, stats }`；`images` 是本篇实际引用到的图片（含文件名）。
 */
export function renderMarkdown(model, options = {}) {
  const scope = options.scope === "chat" ? "chat" : "full";
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const assetsDir = typeof options.assetsDir === "string" && options.assetsDir !== "" ? options.assetsDir : undefined;
  const textImages = options.textImages instanceof Map ? options.textImages : new Map();

  // 先按 scope 算出「这篇会用到哪些图片」，再按这个顺序编号，两条产物才对得上。
  const images = collectImages(model, scope);
  const imageFiles = new Map(images.map((image) => [image.attachmentId, image]));

  const context = {
    scope,
    limits,
    results: model.toolResults,
    imageFiles,
    imageRef: (image) => (assetsDir === undefined ? image.file : `${assetsDir}/${image.file}`),
    textImage: (target) => textImages.get(target)
  };

  const head = [
    `# ${model.title}`,
    "",
    "> 由 **DeepSeek Harness** 导出的会话记录",
    ...metaLines(model, { scope, limits, now, images, assetsDir })
  ];

  const body = model.messages
    .map((message) => messageToMarkdown(message, context))
    .filter((text) => text.trim() !== "");

  const markdown = [...head, "", "---", "", body.join("\n\n---\n\n"), ""].join("\n");
  return { markdown, images, stats: { ...model.stats, scope, chars: markdown.length } };
}

/* -------------------------------------------------------------------------- *
 * HTML
 * -------------------------------------------------------------------------- */

const HTML_CSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--fg:#1f2328;--muted:#6b7280;--line:#e3e5e8;--accent:#4d6bfe;--code:#f2f3f5;--err:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#15171c;--card:#1c1f26;--fg:#e6e8eb;--muted:#9aa3af;--line:#2b2f38;--accent:#7f96ff;--code:#22262f;--err:#ff7b72}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
.head{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:20px}
.head h1{margin:0 0 12px;font-size:22px;line-height:1.35}
.head ul{margin:0;padding-left:18px;color:var(--muted);font-size:13px;line-height:1.9}
.head code{background:var(--code);border-radius:5px;padding:1px 5px;font-size:12.5px}
.tools{display:flex;gap:8px;margin-top:14px}
.tools button{font:inherit;font-size:12.5px;color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.tools button:hover{color:var(--fg);border-color:var(--muted)}
.msg{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 20px;margin-bottom:14px}
.msg h2{margin:0 0 10px;font-size:14px;font-weight:600;display:flex;align-items:baseline;gap:8px}
.msg h2 time{color:var(--muted);font-weight:400;font-size:11.5px}
.msg.user{border-left:3px solid var(--accent)}
.msg.assistant{border-left:3px solid #10a37f}
.p{white-space:pre-wrap;word-break:break-word;margin:0 0 10px}
.p:last-child{margin-bottom:0}
details{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0;background:color-mix(in srgb,var(--code) 60%,transparent)}
summary{cursor:pointer;color:var(--muted);font-size:12.5px;outline:none}
summary:hover{color:var(--fg)}
details pre{margin:10px 0 4px}
pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow:auto;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;white-space:pre-wrap;word-break:break-word}
figure{margin:10px 0}
figure img{max-width:100%;border:1px solid var(--line);border-radius:10px;display:block}
figcaption{color:var(--muted);font-size:12px;margin-top:4px}
.command,.note{color:var(--muted);font-size:13.5px}
.command code{background:var(--code);border-radius:5px;padding:1px 6px}
.err{color:var(--err)}
.foot{color:var(--muted);font-size:12px;text-align:center;margin-top:26px}
`;

const htmlText = (text) => `<div class="p">${escapeHtml(asText(text).trim())}</div>`;

/** 一条消息的 HTML（内容全部转义后再拼）。 */
const messageToHtml = (message, context) => {
  const { scope, limits } = context;

  if (message.role === "command") {
    return `<article class="msg command">⌨️ <code>${escapeHtml(message.command)}</code></article>`;
  }
  if (message.role === "note") {
    return `<article class="msg note">⚠️ ${escapeHtml(message.text)}</article>`;
  }

  const heading = message.role === "developer" ? "🛠 开发者" : ROLE_HEADING[message.role];
  const stamp = formatDateTime(message.time);
  const body = [];
  if (message.injected === true) {
    body.push(`<p class="note">🧩 以下内容由 DSH 自动注入的上下文，不是用户输入</p>`);
  }

  for (const block of message.blocks ?? []) {
    if (block.type === "text") {
      // 正文里的 `![alt](路径)`：解析得到就渲染成真图，解析不到就原样留字。
      for (const segment of splitTextByImages(asText(block.text), context.textImage)) {
        if (segment.kind === "image") body.push(context.textImageHtml(segment));
        else if (segment.text.trim() !== "") body.push(htmlText(segment.text));
      }
      continue;
    }

    if (block.type === "image") {
      const image = context.imageFiles.get(asText(block.attachment?.attachmentId));
      if (image !== undefined) body.push(context.imageHtml(image));
      continue;
    }

    if (scope === "chat") continue;

    if (block.type === "reasoning") {
      const text = clamped(block.text, limits.maxReasoningChars);
      if (text.text.trim() === "") continue;
      body.push(`<details><summary>💭 思考过程（${text.total} 字符）</summary><pre>${escapeHtml(text.text.trim())}</pre></details>`);
      continue;
    }

    if (block.type === "tool-call") {
      const name = asText(block.name) || "工具";
      const summary = summarizeToolCall(name, block.arguments);
      const args = clamped(block.arguments, limits.maxArgumentChars);
      const result = context.results.get(asText(block.id));
      const rawResult = result === undefined
        ? ""
        : (result.blocks ?? []).filter((part) => part.type === "text").map((part) => asText(part.text)).join("\n");
      const resultText = result === undefined
        ? "（没有结果记录）"
        : clamped(rawResult, limits.maxToolChars).text.trim() || "（结果为空）";
      const fail = result?.isError === true;
      const head = summary === "" ? name : `${name} · ${summary}`;
      // 工具结果里的图片必须真的画出来（DSH 自己的工具卡片就是这么做的）：
      // 早先只把图**打包**进产物却从不渲染，于是文件里躺着 base64 却一张都看不到。
      const resultImages = (result?.blocks ?? [])
        .filter((part) => part.type === "image")
        .map((part) => context.imageFiles.get(asText(part.attachment?.attachmentId)))
        .filter((image) => image !== undefined)
        .map((image) => context.imageHtml(image));
      body.push([
        `<details>`,
        `<summary>🔧 ${escapeHtml(head)}</summary>`,
        `<pre>${escapeHtml(args.text.trim())}</pre>`,
        `<p class="p${fail ? " err" : ""}"><strong>${fail ? "失败" : "结果"}</strong></p>`,
        `<pre>${escapeHtml(resultText)}</pre>`,
        ...resultImages,
        `</details>`
      ].join(""));
      continue;
    }
  }

  if (body.length === 0) return "";
  const roleClass = message.role === "developer" ? "assistant" : message.role;
  return `<article class="msg ${roleClass}"><h2>${escapeHtml(heading)}${stamp === "" ? "" : `<time>${escapeHtml(stamp)}</time>`}</h2>${body.join("")}</article>`;
};

/**
 * 模型 → 单文件 HTML。
 * @param options - 额外接受：
 *   - `loadImage(attachmentId) → { base64, mediaType }`：附件图给得出就内嵌成 data URI；
 *   - `textImages: Map<原始目标, { name, href, dataUri? }>`：正文里引用的工作区图片
 *     在打包后的落点（host 半解析并读好字节，见 lib/index.js）。
 */
export function renderHtml(model, options = {}) {
  const scope = options.scope === "chat" ? "chat" : "full";
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const loadImage = typeof options.loadImage === "function" ? options.loadImage : undefined;
  const assetsDir = typeof options.assetsDir === "string" && options.assetsDir !== "" ? options.assetsDir : undefined;
  const textImages = options.textImages instanceof Map ? options.textImages : new Map();

  // 与 Markdown 同一条收集规则：scope 决定哪些图片进正文，编号顺序按出现顺序。
  const images = collectImages(model, scope);
  const imageFiles = new Map(images.map((image) => [image.attachmentId, image]));

  const figure = (src, name) => `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(name)}">`
    + `<figcaption>${escapeHtml(name)}</figcaption></figure>`;

  const context = {
    scope,
    limits,
    results: model.toolResults,
    imageFiles,
    imageHtml: (image) => {
      const loaded = loadImage?.(image.attachmentId);
      if (loaded !== undefined && typeof loaded.base64 === "string") {
        return figure(`data:${loaded.mediaType ?? image.mediaType};base64,${loaded.base64}`, image.name);
      }
      if (assetsDir !== undefined) return figure(`${assetsDir}/${image.file}`, image.name);
      return `<figure><div class="p">🖼 图片未内嵌：${escapeHtml(image.name)}</div></figure>`;
    },
    /** 正文里解析出来的工作区图片：有 dataUri 就内嵌，否则用相对路径。 */
    textImage: (target) => textImages.get(target),
    textImageHtml: (segment) => {
      const plan = textImages.get(segment.target);
      const name = segment.alt === "" ? (plan?.name ?? segment.target) : segment.alt;
      if (typeof plan?.dataUri === "string") return figure(plan.dataUri, name);
      if (typeof plan?.href === "string") return figure(plan.href, name);
      return `<figure><div class="p">🖼 图片未打包：${escapeHtml(segment.target)}</div></figure>`;
    }
  };

  const title = model.title;
  const meta = metaLines(model, { scope, limits, now, images, assetsDir });
  const body = model.messages
    .map((message) => messageToHtml(message, context))
    .filter((html) => html !== "");

  const hasDetails = body.some((html) => html.includes("<details>"));
  const toolbar = hasDetails
    ? `<div class="tools"><button type="button" data-toggle="open">展开全部</button>`
      + `<button type="button" data-toggle="close">折叠全部</button></div>`
    : "";
  const script = hasDetails
    ? `<script>document.addEventListener("click",function(event){var button=event.target.closest("[data-toggle]");if(!button)return;var open=button.dataset.toggle==="open";document.querySelectorAll("details").forEach(function(node){node.open=open;});});</script>`
    : "";

  const html = [
    "<!doctype html>",
    `<html lang="zh-CN">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${HTML_CSS}</style>`,
    "</head>",
    "<body>",
    `<div class="wrap">`,
    `<header class="head"><h1>${escapeHtml(title)}</h1><ul>`,
    ...meta.map((line) => `<li>${escapeHtml(line.replace(/^- /, "").replace(/`/g, ""))}</li>`),
    `</ul>${toolbar}</header>`,
    ...body,
    `<p class="foot">由 DeepSeek Harness · dsh-session-share 导出</p>`,
    "</div>",
    script,
    "</body>",
    "</html>",
    ""
  ].join("\n");

  return { html, images, stats: { ...model.stats, scope, chars: html.length } };
}
