/**
 * dsh-session-share — 会话工件的定位与读取。
 *
 * 会话落盘在 `<dshHome>/sessions/<slug>/<sessionId>/session.v4.jsonl[.zstd]`：
 * **多帧 zstd**，每帧解出来是一段 JSONL，第一行是 header，其余是事件记录。
 * 读取要解决三件事，都在这里：
 *   1. **定位**：目录名就是会话 id，但只认「会话根 / 一层 slug / 会话 id」这个结构，
 *      杜绝用请求里的字符串直接拼出越界路径。
 *   2. **解帧**：Node 的 zstd 解压只吃**一帧**，而工件是多帧拼接的，所以要按
 *      magic 切帧；magic 又可能恰好出现在压缩数据内部，于是每一帧都**试探式**解压，
 *      失败就把窗口扩到下一个 magic，直到解开或到文件末尾。
 *   3. **解压别占死事件循环**：一份工件整个解开可能上百 KB 到几 MB，
 *      一律走异步版 `zstdDecompress`（同步版会让 DSH 界面在导出期间卡住）。
 *
 * zstd 支持按需探测：运行时没有（Node < 22.15 / 23.8）就退化为「读不到内容」，
 * 上层据此如实报错，而不是抛一个栈里全是 zlib 的异常给用户看。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** 会话 id 的白名单形状：DSH 自己生成的是 `session-<uuid>`，但别把它写死。 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 与 DSH、与兄弟插件同一套解析规则：DSH_HOME 优先，否则 ~/.dsh。 */
export const resolveDshHome = () => {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".dsh");
};

/**
 * 三种形态都探一遍、`async` 优先。
 * 同步解压（`zstdDecompressSync`）会把事件循环占死 —— 导出要整份解开日志，
 * 用同步版等于「点一次分享，界面冻结一次」。
 */
let zstdApi;
const zstd = async () => {
  if (zstdApi === undefined) {
    try {
      const zlib = await import("node:zlib");
      zstdApi = {
        sync: typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync : undefined,
        async: typeof zlib.zstdDecompress === "function"
          ? (buffer) => new Promise((resolve, reject) => {
            zlib.zstdDecompress(buffer, (error, result) => (error ? reject(error) : resolve(result)));
          })
          : undefined
      };
    } catch {
      zstdApi = { sync: undefined, async: undefined };
    }
  }
  return zstdApi;
};

/** 工件文件名：压缩版 `.zstd` 与未压缩版 `.jsonl` 都认。 */
export const isSessionLogName = (name) => {
  const lower = name.toLowerCase();
  return lower.endsWith(".zstd") || lower.endsWith(".jsonl");
};

/**
 * 读出整份会话日志文本（多帧 zstd 或未压缩 jsonl）。读不到/解不开返回 undefined。
 *
 * 未知格式的行不会在这里被丢掉 —— 这里只管「字节 → 文本」，解析交给 render.js。
 */
export const readSessionLogText = async (file) => {
  let buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return undefined;
  }
  if (file.toLowerCase().endsWith(".jsonl")) return buffer.toString("utf8");

  const api = await zstd();
  if (api.async === undefined && api.sync === undefined) return undefined;

  const decode = async (slice) => {
    if (api.async !== undefined) {
      try { return await api.async(slice); } catch { return undefined; }
    }
    try { return api.sync(slice); } catch { return undefined; }
  };

  const parts = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (start === -1) break;
    let end = buffer.indexOf(ZSTD_MAGIC, start + 4);
    if (end === -1) end = buffer.length;

    let decoded;
    for (;;) {
      decoded = await decode(buffer.subarray(start, end));
      if (decoded !== undefined) break;
      const next = buffer.indexOf(ZSTD_MAGIC, end + 4);
      if (next === -1) {
        if (end === buffer.length) break; // 到末尾仍解不开 -> 放弃这一帧
        end = buffer.length;
      } else {
        end = next;
      }
    }
    if (decoded !== undefined) parts.push(decoded);
    cursor = end;
  }
  return Buffer.concat(parts).toString("utf8");
};

/** 会话目录名就是会话 id；只在会话根下的一层 slug 目录里找。 */
export const locateSessionDir = async (sessionsRoot, sessionId) => {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return undefined;
  let slugs;
  try {
    slugs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const candidate = join(sessionsRoot, slug.name, sessionId);
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch { /* 该 slug 下没有就继续 */ }
  }
  return undefined;
};

/**
 * 一个会话目录里的工件清单（按文件大小降序）。
 *
 * 正常情况下只有一个；滚动/迁移过的目录可能有多个副本，**取最大的那份**：
 * 事件是追加写的，大的那份是内容最全的。按名字排会掉进「.jsonl 排在 .zstd 前面」
 * 这种与内容量无关的巧合里。
 */
