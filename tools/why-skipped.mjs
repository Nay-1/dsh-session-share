/**
 * 排查用：打印某个会话里「正文按路径引用的图片」逐条为什么没打包。
 *
 * 面板只给一个总数（「另有 N 处正文图片引用没能打包（K 处文件不存在）」），
 * 想知道**具体是哪几处、出现在哪句话里、卡在哪一步**就跑这个。
 * 判定走的是 host 半**同一个** `classifyTextImage` —— 这里说"能打包"，
 * 导出时就一定会打包，不会出现两套说法。
 *
 * 运行：node tools/why-skipped.mjs [sessionId] [--scope full|chat]
 */
import { join } from "node:path";

import { classifyTextImage } from "../lib/index.js";
import { listRecentSessions, readSession, resolveDshHome } from "../lib/session-log.js";
import { buildTranscript, collectTextImageRefs } from "../lib/render.js";

/** 原因码 → 人话（与 client 半的 `TEXT_IMAGE_REASON_KEYS` 同一套码）。 */
const REASONS = {
  "outside-cwd": "不在会话工作目录内（只打包这个会话干活的那个文件夹里的图）",
  missing: "这个文件不存在了（正文引用了它，但磁盘上没有）",
  "not-image": "扩展名不像图片，看着像图其实是普通文字",
  remote: "是网址 / data URI，不是本地文件",
  "too-large": "单张超过 20 MB",
  "no-cwd": "会话没记工作目录，无法解析相对路径",
  "too-many": "超出整篇 50 张的上限"
};

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
console.log(`工作目录（cwd）：${model.cwd || "(会话没记)"}`);
console.log(`范围：${scope} · 正文里的图片引用共 ${refs.length} 处\n`);

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

let ok = 0;
let bad = 0;
for (const [index, ref] of refs.entries()) {
  const target = String(ref.target);
  const origin = originOf(target);
  console.log(`#${index + 1}  ${target}`);
  if (origin !== undefined) console.log(`      ← ${origin}`);
  const verdict = await classifyTextImage(model.cwd, target);
  if (verdict.file === undefined) {
    bad += 1;
    console.log(`      ✗ 没能打包：${REASONS[verdict.reason] ?? verdict.reason}`);
  } else {
    ok += 1;
    console.log(`      ✓ 会打包：${verdict.file}（${verdict.bytes} 字节）`);
  }
}

if (refs.length > 0) console.log(`\n合计：能打包 ${ok} 处，没能打包 ${bad} 处`);
