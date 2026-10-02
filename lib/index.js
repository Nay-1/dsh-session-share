/**
 * dsh-session-share — Host half.
 *
 * 给侧栏会话行 “...” 菜单里的「分享会话」提供真正的导出动作：
 *   1. 读取会话工件（多帧 zstd JSONL）→ 转写模型（render.js）
 *   2. 渲染 Markdown / 单文件 HTML
 *   3. 落盘到用户指定的目录（默认 Downloads，退 Desktop，再退家目录）
 *   4. 在资源管理器里定位产物
 *
 * 几个刻意的取舍：
 *   - **只读**。除了目标目录里新建导出文件，不碰任何 DSH 数据：不删、不改、
 *     不碰工作区账本。分享是只读操作，出错最多是「没导出成功」。
 *   - **命名不覆盖**：`<标题>-<时间戳>.md` 已经存在就顺延 `(2)`、`(3)`。
 *     分享文件重名很常见（同一个会话导两次），静默覆盖是丢数据。
 *   - **图片跟着走**：Markdown 导出会在同名 `.assets/` 目录里放图片（内容寻址的
 *     附件对象复制过去），HTML 导出优先内嵌成 data URI 做成真正的单文件；
 *     图片总量超过预算时退回「同名目录 + 相对引用」，并在响应里如实说明。
 *   - **调用头门禁**：插件的前缀路由**不经 DSH 的鉴权网关**（实测 DSH 自身路由
 *     401、插件路由 200），没有门禁时浏览器里任意网页都能 POST 进来让本插件
 *     往磁盘写文件。要求一个自定义头即可封死：自定义头必然触发 CORS 预检，
 *     而本服务从不返回 CORS 头，网页发不出这个请求；同源 fetch 与本地脚本照常。
 *   - **reveal 只能定位自己导出过的东西**：允许的路径必须是本次进程导出落盘过的
 *     文件（或其所在目录），避免变成一个「用插件拉起任意本地路径」的口子。
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

import { listRecentSessions, readSession, resolveDshHome } from "./session-log.js";
import {
  DEFAULT_LIMITS,
  attachmentObjectPath,
  buildTranscript,
  collectImages,
  collectTextImageRefs,
  formatDateTime,
  renderHtml,
  renderMarkdown,
  sanitizeFilename,
  timestampSlug
} from "./render.js";

export const name = "dsh-session-share";

export const inject = ["webServer"];

const API_PREFIX = "/session-share/api";
const CALL_HEADER = "x-dsh-plugin-call";
const CALL_HEADER_VALUE = "1";
const MAX_BODY_BYTES = 64 * 1024;
const PREVIEW_CHARS = 8000;
/** 单文件 HTML 内嵌图片的字节预算；超过就退回「同名目录 + 相对引用」。 */
const MAX_EMBED_BYTES = 25 * 1024 * 1024;
/** 正文里按路径引用的图片：只认这些扩展名，且必须落在会话工作目录内。 */
const TEXT_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
/** 单张正文引用图片的体积上限（超过多半不是"配图"，而是误引了别的大文件）。 */
const MAX_TEXT_IMAGE_BYTES = 20 * 1024 * 1024;
/** 正文引用图片的张数上限：挡住"某段正文引用了几百个文件"这种病态情况。 */
const MAX_TEXT_IMAGES = 50;

const fail = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

/**
 * `DSH_SESSION_SHARE_NO_SPAWN=1`：只算出会跑哪条命令、不真的拉起窗口。
 * 给自测与脚本用（自测不该弹资源管理器 / 编辑器窗口）。
 */
const NO_SPAWN = process.env.DSH_SESSION_SHARE_NO_SPAWN === "1";

/** 数字参数：取值区间外的输入一律回落到默认值，而不是抛错打断导出。 */
const clampInt = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.trunc(number);
  return rounded < min || rounded > max ? fallback : rounded;
};

const scopeOf = (value) => (value === "chat" ? "chat" : "full");

