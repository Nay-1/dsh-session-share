/**
 * dsh-session-share — Client 半自测。
 *
 * 用 mock 的 Module Loader / React 运行时 / primitives / fetch / document
 * 把客户端插件真的跑起来：注册契约、菜单项点击、面板渲染、导出与复制请求、
 * 失败路径都检查一遍。
 *
 * 迷你 React 运行时支持这个组件真正用到的那几个 hook（useState / useEffect /
 * useRef / useCallback / useSyncExternalStore），并按依赖数组判断要不要重跑
 * effect —— 所以「取预览 → 拿到默认目录 → 填进输入框」这条真实链路是被跑到的，
 * 不是靠手工塞 state 装出来的。
 *
 * 运行：node test-client.mjs
 */

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

/* ---- 迷你 React 运行时 --------------------------------------------------- */
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((value, index) => value === b[index]);

let hooks = [];
let cursor = 0;
let pendingEffects = [];
let dirty = false;
let instance = null;

const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false && child !== true);
    const next = { ...(props ?? {}) };
    if (flat.length > 0) next.children = flat.length === 1 ? flat[0] : flat;
    return { __el: true, type, props: next };
  },
  useState(initial) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
    const set = (value) => {
      const next = typeof value === "function" ? value(hooks[index]) : value;
      if (next === hooks[index]) return;
      hooks[index] = next;
      dirty = true;
    };
    return [hooks[index], set];
  },
  useEffect(fn, deps) {
    const index = cursor++;
    const previous = hooks[index];
    if (previous === undefined || !sameDeps(previous.deps, deps)) pendingEffects.push(fn);
    hooks[index] = { deps };
  },
  useRef(value) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = { current: value };
    return hooks[index];
  },
  useCallback(fn, deps) {
    const index = cursor++;
    const previous = hooks[index];
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn;
    hooks[index] = { fn, deps };
    return fn;
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const [value, setValue] = React.useState(getSnapshot);
    React.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot]);
    return value;
  }
};

/** 挂一个组件实例：render() 渲染 + 冲 effects + 必要时重渲染。 */
const mount = (Component, props) => {
  const self = {
    hooks: [],
    tree: null,
    cleanups: [],
    render() {
      for (let round = 0; round < 40; round += 1) {
        hooks = self.hooks;
        cursor = 0;
        pendingEffects = [];
        dirty = false;
        self.tree = Component(props);
        const effects = pendingEffects;
        pendingEffects = [];
        for (const effect of effects) {
          const cleanup = effect();
          if (typeof cleanup === "function") self.cleanups.push(cleanup);
        }
        if (!dirty) return self.tree;
      }
      throw new Error("渲染没有收敛：effect 一直在改状态");
    },
    /** 等异步链路（fetch/微任务）落定，并在状态变化后重渲染。 */
    async settle(rounds = 10) {
      for (let index = 0; index < rounds; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (dirty || pendingEffects.length > 0) self.render();
      }
      return self.tree;
    }
  };
  instance = self;
  return self;
};

/* ---- 元素树工具 ---------------------------------------------------------- */
// 面板的开关状态在 Modal 的 props 上：组件本身总返回一个 Modal 元素，
// 由 Modal 决定 open=false 时渲染 null（primitives 的真实行为）。
const panelOpen = (tree) => tree !== null && tree !== undefined && tree.props?.open === true;

const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const item of node) walk(item, out); return out; }
  if (typeof node !== "object") return out;
  if (node.__el === true) {
    out.push(node);
    // 元素可能藏在任意 props 里（children / footer / icon…），全都走一遍。
    for (const value of Object.values(node.props ?? {})) walk(value, out);
  }
  return out;
};
const textOf = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node.__el === true) return textOf(node.props?.children);
  return "";
};
const treeText = (tree) => walk(tree).map((node) => textOf(node)).join(" ");
const byText = (tree, needle) => walk(tree).find((node) => typeof node.props?.onClick === "function" && textOf(node).includes(needle));
const inputNode = (tree) => walk(tree).find((node) => node.type === MockInput);
const previewBox = (tree) => walk(tree).find((node) => node.type === "pre" && node.props?.className === "dss-preview");

/* ---- DOM / 浏览器 mock --------------------------------------------------- */
const styleTags = [];
globalThis.document = {
  querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
  createElement: () => ({ dataset: {}, textContent: "", style: {} }),
  head: { appendChild: (element) => styleTags.push(element) },
  addEventListener: () => {},
  removeEventListener: () => {},
  execCommand: () => false
};
const storage = new Map();
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { globalThis.__loadedDefinition = definition; } },
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)
  }
};
const clipboardWrites = [];
// Node 24 自带只读的 globalThis.navigator，得用 defineProperty 覆盖它。
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: async (text) => { clipboardWrites.push(text); } } }
});

