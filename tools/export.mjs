#!/usr/bin/env node
/**
 * dsh-session-share — 命令行导出工具。
 *
 * 走的端点与界面点「分享会话」**完全一样**（同一份 host 半代码），所以：
 *   - 脚本能导出的东西，界面一定能导出；
 *   - 出问题时不必开界面，命令行就能复现。
 *
 * 用法：
 *   node tools/export.mjs --list                  # 最近会话（id / 标题 / 时间）
 *   node tools/export.mjs <sessionId> --preview   # 只打印预览（不落盘）
 *   node tools/export.mjs <sessionId> --format html --dir D:/share
 *   node tools/export.mjs <sessionId> --scope chat --format md
 *
 * 参数：
 *   --scope full|chat   内容范围（默认 full：完整记录）
 *   --format md|html    产物格式（默认 md；md 会新建同名文件夹把正文与图片装一起）
 *   --dir <绝对路径>     导出目录（默认 host 报的默认目录）
 *   --max-chars <N>     把长正文截断到 N 字符（**默认 0 = 不截断**）
 *   --preview           只打印 Markdown 预览，不写文件
 *   --reveal            导出后在资源管理器里定位产物
 */
import { call, flushLogs } from "./harness.mjs";

/** 原因码 → 中文短标签（与 client 半的 `TEXT_IMAGE_REASON_KEYS` 同一套码）。 */
const REASON_LABELS = [
  ["outside-cwd", "不在会话工作目录内"],
  ["missing", "文件不存在"],
  ["not-image", "扩展名不像图片"],
  ["remote", "是网址"],
  ["too-large", "超过 20 MB"],
  ["no-cwd", "会话没记工作目录"],
  ["too-many", "超出 50 张上限"]
];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const has = (name) => argv.includes(`--${name}`);

const fail = (message) => {
  console.error(`错误：${message}`);
  process.exitCode = 1;
};

/** 截断上限：默认不传（host 侧默认 0 = 不截断），传了才限制。 */
const limitsOf = () => {
  const raw = flag("max-chars", undefined);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    fail(`--max-chars 需要一个非负数字，收到：${raw}`);
    return {};
  }
  return { maxToolChars: value, maxReasoningChars: value, maxArgumentChars: value };
};

const main = async () => {
  if (argv.length === 0 || has("help")) {
    console.log("用法：node tools/export.mjs [--list | <sessionId> [--preview] [--scope full|chat] [--format md|html] [--dir <路径>] [--max-chars N] [--reveal]]");
    return;
  }

  if (has("list")) {
    const res = await call("GET", `/sessions?limit=${flag("limit", 15)}`);
    if (res?.ok !== true) return fail(res?.error ?? "列不出会话");
    for (const row of res.result.sessions) {
      console.log(`${row.sessionId}  ${row.mtime}  ${String(row.messages).padStart(4)} 条  ${row.title || "(无标题)"}`);
    }
    return;
  }

  const sessionId = argv.find((item) => !item.startsWith("--") && argv[argv.indexOf(item) - 1]?.startsWith("--") !== true);
  if (sessionId === undefined) return fail("缺少 sessionId（或用 --list 看看有哪些）");

  const scope = flag("scope", "full");
  if (has("preview")) {
    const res = await call("POST", "/preview", { sessionId, scope, ...limitsOf() });
    if (res?.ok !== true) return fail(res?.error ?? "预览失败");
    const { meta, stats, chars, imageCount, sample, sampleTruncated, textImagesResolved, textImagesSkipped } = res.result;
    console.log(`标题：${meta.title}`);
    console.log(`模型：${meta.provider}/${meta.model}`);
    console.log(`统计：${stats.userMessages} 用户 / ${stats.assistantMessages} 助手 / ${stats.toolCalls} 工具调用`
      + ` / ${imageCount} 图片 / 共 ${chars} 字符 / 跳过类型 ${JSON.stringify(stats.skippedTypes)}`);
    console.log(`正文引用图片：打包 ${textImagesResolved ?? 0}，跳过 ${textImagesSkipped ?? 0}`);
    console.log(`默认目录：${res.result.defaultDir}`);
    console.log(`--- 预览${sampleTruncated ? "（截断）" : ""} ---`);
    console.log(sample);
    return;
  }

  const res = await call("POST", "/export", {
    sessionId,
    scope,
    format: flag("format", "md"),
    dir: flag("dir", undefined),
    ...limitsOf()
  });
  if (res?.ok !== true) return fail(res?.error ?? "导出失败");
  const result = res.result;
  console.log(`导出成功：${result.files.map((file) => file.path).join("、")}`);
  if (result.folder !== undefined && result.folder !== result.dir) console.log(`整个文件夹：${result.folder}`);
  console.log(`图片 ${result.imageCount} 张（内嵌=${result.imagesEmbedded}，落盘 ${result.imagesWritten}，失败 ${result.imagesFailed}）`);
  if (result.textImageRefs > 0) {
    console.log(`正文里按路径引用的图片 ${result.textImageRefs} 处：打包 ${result.textImagesResolved}，跳过 ${result.textImagesSkipped}`);
    const reasons = result.textImageSkippedReasons ?? {};
    const detail = REASON_LABELS.filter(([code]) => Number(reasons[code]) > 0)
      .map(([code, label]) => `${label} ${reasons[code]} 处`);
    if (detail.length > 0) console.log(`  为什么跳过：${detail.join("、")}`);
    if (result.textImagesSkipped > 0) console.log(`  跳过的是：${result.textImageSkippedTargets.join("、")}`);
    if (result.textImagesSkipped > 0) console.log(`  逐条查：node tools/why-skipped.mjs ${sessionId}`);
  }
  if (has("reveal")) {
    const reveal = await call("POST", "/reveal", { path: result.files[0].path });
    if (reveal?.ok !== true) return fail(reveal?.error ?? "定位失败");
    console.log(`已定位：${reveal.result.path}`);
  }
  flushLogs();
};

await main();
