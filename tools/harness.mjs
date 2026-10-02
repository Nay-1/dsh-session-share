/**
 * 离线运行 host 半的最小脚手架 —— 给 tools/ 下的脚本与自测共用。
 *
 * 为什么能这么干：插件的全部能力都挂在 HTTP 端点上，而端点只依赖 `ctx.webServer`
 * 一个服务。这里用 mock ctx 把 `webServer.register` 截下来、直接调 handler，
 * 跑的是**与运行中的 DSH 完全相同**的那份代码 —— 所以改完插件不必等重启就能验证。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** 与 host 半同一套解析规则：DSH_HOME 优先，否则 ~/.dsh。 */
export const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
process.env.DSH_HOME = home;

const mod = await import("../lib/index.js");

const logs = [];
let route;

mod.apply({
  effect: (fn) => { const done = fn(); return typeof done === "function" ? done : () => {}; },
  webServer: { register: (spec) => { route = spec; return () => {}; } },
  logger: {
    info: (message) => logs.push(["info", message]),
    warn: (message) => logs.push(["warn", message]),
    error: (message) => logs.push(["error", message])
  }
});

if (route === undefined || typeof route.handler !== "function") {
  throw new Error("host 半没有注册路由 —— lib/index.js 的结构变了？");
}

/** 插件注册的 API 前缀（从它自己的注册信息里取，不写死）。 */
export const apiPrefix = route.path;

/** host 半写进 logger 的日志（每次取走即清空）。 */
export const drainLogs = () => {
  const taken = logs.slice();
  logs.length = 0;
  return taken;
};

/** 把日志按 `[host]` / `[host warn]` 前缀打到 stdout。 */
export const flushLogs = () => {
  for (const [level, message] of drainLogs()) {
    console.log(`  [host${level === "info" ? "" : ` ${level}`}] ${message}`);
  }
};

/**
 * 给插件的 handler 发一个请求。
 * @param method - HTTP 方法。
 * @param path - API 前缀之后的路径，如 `/preview`。
 * @param body - 可选 JSON 请求体。
 * @param options - `{ headers }`：默认带上调用头；传 `null` 可以**去掉**它（测门禁）。
 */
export const call = (method, path, body, options = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = options.headers === null
    ? {}
    : { "x-dsh-plugin-call": "1", ...(options.headers ?? {}) };
  const req = {
    method,
    url: `${apiPrefix}${path}`,
    headers,
    [Symbol.asyncIterator]: async function* () {
      if (payload !== "") yield Buffer.from(payload, "utf8");
    }
  };
  const res = {
    statusCode: 0,
    headers: {},
    setHeader: (name, value) => { res.headers[name] = value; },
    writeHead: (status, extra) => { res.statusCode = status; Object.assign(res.headers, extra ?? {}); },
    end: (raw) => {
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error(`响应不是 JSON: ${String(raw).slice(0, 200)}`)); }
    }
  };
  Promise.resolve(route.handler(req, res)).catch(reject);
});

/** 探活：顺带确认 host 半真的加载起来了。 */
export const health = async () => {
  const res = await call("GET", "/health");
  if (res?.ok !== true) throw new Error(`health 失败：${JSON.stringify(res)}`);
  return res.result;
};