/* ---- primitives mock ----------------------------------------------------- */
const TRACE = { menuSelects: 0 };
const MockMenuItemButton = function MockMenuItemButton(props) { return props.children ?? null; };
const MockIcon = function MockIcon() { return null; };
/**
 * 关键：`Button` 与 `Input` 在真 primitives 里是 **`forwardRef` 的产物（对象）**，
 * 不是函数。mock 必须复刻这个形状 —— 用函数 mock 会掩盖「按 typeof === "function"
 * 探测可用性」那个真实 bug（它让插件悄悄退回自绘兜底按钮）。
 */
const forwardRefLike = (render) => ({ $$typeof: Symbol.for("react.forward_ref"), render });
const MockButton = forwardRefLike(function MockButtonRender(props) { return React.createElement("button", props); });
const MockInput = forwardRefLike(function MockInputRender(props) { return React.createElement("input", props); });
const MockModal = function MockModal(props) {
  if (props.open !== true) return null;
  return React.createElement("div", { className: "mock-modal" }, props.description, props.children, props.footer);
};
const MockSegmented = function MockSegmented(props) { return React.createElement("div", { className: "mock-seg" }, props.options.map((o) => o.label).join("/")); };
const MockCheckbox = function MockCheckbox(props) { return React.createElement("label", {}, props.label); };
const primitives = {
  MenuItemButton: MockMenuItemButton,
  IconShareOutlineRegular: MockIcon,
  Button: MockButton,
  Modal: MockModal,
  SegmentedControl: MockSegmented,
  Checkbox: MockCheckbox,
  Input: MockInput,
  writeClipboard: async (text) => { clipboardWrites.push(text); return true; }
};

const requireShim = (name) => {
  if (name === "react") return React;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error(`unexpected require: ${name}`);
};

/* ---- fetch mock ---------------------------------------------------------- */
const requests = [];
const PREVIEW = {
  ok: true,
  result: {
    scope: "full",
    meta: { sessionId: "session-x", title: "测试会话标题", createdAtText: "2026-10-02 18:00" },
    stats: { userMessages: 3, assistantMessages: 2, toolCalls: 4, images: 1, malformed: 0, skippedTypes: {} },
    baseName: "测试会话标题-20261002-1800",
    defaultDir: "D:/fixture-default",
    chars: 1234,
    imageCount: 1,
    sample: "# 测试会话标题\n\n> 由 DeepSeek Harness 导出\n\n## 🧑 用户\n\n帮我看看崩溃日志",
    // 故意置 true：预览确实是片段，但面板**不该**再提示这件事
    // （早先预览下方有一行「预览只显示前 8000 字符…」，用户要求去掉）。
    sampleTruncated: true
  }
};
let routes = {};
const defaultRoutes = () => ({
  "/session-share/api/preview": () => PREVIEW,
  "/session-share/api/markdown": () => ({ ok: true, result: { markdown: "# 全文\n正文", chars: 7, baseName: "b", imageCount: 0 } }),
  "/session-share/api/export": (body) => ({
    ok: true,
    result: {
      format: body.format,
      scope: body.scope,
      dir: body.dir,
      baseName: "测试会话标题-20261002-1800",
      meta: { title: "测试会话标题" },
      files: [{ kind: body.format, path: `D:/fixture-default/测试会话标题-20261002-1800.${body.format}`, bytes: 10 }],
      imageCount: 1,
      imagesEmbedded: body.format === "html",
      imagesWritten: body.format === "html" ? 0 : 1,
      imagesFailed: 0,
      // 正文里有 3 处图片引用没能打包：面板必须如实说出**原因**，不能一律说成
      // "不在会话工作目录内"（那 1 处是"文件不存在"，用户拿着旧说法会查不到东西）
      textImageRefs: 4,
      textImagesResolved: 1,
      textImagesSkipped: 3,
      textImageSkippedTargets: ["../outside.jpg"],
      textImageSkippedReasons: { "outside-cwd": 2, missing: 1 },
      chars: 10
    }
  }),
  "/session-share/api/reveal": (body) => ({ ok: true, result: { path: body.path, mode: body.mode } })
});
routes = defaultRoutes();
globalThis.fetch = async (url, init) => {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  requests.push({ url, init, body });
  const handler = routes[url];
  const payload = handler === undefined ? { ok: false, error: `unexpected ${url}` } : handler(body);
  return { status: 200, json: async () => payload };
};

