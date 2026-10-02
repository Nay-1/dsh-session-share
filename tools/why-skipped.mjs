/**
 * 排查用：打印某个会话里「正文按路径引用的图片」逐条为什么没打包。
 *
 * 只用肉眼看导出结果时，面板只给一个总数（「另有 N 处未打包」），
 * 想知道**具体是哪几处、卡在哪一步**就得跑这个。
 *
 * 运行：node tools/why-skipped.mjs [sessionId] [--scope full|chat]
 */
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { listRecentSessions, readSession, resolveDshHome } from "../lib/session-log.js";
import { buildTranscript, collectTextImageRefs } from "../lib/render.js";

const EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const argv = process.argv.slice(2);
const scope = argv.includes("--scope") ? argv[argv.indexOf("--scope") + 1] : "full";
const sessionsRoot = join(resolveDshHome(), "sessions");
let sessionId = argv.find((item) => !item.startsWith("--") && argv[argv.indexOf(item) - 1] !== "--scope");

if (sessionId === undefined) {
  const recent = await listRecentSessions(sessionsRoot, 1);
  sessionId = recent[0]?.sessionId;
  if (sessionId === undefined) {
    console.error("找不到会话");
    process.exit(1);
  }
  console.log(`（没给 sessionId，用最近改动的那个：${sessionId}）`);
}

const session = await readSession(sessionsRoot, sessionId);
if (session.ok !== true) {
  console.error(`读不出会话：${session.error}`);
  process.exit(1);
}
const model = buildTranscript(session.records, { malformed: session.malformed });
const refs = collectTextImageRefs(model, scope);
console.log(`会话：${model.title}`);
console.log(`工作目录（cwd）：${model.cwd}`);
console.log(`范围：${scope} · 正文里的图片引用共 ${refs.length} 处\n`);

const inside = (file) => {
  const rel = relative(model.cwd, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** 找出这处引用**出现在哪条消息的哪一行** —— 「原来是这句话里的文字被当成图了」。 */
const originOf = (target) => {
  const needles = [`](${target})`, `](<${target}>)`];
  for (const message of model.messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "text") continue;
      const line = String(block.text ?? "").split("\n")
        .find((row) => needles.some((needle) => row.includes(needle)));
      if (line !== undefined) return `${message.role}：${line.trim().slice(0, 120)}`;
    }
  }
  return undefined;
};

for (const [index, ref] of refs.entries()) {
  const raw = String(ref.target);
  const origin = originOf(raw);
  const line = `#${index + 1}  ${raw}${origin === undefined ? "" : `\n      ← ${origin}`}`;
  if (/^(https?:|data:|file:)/i.test(raw)) { console.log(`${line}\n      ✗ 是 URL / data URI，不是本地文件`); continue; }
  const decoded = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
  if (!EXT_RE.test(decoded)) { console.log(`${line}\n      ✗ 扩展名不是图片（png/jpg/jpeg/gif/webp/bmp/svg），看着像图其实是普通文字`); continue; }
  const file = isAbsolute(decoded) ? resolve(decoded) : resolve(model.cwd, decoded);
  if (!inside(file)) { console.log(`${line}\n      ✗ 解析到 ${file}\n        落在会话工作目录之外`); continue; }
  try {
    const info = await stat(file);
    if (!info.isFile()) { console.log(`${line}\n      ✗ ${file} 不是文件`); continue; }
    console.log(`${line}\n      ✓ 可以打包：${file}（${info.size} 字节）`);
  } catch {
    console.log(`${line}\n      ✗ 解析到 ${file}\n        这个文件**不存在**（引用它的是正文里的文字，不是真图）`);
  }
}