export const listSessionArtifacts = async (dir) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSessionLogName(entry.name)) continue;
    const file = join(dir, entry.name);
    try {
      const info = await stat(file);
      files.push({ file, name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
    } catch { /* 读不到就跳过 */ }
  }
  return files.sort((a, b) => b.size - a.size);
};

/** 逐行解析 JSONL；坏行只计数，不让一行脏数据废掉整次导出。 */
export const parseRecords = (text) => {
  const records = [];
  let malformed = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line);
      if (row !== null && typeof row === "object") records.push(row);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
};

/**
 * 读一个会话：定位目录 → 取最全的工件 → 解成记录数组。
 * @returns `{ ok: true, dir, file, header, records, malformed }` 或
 *          `{ ok: false, code, error }`（code 用于映射 HTTP 状态码）。
 */
export const readSession = async (sessionsRoot, sessionId) => {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return { ok: false, code: "bad-request", error: "会话 id 不合法" };
  }
  const dir = await locateSessionDir(sessionsRoot, sessionId);
  if (dir === undefined) {
    return { ok: false, code: "not-found", error: `找不到会话目录：${sessionId}` };
  }
  const artifacts = await listSessionArtifacts(dir);
  if (artifacts.length === 0) {
    // 空白会话（刚建、一条消息都没有）确实会没有工件 —— 这不是错误，是「没内容可分享」。
    return { ok: false, code: "empty", error: "这个会话还没有落盘内容（空会话）" };
  }

  let lastError;
  for (const artifact of artifacts) {
    const text = await readSessionLogText(artifact.file);
    if (text === undefined || text.trim() === "") {
      lastError = `读不出会话日志：${artifact.name}（zstd 支持缺失或文件损坏）`;
      continue;
    }
    const { records, malformed } = parseRecords(text);
    if (records.length === 0) {
      lastError = `会话日志里没有可解析的记录：${artifact.name}`;
      continue;
    }
    const header = records[0]?.type === "session" ? records[0] : undefined;
    return {
      ok: true,
      dir,
      file: artifact.file,
      header,
      records,
      malformed
    };
  }
  return { ok: false, code: "unreadable", error: lastError ?? "会话日志读取失败" };
};

/** 读清单时超过这个体积就跳过 —— 列个标题不值得把几十 MB 的日志全解开。 */
const LIST_READ_LIMIT_BYTES = 24 * 1024 * 1024;

/**
 * 最近改动的会话清单（给 CLI 与自测用）。
 *
 * 侧栏那套会话清单在客户端手里（工作区账本 + 投影缓存），host 半拿不到；
 * 这里直接扫会话工件目录，按 mtime 倒序 —— 事实来源相同（都是磁盘），少一层依赖。
 * 标题取自 `session/title`，读不出来就退回第一条用户消息的首行。
 */
export const listRecentSessions = async (sessionsRoot, limit = 20) => {
  const max = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const candidates = [];
  let slugs;
  try {
    slugs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(sessionsRoot, slug.name);
    let sessions;
    try {
      sessions = await readdir(slugDir, { withFileTypes: true });
    } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const artifacts = await listSessionArtifacts(join(slugDir, session.name));
      const newest = artifacts[0];
      if (newest === undefined) continue;
      candidates.push({
        sessionId: session.name,
        slug: slug.name,
        file: newest.file,
        size: newest.size,
        mtimeMs: newest.mtimeMs
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const rows = [];
  for (const candidate of candidates.slice(0, max)) {
    const row = {
      sessionId: candidate.sessionId,
      slug: candidate.slug,
      file: candidate.file,
      sizeBytes: candidate.size,
      mtime: new Date(candidate.mtimeMs).toISOString(),
      title: "",
      cwd: "",
      messages: 0,
      readable: false
    };
    if (candidate.size <= LIST_READ_LIMIT_BYTES) {
      const text = await readSessionLogText(candidate.file);
      if (text !== undefined) {
        const { records } = parseRecords(text);
        const header = records[0]?.type === "session" ? records[0] : undefined;
        row.cwd = typeof header?.cwd === "string" ? header.cwd : "";
        for (const record of records) {
          if (record?.type === "session/title" && typeof record.data?.title === "string") row.title = record.data.title;
          if (record?.type === "user/message" || record?.type === "assistant/message") row.messages += 1;
          if (row.title === "" && record?.type === "user/message") {
            const block = (record.data?.content ?? []).find((item) => item?.type === "text");
            if (typeof block?.text === "string") row.title = block.text.split("\n")[0].slice(0, 60);
          }
        }
        row.readable = true;
      }
    }
    rows.push(row);
  }
  return rows;
};