/* ---- 加载 client 半 ------------------------------------------------------ */
await import(new URL("./lib/client.js", import.meta.url).href);
const definition = globalThis.__loadedDefinition;
check("Module Loader 收到注册调用", definition !== undefined);
check("loader id 与包名一致", definition?.id === "dsh-session-share");

const mod = definition.factory(requireShim);
check("导出 apply", typeof mod.apply === "function");
check("导出 inject（slots + locale）",
  Array.isArray(mod.inject) && ["slots", "locale"].every((key) => mod.inject.includes(key)));

/* ---- 应用 ---------------------------------------------------------------- */
const localeRegistrations = [];
const injectedSlots = [];
const registered = [];
const ctx = {
  effect: (fn) => { fn(); },
  locale: {
    register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }); },
    bind: (ns) => (key, params) => {
      const template = localeRegistrations.at(-1)?.dicts?.zh?.[key] ?? key;
      if (params === undefined) return template;
      return Object.keys(params).reduce((text, name) => text.split(`{${name}}`).join(String(params[name])), template);
    }
  },
  slots: {
    inject: (name, install) => { injectedSlots.push(name); install(); },
    register: (spec, Component) => { registered.push({ spec, Component }); }
  }
};

mod.apply(ctx);

check("注册了 zh/en 字典", localeRegistrations.length === 1 && localeRegistrations[0].ns === "session-share"
  && localeRegistrations[0].dicts.zh["menu.share"] === "分享会话");
check("注入了菜单项 slot", injectedSlots.includes("sidebar.workspaces.session.menu.item"));
check("注入了 shell.overlay（面板本体）", injectedSlots.includes("shell.overlay"));
check("注册了两个条目", registered.length === 2, String(registered.length));

const menuEntry = registered.find((entry) => entry.spec.name === "sidebar.workspaces.session.menu.item");
const panelEntry = registered.find((entry) => entry.spec.name === "shell.overlay");
check("菜单项 id 稳定", menuEntry?.spec.id === "session-share");
check("菜单项 order=450（归档 400 之后、删除 500 之前）", menuEntry?.spec.order === 450);
check("面板 id 带包名前缀", panelEntry?.spec.id === "session-share.panel");
check("样式标签注入了一次", styleTags.length === 1 && styleTags[0].dataset.plugin === "dsh-session-share");
// 回归：兜底强调按钮曾经是「实心填充 + 硬编码 #fff 文字」，深色主题下
// --dsw-alias-brand-primary 近白 → 白底白字，整个按钮看不见。
check("兜底强调按钮不硬编码前景色", !styleTags[0].textContent.includes("color:#fff"));

/* ---- 菜单项 -------------------------------------------------------------- */
const t = ctx.locale.bind("session-share");
const menuFace = menuEntry.spec.inject();
check("inject face 暴露 openShare", typeof menuFace.openShare === "function");

let menuClosed = false;
const menuTree = menuEntry.Component({
  sessionId: "session-x",
  displayTitle: "测试会话标题",
  useMenuOpenState: () => [true, (next) => { if (next === false) menuClosed = true; }],
  t,
  ...menuFace
});
check("渲染的是 MenuItemButton", menuTree.type === MockMenuItemButton);
check("前面带了分享图标", menuTree.props.icon !== undefined && menuTree.props.icon.type === MockIcon);
check("文案为「分享会话」", menuTree.props.children === "分享会话");
check("不带分组分隔线", menuTree.props.separatorBefore === undefined);

// 点击：先关菜单，再开面板
const panel = mount(panelEntry.Component, { t, ...panelEntry.spec.inject() });
check("面板初始不显示", panelOpen(panel.render()) === false);

menuTree.props.onSelect();
check("点击后菜单被关闭", menuClosed === true);
check("点击后面板打开", panelOpen(panel.render()) === true);

/* ---- 面板：取预览 -------------------------------------------------------- */
await panel.settle();
const previewRequest = requests.filter((request) => request.url.endsWith("/preview"));
check("打开面板后请求了 /preview", previewRequest.length === 1, JSON.stringify(requests.map((r) => r.url)));
check("预览请求带 sessionId 与 scope=full",
  previewRequest[0].body.sessionId === "session-x" && previewRequest[0].body.scope === "full");
