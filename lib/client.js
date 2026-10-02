/**
 * dsh-session-share — Client half.
 *
 * 两处注册，都在同一个模块里协作：
 *   1. `sidebar.workspaces.session.menu.item` —— 会话行 “...” 菜单里加一项
 *      「分享会话」。内置条目的 order 是 pin=100 / rename=200 / fork=300 /
 *      archive=400，本项取 450：夹在「归档会话」和兄弟插件的「删除会话」(500)
 *      之间 —— 分享是只读动作，不该排在破坏性动作后面。
 *   2. `shell.overlay` —— 分享面板本体。菜单项只负责「打开」，面板挂在框架级
 *      浮层上，所以菜单一关、侧栏一滚，面板都不受影响（primitives 的 Modal
 *      还会把面板 portal 到 document.body，并接管 Escape 与遮罩点击）。
 *
 * 两边靠一个模块级的小 store 通信：菜单项在 React 树的一个角落里，面板在另一个
 * 角落里，中间没有共同的父组件可以提升 state。store 用 `useSyncExternalStore`
 * 订阅（宿主 React 18+ 一定有；万一没有就退回 useState + subscribe）。
 *
 * 数据与动作全部走 host 半的 `/session-share/api`：客户端不读文件、不拼路径，
 * 只负责「选内容范围 → 拿预览 → 要产物 → 报结果」。
 *
 * 打包形态：DSH 的 Module Loader 包（factory(require)），无构建步骤；
 * 样式随组件注入一个 <style> 标签，沿用内置页面的 --dsw-* 设计变量。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-share",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives") ?? {};

    const NS = "session-share";
    const API = "/session-share/api";
    /**
     * 与 host 半约定的调用头。插件的前缀路由不受 DSH 鉴权网关保护，host 侧因此
     * 要求这个自定义头：它必然触发 CORS 预检，而 host 不返回 CORS 头 —— 于是
     * 浏览器里任意网页都发不出导出请求。同源 fetch 带自定义头不触发预检，照常工作。
     */
    const CALL_HEADER = "x-dsh-plugin-call";
    const CALL_HEADER_VALUE = "1";
    const DIR_STORAGE_KEY = "dsh-session-share.dir";
    const PREVIEW_MAX_CHARS = 8000;

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */
    const zh = {
      "menu.share": "分享会话",
      "panel.title": "分享会话",
      "panel.close": "关闭",
      "panel.scope": "内容范围",
      "panel.scopeFull": "完整记录",
      "panel.scopeChat": "仅对话",
      "panel.injected": "包含 DSH 自动注入的上下文（system-reminder / 运行环境快照）",
      "panel.preview": "预览",
      "panel.loading": "读取中…",
      "panel.empty": "这个会话还没有内容可分享。",
      "panel.stats": "{user} 条用户消息 · {assistant} 条助手回复 · {tools} 次工具调用 · {images} 张图片 · 约 {chars} 字符",
      "panel.copy": "复制 Markdown",
      "panel.exportMd": "导出 .md",
      "panel.exportHtml": "导出 HTML",
      "panel.dir": "保存目录",
      "panel.busy": "处理中…",
      "panel.copied": "已复制到剪贴板（{chars} 字符）",
      "panel.copyFailed": "复制失败，请手动选中预览内容复制",
      "panel.exported": "已导出：{path}",
      "panel.exportedMulti": "已导出 {count} 个文件：{path}",
      "panel.imagesInAssets": "另有 {count} 张图片在同名 .assets 目录里",
      "panel.imagesFailedSuffix": "，{count} 张读取失败（源文件不在了）",
      "panel.imagesMissing": "{count} 张图片一张都没写出来（附件源文件已不在），正文里的图片链接会失效",
      "panel.imagesEmbedded": "{count} 张图片已内嵌进这个单文件",
      "panel.textImagesSkipped": "另有 {count} 处正文图片引用不在会话工作目录内，未打包",
      "panel.copyPath": "复制路径",
      "panel.pathCopied": "路径已复制",
      "panel.reveal": "打开所在文件夹",
      "panel.open": "打开文件",
      "panel.revealed": "已在资源管理器中定位",
      "panel.opened": "已用系统默认程序打开",
      "panel.openedNotepad": "这个类型没有默认程序，已用记事本打开",
      "panel.openRequested": "已请求系统打开",
      "panel.openFailedLocated": "系统里没有能打开这个类型的程序{message}，已为你定位到文件",
      "panel.error": "出错了：{message}",
      "panel.noapi": "导出接口没有响应，host 半可能未加载"
    };
    const en = {
      "menu.share": "Share session",
      "panel.title": "Share session",
      "panel.close": "Close",
      "panel.scope": "Scope",
      "panel.scopeFull": "Full record",
      "panel.scopeChat": "Conversation only",
      "panel.injected": "Include DSH-injected context (system reminders, runtime snapshot)",
      "panel.preview": "Preview",
      "panel.loading": "Loading…",
      "panel.empty": "This session has nothing to share yet.",
      "panel.stats": "{user} user messages · {assistant} assistant replies · {tools} tool calls · {images} images · ~{chars} chars",
      "panel.copy": "Copy Markdown",
      "panel.exportMd": "Export .md",
      "panel.exportHtml": "Export HTML",
      "panel.dir": "Save to",
      "panel.busy": "Working…",
      "panel.copied": "Copied to clipboard ({chars} chars)",
      "panel.copyFailed": "Copy failed; select the preview text manually",
      "panel.exported": "Exported: {path}",
      "panel.exportedMulti": "Exported {count} files: {path}",
      "panel.imagesInAssets": "{count} image(s) in the sibling .assets folder",
      "panel.imagesFailedSuffix": "; {count} could not be read (source file is gone)",
      "panel.imagesMissing": "None of the {count} image(s) could be written (source files are gone); image links in the text will be broken",
      "panel.imagesEmbedded": "{count} image(s) embedded in this single file",
      "panel.textImagesSkipped": "{count} inline image reference(s) point outside the session workspace and were not packaged",
      "panel.copyPath": "Copy path",
      "panel.pathCopied": "Path copied",
      "panel.reveal": "Show in folder",
      "panel.open": "Open file",
      "panel.revealed": "Revealed in the file manager",
      "panel.opened": "Opened with the system default app",
      "panel.openedNotepad": "No app is associated with this file type; opened it in Notepad",
      "panel.openRequested": "Asked the system to open it",
      "panel.openFailedLocated": "No app is associated with this file type{message}; revealed it in the folder instead",
      "panel.error": "Failed: {message}",
      "panel.noapi": "Export endpoint did not respond; the host half may not be loaded"
    };

    /* ------------------------------------------------------------------ *
     * 样式：沿用内置页面的 --dsw-* 设计变量。
     *
     * 每个变量都带 fallback 链：**这套变量名不在公开主题契约里**（契约只列了
     * label-primary / bg-layer-* / border-l1-l2 / state-* 这些），内置页面用的是
     * 更细的别名（label-tertiary、border-l3/l4、radius-md/xl）。别名在当前版本
     * 都存在，但换版本就可能被改名 —— 带 fallback 时最坏情况是「颜色退成中性色」，
     * 不带就是「字看不见」。
     * ------------------------------------------------------------------ */
    const css = `
/* 卡片高度上限交给内置 Modal 的布局：超出时由 .dss-content 内部滚动，
   这样固定高度的预览区在小窗口里也不会把卡片顶出屏幕。 */
.dss-dialog{width:min(680px,92vw);max-width:none;max-height:100%}
.dss-content{min-height:0;overflow-y:auto;overscroll-behavior:contain}
.dss-body{flex-direction:column;gap:10px;display:flex}
.dss-meta{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));margin:0;font-size:12.5px;line-height:19px}
.dss-row{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.dss-label{color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));font-size:12.5px;line-height:18px;font-weight:600}
.dss-check{align-items:flex-start;gap:8px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));cursor:pointer;font-size:12px;line-height:18px;display:flex}
.dss-check input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}
/* 预览框**固定高度**：内容长度会随「完整记录 / 仅对话」差很多，高度跟着内容走
   时每切一次面板就跳一次 —— 那正是"闪"的一半来源。 */
.dss-preview{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));margin:0;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:17px;height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word}
/* 新范围的结果还没回来：把旧内容压淡当进度提示，比换成「读取中…」温和得多。 */
.dss-preview[data-stale=true]{opacity:.5;transition:opacity .15s ease}
@media (prefers-reduced-motion: reduce){.dss-preview[data-stale=true]{transition:none}}
.dss-status{border:.5px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-md,8px);margin:0;padding:7px 10px;font-size:12px;line-height:18px;word-break:break-word}
.dss-statusOk{color:var(--dsw-alias-state-success-primary,#10a37f);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary,#10a37f) 40%, transparent)}
.dss-statusError{color:var(--dsw-alias-state-error-primary,#c0392b);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#c0392b) 40%, transparent)}
.dss-input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);width:100%;height:32px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none;padding:0 10px}
.dss-dirInput{flex:1 1 auto;min-width:0}
.dss-footActions{align-items:center;gap:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;width:100%}
/* 固定最小宽度：忙碌时按钮文案从「导出 .md」变「处理中…」，不定宽的话
   右对齐的一排按钮会一起左右挪一下。 */
.dss-footActions button{min-width:104px}
.dss-fallbackBtn{font:inherit;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-md,8px);background:0 0;color:var(--dsw-alias-label-primary);padding:5px 12px;font-size:12.5px}
.dss-fallbackBtn:disabled{cursor:default;opacity:.45}
/* 兜底按钮的「强调」态刻意**不做实心填充**：实心必须与前景色配对，而
   --dsw-alias-brand-primary 在浅色主题是近黑、深色主题是近白 —— 硬编码任何一种
   前景色都会在另一个主题里变成「白底白字」（真踩过：深色下整个按钮看不见）。
   改成描边 + 加粗，文字继续用 --dsw-alias-label-primary，两个主题都读得清。 */
.dss-fallbackBtnPrimary{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-label-primary);font-weight:600}
.dss-seg{display:flex;gap:6px}
.dss-modalRoot{position:fixed;inset:0;z-index:60;align-items:center;justify-content:center;display:flex}
.dss-modalMask{position:absolute;inset:0;background:#00000059}
.dss-modalCard{position:relative;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));border:.5px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:var(--dsw-radius-xl,12px);box-shadow:0 12px 40px #00000040;flex-direction:column;gap:12px;width:min(680px,92vw);max-height:86vh;overflow:auto;padding:18px 20px;display:flex}
.dss-modalHead{align-items:center;gap:10px;display:flex;justify-content:space-between}
.dss-modalTitle{margin:0;font-size:15px;font-weight:600}
.dss-modalClose{font:inherit;cursor:pointer;background:0 0;border:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#6b7280));font-size:16px;line-height:1;padding:4px 6px}
`;

    const CSS_TAG_ID = "dsh-session-share/SharePanel.module.css";
    /** 注入一次样式；返回的 disposer 在插件卸载时把标签摘掉。 */
    const insertStyles = () => {
      if (typeof document === "undefined" || document.head === undefined) return () => {};
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-share";
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => {
        try {
          if (typeof tag.remove === "function") tag.remove();
          else if (typeof document.head.removeChild === "function") document.head.removeChild(tag);
        } catch { /* ignore */ }
      };
    };

    /* ------------------------------------------------------------------ *
     * primitives 取用：任何一个组件缺失都要能降级，绝不把 undefined 交给
     * createElement —— 那会让整个侧栏渲染崩掉，而不是少一个按钮。
     * ------------------------------------------------------------------ */
    const el = React.createElement;

    /**
     * React 组件的**三种形状**都要认，只判 `typeof === "function"` 是不够的：
     *   - 函数组件 → `function`
     *   - 宿主组件 → `string`（"div" 之类）
     *   - `forwardRef` / `memo` / `lazy` → **对象**（`{ $$typeof: Symbol(react.forward_ref) }`）
     *
     * 这不是理论问题：primitives 的 `Button` 与 `Input` 都是 `forwardRef(...)` 的产物，
     * 用 `typeof x === "function"` 探测会把它们判成「不存在」→ 静默退回自绘兜底按钮
     * → 深色主题下兜底里硬编码的白字撞上近白的 `--dsw-alias-brand-primary`，
     * 变成白底白字（真踩过）。所以探测一律走这里，而且测试里专门有 forwardRef 形状的用例。
     */
    const reactComponent = (value) => {
      if (typeof value === "function" || typeof value === "string") return value;
      if (value !== null && typeof value === "object"
        && (typeof value.$$typeof === "symbol" || typeof value.$$typeof === "number")) return value;
      return undefined;
    };

    const ShareIcon = reactComponent(primitives.IconShareOutlineRegular);

    const FallbackMenuItemButton = function FallbackMenuItemButton(props) {
      const parts = [];
      if (props?.icon !== undefined && props?.icon !== null) parts.push(el("span", { key: "icon" }, props.icon));
      parts.push(el("span", { key: "label" }, props?.children));
      return el("button", {
        type: "button",
        role: "menuitem",
        className: "dss-fallbackBtn",
        style: { border: 0, display: "flex", gap: 8, alignItems: "center", width: "100%" },
        onClick: () => { try { props?.onSelect?.(); } catch { /* ignore */ } }
      }, parts);
    };
    const MenuItemButton = reactComponent(primitives.MenuItemButton) ?? FallbackMenuItemButton;

    const FallbackButton = function FallbackButton({ variant, className, children, ...rest }) {
      const classes = ["dss-fallbackBtn"];
      if (variant === "primary") classes.push("dss-fallbackBtnPrimary");
      if (typeof className === "string" && className !== "") classes.push(className);
      return el("button", { type: "button", className: classes.join(" "), ...rest }, children);
    };
    const Button = reactComponent(primitives.Button) ?? FallbackButton;

    const Input = reactComponent(primitives.Input)
      ?? function FallbackInput({ className, ...rest }) {
        // primitives 的 Input 把 className 挂在**外层 span** 上；这个兜底是裸 input，
        // 所以自带 .dss-input 的输入框样式。
        return el("input", { className: `dss-input${typeof className === "string" ? ` ${className}` : ""}`, ...rest });
      };

    /** DSH 注入上下文的开关：有 Checkbox 就用它，没有就退回自绘 label + input。 */
    const Checkbox = reactComponent(primitives.Checkbox)
      ?? function FallbackCheckbox({ checked, onChange, label, className }) {
        return el("label", { className: `dss-check${typeof className === "string" ? ` ${className}` : ""}` },
          el("input", { type: "checkbox", checked, onChange: (event) => onChange(event.currentTarget.checked) }),
          el("span", {}, label));
      };

    /** 内容范围切换：有 SegmentedControl 就用它，没有就退回两个按钮。 */
    const SegmentedControl = reactComponent(primitives.SegmentedControl)
      ?? function FallbackSegments({ options, value, onChange, label }) {
        return el("div", { className: "dss-seg", role: "group", "aria-label": label },
          options.map((option) => el(Button, {
            key: option.value,
            variant: option.value === value ? "primary" : "outline",
            size: "sm",
            onClick: () => { if (option.value !== value) onChange(option.value); }
          }, option.label)));
      };

    /** 写剪贴板：优先用 primitives 的实现（它自己带 execCommand 兜底）。 */
    const writeClipboard = typeof primitives.writeClipboard === "function"
      ? primitives.writeClipboard
      : async (text) => {
        try {
          if (navigator?.clipboard?.writeText !== undefined) {
            await navigator.clipboard.writeText(text);
            return true;
          }
        } catch { /* 落到下面的兜底 */ }
        try {
          const area = document.createElement("textarea");
          area.value = text;
          area.style.position = "fixed";
          area.style.left = "-9999px";
          document.body.appendChild(area);
          area.select();
          const ok = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
          area.remove();
          return ok;
        } catch {
          return false;
        }
      };

    /** 面板外壳：primitives 的 Modal 缺失时自绘一个（遮罩点击 / Escape 都留着）。 */
    const FallbackModal = function FallbackModal({ open, onClose, title, closeLabel, description, children, footer }) {
      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => { if (event.key === "Escape") onClose?.(); };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, [open, onClose]);
      if (!open) return null;
      return el("div", { className: "dss-modalRoot", role: "presentation" },
        el("div", { className: "dss-modalMask", onClick: () => onClose?.() }),
        el("div", { className: "dss-modalCard", role: "dialog", "aria-modal": "true", "aria-label": title },
          el("div", { className: "dss-modalHead" },
            el("h2", { className: "dss-modalTitle" }, title),
            el("button", { type: "button", className: "dss-modalClose", "aria-label": closeLabel, onClick: () => onClose?.() }, "✕")),
          description === undefined || description === "" ? null : el("p", { className: "dss-meta" }, description),
          children,
          footer));
    };
    const Modal = reactComponent(primitives.Modal) ?? FallbackModal;

    /* ------------------------------------------------------------------ *
     * 面板状态：模块级小 store（菜单项与浮层之间没有共同父组件）。
     * ------------------------------------------------------------------ */
    const store = {
      state: { open: false, sessionId: "", displayTitle: "" },
      listeners: new Set(),
      getSnapshot() { return store.state; },
      set(next) {
        store.state = { ...store.state, ...next };
        for (const listener of [...store.listeners]) {
          try { listener(); } catch { /* 单个订阅者出错不影响其它人 */ }
        }
      },
      subscribe(listener) {
        store.listeners.add(listener);
        return () => { store.listeners.delete(listener); };
      }
    };

    const useStore = typeof React.useSyncExternalStore === "function"
      ? (subscribe, getSnapshot) => React.useSyncExternalStore(subscribe, getSnapshot)
      : (subscribe, getSnapshot) => {
        const [value, setValue] = React.useState(getSnapshot);
        React.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe]);
        return value;
      };

    const readStoredDir = () => {
      try {
        const value = window.localStorage?.getItem(DIR_STORAGE_KEY);
        return typeof value === "string" && value.trim() !== "" ? value : "";
      } catch {
        return "";
      }
    };
    const storeDir = (dir) => {
      try { window.localStorage?.setItem(DIR_STORAGE_KEY, dir); } catch { /* 无痕模式等，忽略 */ }
    };

    /* ------------------------------------------------------------------ *
     * host API
     * ------------------------------------------------------------------ */
    const post = async (path, body) => {
      const response = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [CALL_HEADER]: CALL_HEADER_VALUE },
        body: JSON.stringify(body ?? {})
      });
      const data = await response.json().catch(() => undefined);
      if (data === undefined || data === null || typeof data !== "object") {
        throw new Error(`HTTP ${response.status}`);
      }
      if (data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data.result;
    };

    /* ------------------------------------------------------------------ *
     * 菜单项
     * ------------------------------------------------------------------ */
    function ShareMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t, openShare } = props;
      const menuState = typeof useMenuOpenState === "function" ? useMenuOpenState() : undefined;
      const setMenuOpen = Array.isArray(menuState) ? menuState[1] : undefined;
      const itemProps = {
        onSelect: () => {
          // 先关菜单再开面板：菜单有「点外面就关」的监听，反过来的话面板会被它顺手关掉。
          try { if (typeof setMenuOpen === "function") setMenuOpen(false); } catch { /* ignore */ }
          openShare(sessionId, displayTitle);
        }
      };
      if (ShareIcon !== undefined && ShareIcon !== null) itemProps.icon = el(ShareIcon, {});
      return el(MenuItemButton, itemProps, translate(t, "menu.share"));
    }

    /* ------------------------------------------------------------------ *
     * 分享面板
     * ------------------------------------------------------------------ */
    function SharePanel(props) {
      const { t } = props;
      const state = useStore(store.subscribe, store.getSnapshot);
      const { open, sessionId, displayTitle } = state;

      const [scope, setScope] = React.useState("full");
      const [includeInjected, setIncludeInjected] = React.useState(false);
      const [dir, setDir] = React.useState(readStoredDir);
      const [preview, setPreview] = React.useState({ status: "idle", data: undefined, error: "", stale: false });
      const [busy, setBusy] = React.useState("");
      const [status, setStatus] = React.useState(undefined);
      /** 上一次请求针对的会话：换会话时才清空旧状态，换范围不清。 */
      const lastSession = React.useRef("");

      const text = (key, params) => translate(t, key, params);

      /**
       * 取预览。用 alive 标记丢弃过期响应：连点两下范围切换时，先发的可能后回来。
       *
       * **切范围时保留上一份预览**（stale-while-revalidate），这是刻意为之 ——
       * 之前这里每次都 `data: undefined` + 切 loading，于是：内容塌成一行
       * 「读取中…」、面板高度猛跳、三个按钮一起 disabled（主按钮
       * `opacity:.4` 尤其明显），响应回来再弹回去 —— 看着就是「屏幕闪一下」。
       * 现在只有**换会话**才清内容（旧会话的预览留在新会话窗口里是错的），
       * 换范围只是在旧内容上压一层 stale 标记（变淡 + 加个过渡），
       * 布局、按钮可用性都不动。
       */
      React.useEffect(() => {
        if (!open || sessionId === "") return undefined;
        if (lastSession.current !== sessionId) {
          lastSession.current = sessionId;
          setStatus(undefined);
          setPreview({ status: "loading", data: undefined, error: "", stale: false });
        } else {
          setPreview((current) => (current.data === undefined
            ? current
            : { ...current, stale: true }));
        }

        let alive = true;
        post("/preview", { sessionId, scope, includeInjected, sampleChars: PREVIEW_MAX_CHARS })
          .then((data) => {
            if (alive) setPreview({ status: "ready", data, error: "", stale: false });
          })
          .catch((error) => {
            if (!alive) return;
            const message = error?.message || String(error);
            setPreview({
              status: "error",
              data: undefined,
              error: message.includes("HTTP") ? text("panel.noapi") : message,
              stale: false
            });
          });
        return () => { alive = false; };
      }, [open, sessionId, scope, includeInjected]);

      // 首次拿到默认目录时补进输入框（用户已经填过就尊重用户的值）。
      const defaultDir = preview.data?.defaultDir;
      React.useEffect(() => {
        if (typeof defaultDir !== "string" || defaultDir === "") return;
        setDir((current) => (current.trim() === "" ? defaultDir : current));
      }, [defaultDir]);

      const stats = preview.data?.stats;
      const statsLine = stats === undefined ? "" : text("panel.stats", {
        user: stats.userMessages,
        assistant: stats.assistantMessages,
        tools: stats.toolCalls,
        images: stats.imageCount ?? preview.data?.imageCount ?? 0,
        chars: preview.data?.chars ?? 0
      });

      const title = preview.data?.meta?.title || displayTitle || "";
      /**
       * 只要手上有一份可用预览，按钮就**不禁用** —— 切换范围时那三秒的
       * `disabled`（`opacity:.4`）正是"闪"的主要来源。禁用只留给两种情况：
       * 还没有任何内容（首帧/失败），或有动作正在跑。
       * 范围重新取预览期间点导出是安全的：请求体里带的就是**新的** scope。
       */
      const disabled = preview.data === undefined || busy !== "";

      const copyMarkdown = async () => {
        if (disabled) return;
        setBusy("copy");
        setStatus(undefined);
        try {
          const result = await post("/markdown", { sessionId, scope, includeInjected });
          const ok = await writeClipboard(result.markdown);
          setStatus(ok
            ? { tone: "ok", text: text("panel.copied", { chars: result.chars }) }
            : { tone: "error", text: text("panel.copyFailed") });
        } catch (error) {
          setStatus({ tone: "error", text: text("panel.error", { message: error?.message || String(error) }) });
        } finally {
          setBusy("");
        }
      };

      const exportAs = async (format) => {
        if (disabled) return;
        setBusy(format);
        setStatus(undefined);
        try {
          const result = await post("/export", { sessionId, scope, includeInjected, format, dir: dir.trim() });
          if (dir.trim() !== "") storeDir(dir.trim());
          const paths = result.files.filter((file) => file.kind !== "assets").map((file) => file.path);
          const notes = [];
          if (result.imageCount > 0) {
            // 报告的是**实际落盘的张数**，不是计划张数：一张都没落下来（附件源文件不在了）
            // 时绝不能说"在同名 .assets 目录里"——那个目录根本不会存在。
            if (result.imagesEmbedded === true) notes.push(text("panel.imagesEmbedded", { count: result.imageCount }));
            else if (result.imagesWritten > 0) {
              notes.push(text("panel.imagesInAssets", { count: result.imagesWritten })
                + (result.imagesFailed > 0 ? text("panel.imagesFailedSuffix", { count: result.imagesFailed }) : ""));
            } else notes.push(text("panel.imagesMissing", { count: result.imageCount }));
          }
          // 正文里按路径引用的图片若落在会话工作目录之外（或已不存在），就打包不了 ——
          // 这是"我明明在正文里写了图，导出后却没有"的唯一原因，必须如实说出来。
          if (result.textImagesSkipped > 0) {
            notes.push(text("panel.textImagesSkipped", { count: result.textImagesSkipped }));
          }
          setStatus({
            tone: "ok",
            text: `${paths.length > 1
              ? text("panel.exportedMulti", { count: paths.length, path: paths.join("、") })
              : text("panel.exported", { path: paths[0] ?? result.dir })}${notes.length === 0 ? "" : `（${notes.join("；")}）`}`,
            primaryPath: paths[0]
          });
        } catch (error) {
          setStatus({ tone: "error", text: text("panel.error", { message: error?.message || String(error) }) });
        } finally {
          setBusy("");
        }
      };

      /**
       * 打开 / 定位产物。host 半会把**实际发生了什么**回过来，所以这里不再一律说
       * 「已在资源管理器中定位」—— 用什么程序打开的、是不是退到了记事本，都要说清楚，
       * 否则用户看到的就是"点了没反应"。
       */
      const reveal = async (path, mode) => {
        try {
          const result = await post("/reveal", { path, mode });
          let note;
          if (mode !== "open") note = text("panel.revealed");
          else if (result?.fallback === "no-association") note = text("panel.openedNotepad");
          else if (result?.opened === true) note = text("panel.opened");
          else if (result?.selected === true) note = text("panel.openFailedLocated", { message: result.error ?? "" });
          else note = text("panel.openRequested");
          setStatus((current) => ({ ...(current ?? {}), text: `${current?.text ?? ""} · ${note}` }));
        } catch (error) {
          setStatus({ tone: "error", text: text("panel.error", { message: error?.message || String(error) }) });
        }
      };

      const copyPath = async (path) => {
        const ok = await writeClipboard(path);
        if (ok) setStatus((current) => ({ ...(current ?? {}), text: `${current?.text ?? ""} · ${text("panel.pathCopied")}` }));
      };

      // 手上没内容时才说「读取中…」；有内容就继续显示上一份，不制造文字跳动。
      const statsText = preview.data !== undefined
        ? statsLine
        : preview.status === "loading" ? text("panel.loading") : "";
      const previewText = preview.data !== undefined
        ? (preview.data.sample ?? "")
        : preview.status === "error" ? preview.error : text("panel.loading");

      const body = [
        el("p", { key: "stats", className: "dss-meta" }, statsText),
        el("div", { key: "scope", className: "dss-row" },
          el("span", { className: "dss-label" }, text("panel.scope")),
          el(SegmentedControl, {
            id: "dss-scope",
            value: scope,
            label: text("panel.scope"),
            options: [
              { value: "full", label: text("panel.scopeFull") },
              { value: "chat", label: text("panel.scopeChat") }
            ],
            onChange: (next) => { if (next !== scope) setScope(next); }
          })),
        el(Checkbox, {
          key: "injected",
          // 不传 className：primitives 的 Checkbox 自带排版，别跟它抢布局
          // （自绘兜底那条路才用 .dss-check）。
          checked: includeInjected,
          label: text("panel.injected"),
          onChange: (next) => setIncludeInjected(next === true)
        }),
        el("span", { key: "previewLabel", className: "dss-label" }, text("panel.preview")),
        // 预览只是片段（前 PREVIEW_MAX_CHARS 字符），但**不提示**这件事：
        // 面板本身已经写明「预览」，多一行截断说明只是噪音（用户明确要求去掉）。
        // data-stale：新范围的结果还没回来，先把旧内容压淡一点当进度提示 ——
        // 比换成「读取中…」温和得多，也不会让面板高度跳。
        el("pre", {
          key: "preview",
          className: "dss-preview",
          "data-stale": preview.stale === true ? "true" : undefined
        }, previewText),
        el("span", { key: "dirLabel", className: "dss-label" }, text("panel.dir")),
        el("div", { key: "dir", className: "dss-row" },
          el(Input, {
            className: "dss-dirInput",
            value: dir,
            spellCheck: false,
            placeholder: defaultDir ?? "",
            onChange: (event) => setDir(event.currentTarget.value)
          })),
        status === undefined ? null : el("p", {
          key: "status",
          className: `dss-status ${status.tone === "ok" ? "dss-statusOk" : "dss-statusError"}`
        }, status.text),
        status?.primaryPath === undefined ? null : el("div", { key: "statusActions", className: "dss-row" },
          el(Button, { size: "sm", variant: "outline", onClick: () => copyPath(status.primaryPath) }, text("panel.copyPath")),
          el(Button, { size: "sm", variant: "outline", onClick: () => reveal(status.primaryPath, "select") }, text("panel.reveal")),
          el(Button, { size: "sm", variant: "outline", onClick: () => reveal(status.primaryPath, "open") }, text("panel.open")))
      ].filter((node) => node !== null);

      const footer = el("div", { className: "dss-footActions" },
        el(Button, { variant: "ghost", onClick: () => store.set({ open: false }) }, text("panel.close")),
        el(Button, { variant: "outline", disabled, onClick: () => copyMarkdown() }, busy === "copy" ? text("panel.busy") : text("panel.copy")),
        el(Button, { variant: "outline", disabled, onClick: () => exportAs("md") }, busy === "md" ? text("panel.busy") : text("panel.exportMd")),
        el(Button, { variant: "primary", disabled, onClick: () => exportAs("html") }, busy === "html" ? text("panel.busy") : text("panel.exportHtml")));

      return el(Modal, {
        open,
        onClose: () => store.set({ open: false }),
        title: text("panel.title"),
        closeLabel: text("panel.close"),
        description: title,
        className: "dss-dialog",
        // 内容区自己滚：卡片高度固定住，切换范围时窗口不会上下抽动。
        contentClassName: "dss-content",
        children: el("div", { className: "dss-body" }, body),
        footer
      });
    }

    /* ------------------------------------------------------------------ *
     * 翻译：slot 注入的 t 优先，取不到就用本文件的字典。
     * ------------------------------------------------------------------ */
    function translate(t, key, params) {
      let template;
      if (typeof t === "function") {
        try {
          const value = t(key, params);
          if (typeof value === "string" && value !== "" && value !== key) template = value;
        } catch { /* 回落到内置字典 */ }
      }
      if (template === undefined) template = zh[key] ?? key;
      if (params === undefined) return template;
      return Object.keys(params).reduce(
        (text, name) => text.split(`{${name}}`).join(String(params[name])),
        template
      );
    }

    function apply(ctx) {
      const slots = ctx.slots;
      if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") return;

      ctx.effect(insertStyles, "session-share: styles");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-share: dictionaries");

      const openShare = (sessionId, displayTitle) => {
        store.set({ open: true, sessionId: sessionId ?? "", displayTitle: displayTitle ?? "" });
      };

      slots.inject("sidebar.workspaces.session.menu.item", () => slots.register({
        name: "sidebar.workspaces.session.menu.item",
        id: "session-share",
        // 450：夹在归档(400) 与兄弟插件的删除(500) 之间 —— 只读动作排在破坏性动作前。
        order: 450,
        locale: NS,
        inject: () => ({ openShare })
      }, ShareMenuItem));

      slots.inject("shell.overlay", () => slots.register({
        name: "shell.overlay",
        id: "session-share.panel",
        order: 50,
        locale: NS,
        inject: () => ({})
      }, SharePanel));
    }

    const inject = ["slots", "locale"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