const limitsOf = (body) => ({
  maxToolChars: clampInt(body?.maxToolChars, DEFAULT_LIMITS.maxToolChars, 0, 200000),
  maxReasoningChars: clampInt(body?.maxReasoningChars, DEFAULT_LIMITS.maxReasoningChars, 0, 200000),
  maxArgumentChars: clampInt(body?.maxArgumentChars, DEFAULT_LIMITS.maxArgumentChars, 0, 200000)
});

/** 默认导出目录：Downloads → Desktop → 家目录（存在即用）。 */
const resolveDefaultDir = async () => {
  const home = homedir();
  for (const candidate of [join(home, "Downloads"), join(home, "Desktop")]) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch { /* 试下一个 */ }
  }
  return home;
};

/**
 * 目标目录：必须是绝对路径（客户端的默认值就是绝对的）。
 * 相对路径会相对于 **DSH 进程的 cwd** 解析 —— 那是个用户看不见的目录，
 * 与其"成功导出到一个找不到的地方"，不如直接拒绝。
 */
const resolveTargetDir = (value, fallback) => {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const text = value.trim();
  if (!isAbsolute(text)) throw fail(`导出目录必须是绝对路径：${text}`, "bad-request");
  return resolve(text);
};

/**
 * 目标命名。
 *
 * `md` 会**新建一个同名文件夹**，把 `.md` 与同名 `.assets/` 一起装进去：
 * 分享时整个文件夹拖走就行，不会在下载目录里散成"一个文件 + 一个图片夹"两半；
 * `html` 是单文件，不建文件夹（建了反而多一层）。
 *
 * 同名顺延：`标题-时间戳` 已被占就试 `标题-时间戳 (2)`、`(3)` …… 最多 50 次。
 */
const planTarget = async (dir, baseName, format) => {
  for (let index = 1; index <= 50; index += 1) {
    const candidate = index === 1 ? baseName : `${baseName} (${index})`;
    if (format === "md") {
      const folder = join(dir, candidate);
      try {
        await stat(folder);
        continue; // 这个文件夹名已经被占了
      } catch { /* 不存在 -> 可用 */ }
      return { baseName: candidate, folder };
    }
    let taken = false;
    for (const suffix of [".html", ".assets"]) {
      try {
        await stat(join(dir, `${candidate}${suffix}`));
        taken = true;
        break;
      } catch { /* 该后缀不冲突 */ }
    }
    if (!taken) return { baseName: candidate, folder: dir };
  }
  throw fail("目标目录里同名文件太多了，换个目录试试", "conflict");
};