check("请求带上调用头", previewRequest[0].init.headers["x-dsh-plugin-call"] === "1");
check("预览正文渲染出来了", treeText(panel.tree).includes("帮我看看崩溃日志"));
// 回归：预览是片段（sampleTruncated=true），但面板不再多一行截断说明。
check("预览下方不再出现截断提示", !treeText(panel.tree).includes("预览只显示"));
check("统计行用真实数字", treeText(panel.tree).includes("3 条用户消息") && treeText(panel.tree).includes("4 次工具调用"));
check("默认目录填进了输入框（学会的默认值）", inputNode(panel.tree)?.props.value === "D:/fixture-default", inputNode(panel.tree)?.props.value);
// 回归：primitives 的 Button / Input 是 forwardRef 的**对象**，早先按
// `typeof === "function"` 探测会把它们判成不存在 → 静默退回自绘兜底按钮
// （深色主题下兜底的白字撞上近白底 = 按钮看不见）。
check("forwardRef 形状的 Button 被认出来并真的用上",
  byText(panel.tree, "导出 HTML")?.type === MockButton,
  String(byText(panel.tree, "导出 HTML")?.type?.displayName ?? typeof byText(panel.tree, "导出 HTML")?.type));
check("forwardRef 形状的 Input 被认出来并真的用上", inputNode(panel.tree)?.type === MockInput);
check("面板副标题是会话标题", treeText(panel.tree).includes("测试会话标题"));

/* ---- 面板：导出 ---------------------------------------------------------- */
console.log("\n[面板：导出]");
const mdButton = byText(panel.tree, "导出 .md");
check("找到「导出 .md」按钮", mdButton !== undefined);
mdButton.props.onClick();
check("导出中按钮进入忙碌态（防重复点击）",
  byText(panel.render(), "处理中…") !== undefined && byText(panel.tree, "关闭") !== undefined);
await panel.settle();
const exportRequest = requests.filter((request) => request.url.endsWith("/export"));
check("请求了 /export", exportRequest.length === 1);
check("导出参数带上了目录与格式",
  exportRequest[0].body.format === "md" && exportRequest[0].body.dir === "D:/fixture-default" && exportRequest[0].body.scope === "full",
  JSON.stringify(exportRequest[0].body));
check("状态行报出导出路径", treeText(panel.tree).includes("D:/fixture-default/测试会话标题-20261002-1800.md"));
check("如实说明图片去了 .assets 目录", treeText(panel.tree).includes(".assets"));
// 正文里按路径引用的图片若打包不了，必须说出来 —— 否则用户只会看到"我写的图不见了"
check("如实报出未打包的正文图片引用", treeText(panel.tree).includes("3 处正文图片引用"), treeText(panel.tree).slice(0, 200));
// 而且要说**为什么**：旧文案一律写成"不在会话工作目录内"，用户拿着这句话去查会查不到
// 东西（他真正遇到的可能是"文件没了"）。这里 host 报了 2 处越界 + 1 处不存在，两条都要出现。
check("未打包的原因分开说（越界 / 不存在）",
  treeText(panel.tree).includes("2 处不在会话工作目录内") && treeText(panel.tree).includes("1 处文件不存在"),
  treeText(panel.tree).slice(0, 300));
check("目录记进了 localStorage", storage.get("dsh-session-share.dir") === "D:/fixture-default");
check("导出后出现「打开所在文件夹」", byText(panel.tree, "打开所在文件夹") !== undefined);

const revealButton = byText(panel.tree, "打开所在文件夹");
revealButton.props.onClick();
await panel.settle();
const revealRequest = requests.filter((request) => request.url.endsWith("/reveal"));
check("/reveal 带上导出路径与 mode=select",
  revealRequest.length === 1 && revealRequest[0].body.path.endsWith(".md") && revealRequest[0].body.mode === "select");

const htmlButton = byText(panel.tree, "导出 HTML");
htmlButton.props.onClick();
await panel.settle();
const htmlRequest = requests.filter((request) => request.url.endsWith("/export")).at(-1);
check("导出 HTML 时如实说明内嵌", htmlRequest.body.format === "html" && treeText(panel.tree).includes("内嵌"));

/* ---- 面板：复制 Markdown ------------------------------------------------- */
console.log("\n[面板：复制]");
const copyButton = byText(panel.tree, "复制 Markdown");
copyButton.props.onClick();
await panel.settle();
check("复制前先取全文", requests.some((request) => request.url.endsWith("/markdown")));
check("剪贴板收到的就是全文", clipboardWrites.at(-1) === "# 全文\n正文", JSON.stringify(clipboardWrites.at(-1)));
check("状态行报出字符数", treeText(panel.tree).includes("7 字符"));