export function apply(ctx) {
  const home = resolveDshHome();
  const sessionsRoot = join(home, "sessions");
  const attachmentsRoot = join(home, "attachments", "v1", "objects");

  /** 本次进程导出落盘过的路径 —— reveal 的白名单。 */
  const exportedPaths = new Set();
  const exportedDirs = new Set();

  const warn = (message) => {
    try { ctx.logger?.warn?.(`session-share: ${message}`); } catch { /* 日志失败不影响流程 */ }
  };
  const info = (message) => {
    try { ctx.logger?.info?.(`session-share: ${message}`); } catch { /* ignore */ }
  };

  const send = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) throw fail("请求体过大", "bad-request");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  /** 会话 → 转写模型。读不到就抛出带 code 的错误，交给 HTTP 层映射状态码。 */
  const loadModel = async (body) => {
    const read = await readSession(sessionsRoot, body?.sessionId);
    if (!read.ok) throw fail(read.error, read.code);
    const model = buildTranscript(read.records, {
      malformed: read.malformed,
      // 默认滤掉 DSH 自动注入的上下文；要留的人在请求里显式打开。
      includeInjected: body?.includeInjected === true
    });
    model.file = read.file;
    return model;
  };

  const baseNameOf = (model) => `${sanitizeFilename(model.title, "会话分享")}-${timestampSlug()}`;

  /** 附件对象 → base64（内嵌 HTML 用）。读不到返回 undefined，渲染层会退化。 */
  const loadImageBase64 = async (attachmentId) => {
    const located = attachmentObjectPath(attachmentsRoot, attachmentId);
    if (located === undefined) return undefined;
    try {
      const bytes = await readFile(located.file);
      return { base64: bytes.toString("base64"), mediaType: undefined, bytes: bytes.length };
    } catch {
      return undefined;
    }
  };

  const writeImages = async (dir, images) => {
    const written = [];
    let failed = 0;
    for (const image of images) {
      const located = attachmentObjectPath(attachmentsRoot, image.attachmentId);
      if (located === undefined) { failed += 1; continue; }
      try {
        const bytes = await readFile(located.file);
        const target = join(dir, image.file);
        await writeFile(target, bytes);
        written.push(target);
      } catch (error) {
        failed += 1;
        warn(`图片落盘失败 ${image.file}: ${error?.message ?? error}`);
      }
    }
    return { written, failed };
  };

  /** 任意本地文件 → base64（正文引用的工作区图片内嵌时用）。 */
  const loadFileBase64 = async (file) => {
    try {
      const bytes = await readFile(file);
      return { base64: bytes.toString("base64"), bytes: bytes.length };
    } catch {
      return undefined;
    }
  };

  /** 正文引用的工作区图片：复制进 `.assets/`（名字与正文里改写后的链接一致）。 */
  const copyTextImages = async (dir, plan) => {
    const written = [];
    let failed = 0;
    for (const item of plan.values()) {
      try {
        const target = join(dir, item.name);
        await copyFile(item.file, target);
        written.push(target);
      } catch (error) {
        failed += 1;
        warn(`正文图片复制失败 ${item.name}: ${error?.message ?? error}`);
      }
    }
    return { written, failed };
  };

  const describeModel = (model) => ({
    sessionId: model.sessionId,
    title: model.title,
    createdAt: model.createdAt,
    createdAtText: formatDateTime(model.createdAt),
    cwd: model.cwd,
    provider: model.provider,
    model: model.model,
    file: model.file
  });

  /**
   * 正文里引用的本地图片 → 磁盘路径。**只允许会话工作目录（header.cwd）以内的文件。**
   *
   * 为什么要有这道边界：这些路径是**对话正文里的文本**，不是 DSH 的结构化附件 ——
   * 它可以指向任何地方（`C:\Users\...\.ssh\id_rsa`、`../../`、网络路径）。
   * 导出是只读动作，但"把任意本地文件复制进分享包"不该是它的能力，所以：
   * 相对路径按 cwd 解析、绝对路径也必须在 cwd 之内、越界与 URL 一律不认。
   */
  const resolveTextImageFile = (cwd, target) => {
    if (typeof target !== "string" || target === "") return undefined;
    // `http:` / `data:` / `file:` / `//host/share` 都不认：要么本来就取不到，要么是别的安全面。
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("//")) return undefined;
    let decoded = target;
    try { decoded = decodeURIComponent(target); } catch { /* 含 % 但不是合法转义：原样用 */ }
    if (!TEXT_IMAGE_EXT_RE.test(decoded)) return undefined;
    if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
    const base = resolve(cwd);
    const full = isAbsolute(decoded) ? resolve(decoded) : resolve(base, decoded);
    const rel = relative(base, full);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return full;
  };

  /** 按扩展名猜 mediaType（内嵌 data URI 用）。 */
  const mediaTypeOf = (file) => {
    const ext = extname(file).toLowerCase();
    return {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml"
    }[ext] ?? "application/octet-stream";
  };

  /**
   * 规划正文里的图片引用：哪些能打包、打包后叫什么名字。
   * 只做**存在性与体积**检查，不读内容 —— 预览与复制剪贴板也要走同一条规划，
   * 才不至于"预览里看得见、导出后路径却对不上"。
   */
  const planTextImages = async (model, scope) => {
    const refs = collectTextImageRefs(model, scope);
    const plan = new Map();
    const skipped = [];
    for (const ref of refs) {
      if (plan.size >= MAX_TEXT_IMAGES) { skipped.push(ref.target); continue; }
      const file = resolveTextImageFile(model.cwd, ref.target);
      if (file === undefined) { skipped.push(ref.target); continue; }
      let info;
      try { info = await stat(file); } catch { skipped.push(ref.target); continue; }
      if (!info.isFile() || info.size > MAX_TEXT_IMAGE_BYTES) { skipped.push(ref.target); continue; }
      const index = plan.size + 1;
      const stem = basename(file).replace(/\.[A-Za-z0-9]{1,5}$/, "");
      const name = `ref-${String(index).padStart(2, "0")}-${sanitizeFilename(stem, `image-${index}`)}${extname(file).toLowerCase()}`;
      plan.set(ref.target, { file, name, bytes: info.size });
    }
    return { plan, skipped, total: refs.length };
  };

  /** 规划 → 渲染层要的 `Map<原始目标, { name, href }>`。 */
  const textImageMap = (plan, assetsName) => new Map(
    [...plan.entries()].map(([target, item]) => [target, {
      name: item.name,
      href: assetsName === undefined ? item.name : `${assetsName}/${item.name}`
    }])
  );

  const textImageStats = (planned) => ({
    textImageRefs: planned.total,
    textImagesResolved: planned.plan.size,
    textImagesSkipped: planned.skipped.length,
    // 只回显前几条：让用户知道"哪张没打包"，而不是给一长串。
    textImageSkippedTargets: planned.skipped.slice(0, 5)
  });

  const previewOf = async (body) => {
    const scope = scopeOf(body?.scope);
    const model = await loadModel(body);
    const baseName = baseNameOf(model);
    const assetsName = `${baseName}.assets`;
    const planned = await planTextImages(model, scope);
    const { markdown, images, stats } = renderMarkdown(model, {
      scope,
      limits: limitsOf(body),
      assetsDir: assetsName,
      textImages: textImageMap(planned.plan, assetsName)
    });
    const sampleChars = clampInt(body?.sampleChars, PREVIEW_CHARS, 200, 200000);
    return {
      scope,
      meta: describeModel(model),
      stats,
      baseName,
      defaultDir: await resolveDefaultDir(),
      chars: markdown.length,
      imageCount: images.length,
      ...textImageStats(planned),
      sample: markdown.slice(0, sampleChars),
      sampleTruncated: markdown.length > sampleChars
    };
  };

  const markdownOf = async (body) => {
    const scope = scopeOf(body?.scope);
    const model = await loadModel(body);
    const baseName = baseNameOf(model);
    const assetsName = `${baseName}.assets`;
    const planned = await planTextImages(model, scope);
    const { markdown, images } = renderMarkdown(model, {
      scope,
      limits: limitsOf(body),
      assetsDir: assetsName,
      textImages: textImageMap(planned.plan, assetsName)
    });
    return {
      scope,
      meta: describeModel(model),
      baseName,
      assetsDir: images.length > 0 || planned.plan.size > 0 ? assetsName : undefined,
      imageCount: images.length,
      ...textImageStats(planned),
      chars: markdown.length,
      markdown
    };
  };

  /**
   * 落盘。
   *   - `format: 'md'`：先新建 `<标题-时间戳>/` 文件夹，`.md` 与同名 `.assets/` 都放进去
   *     （分享时整个文件夹拖走就是完整一份，不会散成两半）；
   *   - `format: 'html'`：单文件，图片优先内嵌成 data URI，超预算才退回 `.assets/` 相对引用。
   *
   * 图片有三个来源，都要处理：附件对象（内容寻址）、工具结果里的图、
   * 以及**正文里按路径引用的工作区图片**（`read_image` 之后 agent 写报告时常用）。
   */
  const exportOf = async (body) => {
    const format = body?.format === "html" ? "html" : "md";
    const scope = scopeOf(body?.scope);
    const limits = limitsOf(body);
    const model = await loadModel(body);

    const defaultDir = await resolveDefaultDir();
    const dir = resolveTargetDir(body?.dir, defaultDir);
    await mkdir(dir, { recursive: true });

    const plan = await planTarget(dir, baseNameOf(model), format);
    const baseName = plan.baseName;
    // md 的产物都落在新建的同名文件夹里；html 就落在用户选的目录。
    const outDir = plan.folder;
    const assetsName = `${baseName}.assets`;
    const files = [];
    const planned = await planTextImages(model, scope);

    if (format === "md") {
      await mkdir(outDir, { recursive: true });
      const { markdown, images } = renderMarkdown(model, {
        scope,
        limits,
        assetsDir: assetsName,
        textImages: textImageMap(planned.plan, assetsName)
      });
      const target = join(outDir, `${baseName}.md`);
      await writeFile(target, markdown, "utf8");
      files.push({ kind: "markdown", path: target, bytes: Buffer.byteLength(markdown, "utf8") });

      let imageResult = { written: [], failed: 0 };
      if (images.length > 0 || planned.plan.size > 0) {
        const assetsDir = join(outDir, assetsName);
        await mkdir(assetsDir, { recursive: true });
        imageResult = await writeImages(assetsDir, images);
        // 正文引用的工作区图片：复制过去，名字与正文里改写后的链接一致。
        const copied = await copyTextImages(assetsDir, planned.plan);
        imageResult.written.push(...copied.written);
        imageResult.failed += copied.failed;
        if (imageResult.written.length > 0) {
          files.push({ kind: "assets", path: assetsDir, bytes: 0, count: imageResult.written.length });
        }
      }

      for (const file of files) {
        exportedPaths.add(file.path);
        if (file.kind !== "assets") exportedDirs.add(dirname(file.path));
      }
      exportedPaths.add(outDir);
      info(`exported ${model.sessionId} -> ${target} (${images.length} attachment + ${planned.plan.size} referenced images, scope=${scope})`);
      return {
        format,
        scope,
        dir,
        folder: outDir,
        baseName,
        meta: describeModel(model),
        files,
        imageCount: images.length + planned.plan.size,
        imagesEmbedded: false,
        imagesWritten: imageResult.written.length,
        imagesFailed: imageResult.failed,
        ...textImageStats(planned),
        chars: markdown.length
      };
    }

    // HTML：先按 scope 算出会用到哪些图片，再决定内嵌还是外链。
    const needed = collectImages(model, scope);
    const hasImages = needed.length > 0 || planned.plan.size > 0;
    const embeddedImages = new Map();
    const embeddedText = new Map();
    let embeddedBytes = 0;
    let embedded = hasImages;
    for (const image of needed) {
      const loaded = await loadImageBase64(image.attachmentId);
      if (loaded === undefined || embeddedBytes + loaded.bytes > MAX_EMBED_BYTES) { embedded = false; break; }
      embeddedImages.set(image.attachmentId, { base64: loaded.base64, mediaType: image.mediaType });
      embeddedBytes += loaded.bytes;
    }
    if (embedded) {
      for (const [target, item] of planned.plan) {
        const loaded = await loadFileBase64(item.file);
        if (loaded === undefined || embeddedBytes + loaded.bytes > MAX_EMBED_BYTES) { embedded = false; break; }
        embeddedText.set(target, {
          name: item.name,
          dataUri: `data:${mediaTypeOf(item.file)};base64,${loaded.base64}`
        });
        embeddedBytes += loaded.bytes;
      }
    }
    // 中途触发预算 → 一张都不内嵌，避免出现「一半内嵌一半外链」的怪文件。
    const useAssets = !embedded && hasImages;
    if (useAssets) {
      embeddedImages.clear();
      embeddedText.clear();
    }

    const { html, images } = renderHtml(model, {
      scope,
      limits,
      assetsDir: useAssets ? assetsName : undefined,
      loadImage: (attachmentId) => embeddedImages.get(attachmentId),
      textImages: useAssets ? textImageMap(planned.plan, assetsName) : embeddedText
    });

    const target = join(outDir, `${baseName}.html`);
    await writeFile(target, html, "utf8");
    files.push({ kind: "html", path: target, bytes: Buffer.byteLength(html, "utf8") });

    let imageResult = { written: [], failed: 0 };
    if (useAssets) {
      const assetsDir = join(outDir, assetsName);
      await mkdir(assetsDir, { recursive: true });
      imageResult = await writeImages(assetsDir, images);
      const copied = await copyTextImages(assetsDir, planned.plan);
      imageResult.written.push(...copied.written);
      imageResult.failed += copied.failed;
      if (imageResult.written.length > 0) {
        files.push({ kind: "assets", path: assetsDir, bytes: 0, count: imageResult.written.length });
      }
    }

    for (const file of files) {
      exportedPaths.add(file.path);
      if (file.kind !== "assets") exportedDirs.add(dirname(file.path));
    }
    info(`exported ${model.sessionId} -> ${target} (${images.length} attachment + ${planned.plan.size} referenced images, embedded=${!useAssets}, scope=${scope})`);
    return {
      format,
      scope,
      dir,
      folder: outDir,
      baseName,
      meta: describeModel(model),
      files,
      imageCount: images.length + planned.plan.size,
      imagesEmbedded: !useAssets,
      imagesWritten: imageResult.written.length,
      imagesFailed: imageResult.failed,
      ...textImageStats(planned),
      chars: html.length
    };
  };

  /** 路径是否落在本次导出过的目录里（防止 reveal 变成任意路径拉起口）。 */
  const allowedForReveal = (target) => {
    const resolved = resolve(target);
    if (exportedPaths.has(resolved)) return true;
    for (const dir of exportedDirs) {
      const rel = relative(dir, resolved);
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return true;
    }
    return exportedDirs.has(resolved);
  };

  const reveal = async (target, mode) => {
    if (typeof target !== "string" || target.trim() === "") throw fail("缺少路径", "bad-request");
    const resolved = resolve(target.trim());
    if (!allowedForReveal(resolved)) {
      throw fail("只能定位本次导出的文件", "forbidden");
    }
    try {
      await stat(resolved);
    } catch {
      throw fail(`路径不存在：${resolved}`, "not-found");
    }

    const detached = { detached: true, stdio: "ignore" };

    /*
     * Windows 上「打开文件」用 **`explorer.exe <路径>`**，不要用
     * `rundll32 url.dll,FileProtocolHandler`，也不要用 `cmd /c start`：
     * 实测（Node 的 spawn，与插件同一条路）后两者对中文/空格路径**静默失败** ——
     * 用户看到的就是"点了没反应"；`explorer.exe <文件>` 让资源管理器去走系统关联，
     * 同一份路径下能正常拉起关联程序（实测 Typora）。
     *
     * 也考虑过 Electron 的 `shell.openPath`（有返回值、能报错），但**拿不到**：
     * DSH 的 Electron 主进程是把 host 当**子进程** spawn 出去的
     * （`join(runtimeDir, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js")`），
     * 插件跑在那个纯 Node 子进程里，`import("electron")` 只会拿到 npm 上同名包的路径字符串。
     *
     * 代价：命令行这条路**拿不到结果**，所以返回值里只有"已请求系统打开"，
     * 不谎报成功（`opened` 保持 undefined）。
     *
     * 「定位到文件」还有个引号陷阱（实测踩过）：直接传 `/select,<路径>` 时，路径里的空格
     * 会让 libuv 把**整个参数**（连开关一起）包进引号 —— Explorer 收到
     * `"/select,C:\a b\f.md"` 就认不出这个开关了，退而打开默认目录
     * （实测：带 ` (2)` 的导出目录会打开"文档"）。正确写法是 `/select,"<路径>"`
     * 且**原样传参**：引号只包路径。
     */
    let command;
    let args;
    let options = detached;
    if (process.platform === "win32") {
      command = "explorer.exe";
      if (mode === "open") {
        args = [resolved];
      } else if (resolved.includes("\"")) {
        // 路径里有双引号（Windows 文件名不允许，但导出目录是用户给的）：不去拼命令行，
        // 退一步直接打开所在目录。
        args = [dirname(resolved)];
      } else {
        args = [`/select,"${resolved}"`];
        options = { ...detached, windowsVerbatimArguments: true };
      }
    } else if (process.platform === "darwin") {
      command = "open";
      args = mode === "open" ? [resolved] : ["-R", resolved];
    } else {
      command = "xdg-open";
      args = [mode === "open" ? resolved : dirname(resolved)];
    }

    const describe = {
      path: resolved,
      mode: mode === "open" ? "open" : "select",
      via: "spawn",
      command,
      args,
      verbatim: options.windowsVerbatimArguments === true
    };

    if (NO_SPAWN) {
      // 自测 / 脚本用：只算出会跑哪条命令，不真的拉起窗口（见 README「已知边界」）。
      return { ...describe, spawned: false };
    }

    const child = spawn(command, args, options);
    child.on("error", (error) => warn(`拉起 ${command} 失败: ${error?.message ?? error}`));
    child.unref();
    // 命令行这条路**拿不到结果**：成功失败都只能返回"已请求系统打开"。
    return { ...describe, spawned: true };
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        // 门禁：见文件头注释 —— 前缀路由不受 DSH 鉴权网关保护。
        if (req.headers?.[CALL_HEADER] !== CALL_HEADER_VALUE) {
          return send(res, 403, {
            ok: false,
            code: "forbidden",
            error: `缺少请求头 ${CALL_HEADER}: ${CALL_HEADER_VALUE}`
          });
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length) || "/"
          : "/";

        const readJson = async () => {
          const raw = await readBody(req);
          if (raw.trim() === "") return {};
          try { return JSON.parse(raw); }
          catch { throw fail("请求体不是合法 JSON", "bad-request"); }
        };

        if (req.method === "GET" && path === "/health") {
          return send(res, 200, {
            ok: true,
            result: {
              home,
              sessionsRoot,
              attachmentsRoot,
              defaultDir: await resolveDefaultDir(),
              limits: DEFAULT_LIMITS,
              maxEmbedBytes: MAX_EMBED_BYTES,
              requiresCallHeader: `${CALL_HEADER}: ${CALL_HEADER_VALUE}`
            }
          });
        }

        if (req.method === "GET" && path === "/sessions") {
          const limit = clampInt(url.searchParams.get("limit"), 20, 1, 50);
          return send(res, 200, {
            ok: true,
            result: { sessions: await listRecentSessions(sessionsRoot, limit) }
          });
        }

        if (req.method !== "POST") {
          return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
        }

        if (path === "/preview") return send(res, 200, { ok: true, result: await previewOf(await readJson()) });
        if (path === "/markdown") return send(res, 200, { ok: true, result: await markdownOf(await readJson()) });
        if (path === "/export") return send(res, 200, { ok: true, result: await exportOf(await readJson()) });
        if (path === "/reveal") {
          const body = await readJson();
          return send(res, 200, { ok: true, result: await reveal(body?.path, body?.mode) });
        }

        return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : undefined;
        const status = code === "bad-request" ? 400
          : code === "forbidden" ? 403
            : code === "not-found" ? 404
              : code === "empty" ? 409
                : code === "conflict" ? 409
                  : 500;
        warn(`api error (${req.method} ${req.url}): ${error?.message ?? error}`);
        return send(res, status, {
          ok: false,
          ...(code === undefined ? {} : { code }),
          error: error?.message ?? String(error)
        });
      }
    }
  }), "session-share: http api");
}