/* ---- 面板：切换内容范围 -------------------------------------------------- */
console.log("\n[面板：切换范围]");
// 每次都从**当前**树里取切换控件：元素上挂着的那份 onChange 闭包捕的是上一次渲染的
// scope，拿旧元素去点会命中它自己的「值没变就不动」判断 —— 这是测试要避的坑，
// 不是组件的问题（真实 React 每次渲染都会给出新的闭包）。
const scopeToggle = () => walk(panel.tree).find((node) => node.type === MockSegmented);
const segmented = scopeToggle();
check("渲染了内容范围切换", segmented !== undefined && segmented.props.options.length === 2);
const before = requests.filter((request) => request.url.endsWith("/preview")).length;
segmented.props.onChange("chat");
// 只渲染、不等响应：这一帧就是用户点下去瞬间看到的样子。
panel.render();
check("切换范围时保留上一份预览（不塌成「读取中…」）", treeText(panel.tree).includes("帮我看看崩溃日志"));
check("切换范围时按钮不禁用（不闪一下灰）", byText(panel.tree, "导出 .md")?.props.disabled === false);
check("保留期间预览标记为 stale（压淡当进度提示）", previewBox(panel.tree)?.props["data-stale"] === "true");
await panel.settle();
const after = requests.filter((request) => request.url.endsWith("/preview"));
check("切到「仅对话」后重新取预览", after.length === before + 1);
check("新请求带 scope=chat", after.at(-1).body.scope === "chat");
check("响应到达后 stale 标记消失", previewBox(panel.tree)?.props["data-stale"] === undefined);

/* ---- 面板：失败路径 ------------------------------------------------------ */
console.log("\n[面板：失败路径]");
routes = defaultRoutes();
routes["/session-share/api/preview"] = () => ({ ok: false, error: "这个会话还没有落盘内容（空会话）" });
scopeToggle().props.onChange("full");
await panel.settle();
check("失败时显示原因", treeText(panel.tree).includes("空会话"), treeText(panel.tree).slice(0, 160));
check("失败时禁用导出按钮", byText(panel.tree, "导出 .md")?.props.disabled === true);
check("失败时禁用复制按钮", byText(panel.tree, "复制 Markdown")?.props.disabled === true);

routes["/session-share/api/preview"] = () => ({ ok: false, error: "HTTP 500" });
scopeToggle().props.onChange("chat");
await panel.settle();
check("host 半没响应时给出可读提示", treeText(panel.tree).includes("host 半可能未加载"));

/* ---- 面板：关闭 ---------------------------------------------------------- */
console.log("\n[面板：关闭]");
routes = defaultRoutes();
scopeToggle().props.onChange("full");
await panel.settle();
const closeButton = byText(panel.tree, "关闭");
closeButton.props.onClick();
check("点关闭后面板收起", panelOpen(panel.render()) === false);

/* ---- primitives 缺件时不留 undefined 给 createElement -------------------- */
console.log("\n[降级]");
const bareDefinition = definition;
const bareMod = bareDefinition.factory((name) => {
  if (name === "react") return React;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
  throw new Error(`unexpected require: ${name}`);
});
const bareRegistered = [];
bareMod.apply({
  effect: (fn) => { fn(); },
  locale: ctx.locale,
  slots: {
    inject: (slotName, install) => { install(); },
    register: (spec, Component) => { bareRegistered.push({ spec, Component }); }
  }
});
let bareThrew = false;
try {
  const bareMenu = bareRegistered.find((entry) => entry.spec.name === "sidebar.workspaces.session.menu.item");
  const bareTree = bareMenu.Component({ sessionId: "session-x", displayTitle: "t", t, ...bareMenu.spec.inject() });
  check("primitives 全缺时菜单项仍能渲染", bareTree !== undefined && bareTree.type !== undefined);
  const barePanel = mount(bareRegistered.find((entry) => entry.spec.name === "shell.overlay").Component, { t });
  barePanel.render();
  bareMenu.Component({ sessionId: "session-x", displayTitle: "t", t, ...bareMenu.spec.inject() }).props.onSelect();
  barePanel.render();
  check("primitives 全缺时面板仍能渲染", walk(barePanel.tree).length > 0);
} catch (error) {
  bareThrew = true;
  check("primitives 全缺时不抛错", false, error?.message);
}
if (!bareThrew) check("primitives 全缺时不抛错", true);

console.log(`\n${pass}/${pass + failed} 通过`);
process.exitCode = failed === 0 ? 0 : 1;
