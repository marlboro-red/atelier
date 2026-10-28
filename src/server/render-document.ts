import { parse, type DefaultTreeAdapterMap } from "parse5";
import { artifactPolicy } from "../shared/security.js";
const escape = (s: string) => s.replace(/</g, "\\u003c");
export type CompiledDocument = {
  document: {
    htmlOpen: string;
    headOpen: string;
    bodyOpen: string;
    head: string;
    body: string;
  };
  script: string;
  styles: string;
};
export type RenderOptions = {
  id: string;
  revision: number;
  data?: unknown;
  snapshot?: unknown;
  standalone?: boolean;
  freeze?: boolean;
};
// This bridge runs only inside the sandboxed preview, never in the service process.
function bridge(config: {
  id: string;
  revision: number;
  data: unknown;
  snapshot: any;
  standalone: boolean;
  freeze: boolean;
}) {
  const w = window as any;
  let selecting = false;
  let selectionScope = "element";
  let hovered: Element | null = null;
  let inspector: HTMLElement | null = null;
  let state = config.snapshot?.state ?? null;
  let data = config.data;
  const pending = new Map();
  let seq = 0;
  const emit = (type: string, payload: any = {}) =>
    parent.postMessage({ atelier: true, type, ...payload }, "*");
  const exportRequest = (type: string, value?: unknown) => {
    const requestId = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      emit(type, { requestId, data: value });
    });
  };
  w.atelier = {
    getData: async () =>
      config.standalone && parent !== window
        ? exportRequest("export-get-data")
        : data,
    setData: async (value: any) => {
      data = value;
      if (config.standalone) {
        if (parent !== window) return exportRequest("export-set-data", value);
        try {
          localStorage.setItem("atelier:" + config.id, JSON.stringify(value));
        } catch {}
        return;
      }
      const requestId = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        emit("save-data", { requestId, data: value });
      });
    },
    getState: () => state,
    setState: (value: any) => {
      state = value;
    },
  };
  if (config.standalone) {
    try {
      const saved = localStorage.getItem("atelier:" + config.id);
      if (saved) data = JSON.parse(saved);
    } catch {}
  }
  const path = (el: Element): string => {
    if (el === document.body) return "body";
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.hasAttribute("data-atelier-id"))
      return (
        '[data-atelier-id="' +
        CSS.escape(el.getAttribute("data-atelier-id")!) +
        '"]'
      );
    const parts = [];
    while (el && el !== document.body) {
      const p: Element | null = el.parentElement;
      if (!p) break;
      parts.unshift(
        el.tagName.toLowerCase() +
          ":nth-child(" +
          (Array.from(p.children).indexOf(el) + 1) +
          ")",
      );
      el = p;
    }
    return "body > " + parts.join(" > ");
  };
  const snapshot = () => ({
    state,
    inputs: Array.from(document.querySelectorAll("input,textarea,select")).map(
      (el: any) => ({
        selector: path(el),
        value: el.value,
        checked: el.checked,
      }),
    ),
    canvases: Array.from(document.querySelectorAll("canvas"))
      .map((el) => {
        try {
          return { selector: path(el), image: el.toDataURL() };
        } catch {
          return null;
        }
      })
      .filter(Boolean),
    scroll: { x: scrollX, y: scrollY },
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data?.atelier) return;
    const msg = event.data;
    if (msg.type === "selection-mode") {
      selecting = msg.enabled === true && !config.standalone && !config.freeze;
      selectionScope = msg.scope === "section" ? "section" : "element";
      getSelection()?.removeAllRanges();
      hovered = null;
      drawInspector();
      document.documentElement.style.cursor = selecting ? "crosshair" : "";
    }
    if (msg.type === "snapshot")
      emit("snapshot", { requestId: msg.requestId, snapshot: snapshot() });
    if (msg.type === "data-result") {
      const p = pending.get(msg.requestId);
      if (p) {
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.data);
        pending.delete(msg.requestId);
      }
    }
    if (msg.type === "annotations" && !config.standalone && !config.freeze) {
      annotations = Array.isArray(msg.comments)
        ? msg.comments.slice(0, 200)
        : [];
      scheduleAnnotations();
    }
    if (msg.type === "locate") {
      const el = locate(msg.anchor);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      else emit("anchor-missing");
    }
  });
  // Annotations never alter the artifact's DOM structure or enter exports.
  let annotations: { id: string; anchor: any }[] = [];
  let overlay: HTMLElement | null = null;
  let overlayRoot: ShadowRoot | null = null;
  let scheduled = false;
  const locate = (anchor: any): Element | null => {
    if (!anchor) return null;
    let el: Element | null = null;
    try {
      el = document.querySelector(anchor.selector);
    } catch {}
    if (el && (!anchor.quote || el.textContent?.includes(anchor.quote)))
      return el;
    if (!anchor.quote) return null;
    const matches = Array.from(document.querySelectorAll("body *")).filter(
      (node) =>
        !["SCRIPT", "STYLE"].includes(node.tagName) &&
        node !== overlay &&
        node.textContent?.includes(anchor.quote) &&
        !Array.from(node.children).some((child) =>
          child.textContent?.includes(anchor.quote),
        ),
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const quoteRange = (el: Element, anchor: any): Range | null => {
    if (!anchor.quote) return null;
    const text = el.textContent || "";
    const needle = (anchor.prefix || "") + anchor.quote + (anchor.suffix || "");
    const contextual = text.indexOf(needle);
    const start =
      contextual >= 0
        ? contextual + (anchor.prefix || "").length
        : text.indexOf(anchor.quote);
    if (
      start < 0 ||
      (contextual < 0 && text.indexOf(anchor.quote, start + 1) >= 0)
    )
      return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0,
      begun = false,
      node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length || 0;
      if (!begun && start < offset + length) {
        range.setStart(node, start - offset);
        begun = true;
      }
      if (begun && start + anchor.quote.length <= offset + length) {
        range.setEnd(node, start + anchor.quote.length - offset);
        return range;
      }
      offset += length;
    }
    return null;
  };
  const drawAnnotations = () => {
    if (config.standalone || config.freeze) return;
    if (!overlay) {
      overlay = document.createElement("atelier-annotations");
      overlay.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
      overlayRoot = overlay.attachShadow({ mode: "open" });
      document.body.append(overlay);
    }
    overlayRoot!.replaceChildren();
    const style = document.createElement("style");
    style.textContent =
      "button{position:fixed;pointer-events:auto;border:1px solid #bd9853;border-radius:50%;width:22px;height:22px;background:#fff4cd;color:#5b4820;font:11px system-ui;cursor:pointer} .mark{position:fixed;background:#efc45c44;box-shadow:0 1px #be943c;pointer-events:none}";
    overlayRoot!.append(style);
    const occupied: { x: number; y: number }[] = [];
    annotations.forEach((comment, index) => {
      const el = locate(comment.anchor);
      if (!el) return;
      const range = quoteRange(el, comment.anchor);
      const rects = range
        ? Array.from(range.getClientRects())
        : [el.getBoundingClientRect()];
      const visible = rects.filter(
        (r) => r.bottom > 0 && r.top < innerHeight && r.width > 0,
      );
      if (!visible.length) return;
      for (const r of visible) {
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        overlayRoot!.append(mark);
      }
      const last = visible[visible.length - 1];
      const x = Math.max(0, Math.min(last.right + 5, innerWidth - 24));
      let y = Math.max(0, Math.min(last.top, innerHeight - 24));
      while (
        occupied.some((p) => Math.abs(p.x - x) < 24 && Math.abs(p.y - y) < 24)
      )
        y += 24;
      occupied.push({ x, y });
      const pin = document.createElement("button");
      pin.textContent = String(index + 1);
      pin.setAttribute("aria-label", "Open comment " + (index + 1));
      pin.style.left = x + "px";
      pin.style.top = y + "px";
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        emit("open-comment", { id: comment.id, x: e.clientX, y: e.clientY });
      });
      overlayRoot!.append(pin);
    });
  };
  function scheduleAnnotations() {
    if (scheduled || config.standalone || config.freeze) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      drawAnnotations();
    });
  }
  const sectionTarget = (element: Element): Element => {
    const semantic = element.closest(
      "section,article,figure,fieldset,[role=region],[data-atelier-section]",
    );
    if (semantic) return semantic;
    // A card/grid container remains selectable even without semantic markup.
    let target = element;
    while (target.parentElement && target.parentElement !== document.body) {
      target = target.parentElement;
      if (target.children.length > 1) return target;
    }
    return target;
  };
  const elementTarget = (element: Element) =>
    element.closest("svg,picture,canvas,img") ?? element;
  function drawInspector() {
    if (config.standalone || config.freeze) return;
    if (!selecting || !hovered?.isConnected) {
      inspector?.remove();
      inspector = null;
      return;
    }
    if (!inspector) {
      inspector = document.createElement("atelier-selection-highlight");
      inspector.style.cssText =
        "position:fixed;pointer-events:none;z-index:2147483647";
      inspector.attachShadow({ mode: "open" });
      document.body.append(inspector);
    }
    const rect = hovered.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;border:2px solid #4169df;background:#4169df18;border-radius:3px;pointer-events:none`;
    const label = document.createElement("span");
    label.textContent = selectionLabel(hovered);
    label.style.cssText = `position:fixed;left:${Math.max(4, rect.left)}px;top:${Math.max(4, rect.top - 24)}px;max-width:calc(100vw - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 6px;background:#4169df;color:white;border-radius:3px;font:12px system-ui;pointer-events:none`;
    inspector.shadowRoot!.replaceChildren(box, label);
  }
  function selectionLabel(target: Element) {
    const name =
      target.getAttribute("aria-label") ||
      target.getAttribute("alt") ||
      target
        .querySelector("h1,h2,h3,h4,figcaption,legend,title")
        ?.textContent?.trim() ||
      target.textContent?.trim().slice(0, 160) ||
      target.id ||
      target.tagName.toLowerCase();
    return `${selectionScope === "section" ? "Section" : "Element"}: ${name}`.slice(
      0,
      200,
    );
  }
  const captureSelection = (event?: Event) => {
    if (config.standalone || config.freeze) return;
    if (event?.target === overlay || event?.target === inspector) return;
    const selection = getSelection();
    const quote = selecting ? "" : (selection?.toString().trim() ?? "");
    const common = selection?.rangeCount
      ? selection.getRangeAt(0).commonAncestorContainer
      : null;
    const target = quote
      ? common?.nodeType === 1
        ? (common as Element)
        : common?.parentElement
      : (hovered ?? (event?.target as Element));
    if (
      (!selecting && !quote) ||
      !target ||
      (!quote && target === document.body) ||
      (!selecting && target.closest("input,textarea,[contenteditable]"))
    ) {
      emit("selection-candidate");
      return;
    }
    const text = target.textContent ?? "";
    let offset = quote ? text.indexOf(quote) : 0;
    if (quote && selection?.rangeCount) {
      const before = selection.getRangeAt(0).cloneRange();
      before.selectNodeContents(target);
      before.setEnd(
        selection.getRangeAt(0).startContainer,
        selection.getRangeAt(0).startOffset,
      );
      const leading =
        selection.toString().length - selection.toString().trimStart().length;
      offset = before.toString().length + leading;
    }
    const anchor = {
      kind: selecting ? selectionScope : "text",
      ...(selecting ? { label: selectionLabel(target) } : {}),
      quote: quote.slice(0, 5000),
      prefix: text.slice(Math.max(0, offset - 100), offset),
      suffix: quote
        ? text.slice(offset + quote.length, offset + quote.length + 100)
        : "",
      selector: path(target),
      tag: target.tagName.toLowerCase(),
    };
    const rect =
      quote && selection?.rangeCount
        ? selection.getRangeAt(0).getBoundingClientRect()
        : target.getBoundingClientRect();
    emit(selecting ? "selection" : "selection-candidate", {
      anchor,
      x: rect.left,
      y: rect.bottom + 8,
    });
  };
  if (!config.standalone && !config.freeze) {
    addEventListener("pointermove", (event) => {
      if (
        !selecting ||
        !(event.target instanceof Element) ||
        event.target === overlay ||
        event.target === inspector
      )
        return;
      const candidate =
        selectionScope === "section"
          ? sectionTarget(event.target)
          : elementTarget(event.target);
      if (candidate !== hovered) {
        hovered = candidate;
        drawInspector();
      }
    });
    addEventListener(
      "keydown",
      (event) => {
        if (!selecting) return;
        if (event.key === "Escape") {
          selecting = false;
          drawInspector();
          emit("selection-cancel");
        } else if (
          event.key === "ArrowUp" &&
          hovered?.parentElement &&
          hovered.parentElement !== document.body
        ) {
          event.preventDefault();
          hovered = hovered.parentElement;
          drawInspector();
        } else if (event.key === "Enter" && hovered) {
          event.preventDefault();
          event.stopImmediatePropagation();
          captureSelection();
        }
      },
      true,
    );
    addEventListener(
      "pointerdown",
      (event) => {
        if (
          !selecting ||
          !(event.target instanceof Element) ||
          event.target === overlay
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        hovered =
          selectionScope === "section"
            ? sectionTarget(event.target)
            : elementTarget(event.target);
        drawInspector();
      },
      true,
    );
    addEventListener("pointerup", (event) => {
      if (!selecting) captureSelection(event);
    });
    addEventListener("keyup", (event) => {
      if (event.key.startsWith("Arrow") && event.shiftKey)
        captureSelection(event);
    });
    addEventListener(
      "click",
      (event) => {
        if (event.target === overlay) return;
        if (!selecting) {
          if (
            getSelection()?.toString().trim() ||
            (event.target as Element)?.closest(
              "button,a,input,select,textarea,[contenteditable]",
            )
          )
            return;
          for (const comment of annotations) {
            const el = locate(comment.anchor);
            if (!el) continue;
            const range = quoteRange(el, comment.anchor);
            const rects = range
              ? Array.from(range.getClientRects())
              : [el.getBoundingClientRect()];
            if (
              rects.some(
                (r) =>
                  event.clientX >= r.left &&
                  event.clientX <= r.right &&
                  event.clientY >= r.top &&
                  event.clientY <= r.bottom,
              )
            ) {
              emit("open-comment", {
                id: comment.id,
                x: event.clientX,
                y: event.clientY,
              });
              return;
            }
          }
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        captureSelection(event);
      },
      true,
    );
    addEventListener(
      "scroll",
      () => {
        emit("selection-candidate");
        scheduleAnnotations();
        drawInspector();
      },
      true,
    );
    addEventListener("resize", () => {
      scheduleAnnotations();
      drawInspector();
    });
    const observer = new MutationObserver(scheduleAnnotations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.fonts?.ready.then(scheduleAnnotations);
  }
  // srcdoc inherits the viewer's base URL. Handle local anchors in the
  // artifact itself instead of navigating the frame to the viewer file.
  if (parent !== window)
    addEventListener("click", (event) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      const href = link?.getAttribute("href");
      if (!href?.startsWith("#")) return;
      event.preventDefault();
      try {
        const target = document.getElementById(
          decodeURIComponent(href.slice(1)),
        );
        if (target) target.scrollIntoView();
        else if (href === "#") scrollTo(0, 0);
      } catch {}
    });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") emit("escape");
  });
  addEventListener("error", (e) =>
    emit("runtime-error", { message: e.message }),
  );
  addEventListener("unhandledrejection", (e) =>
    emit("runtime-error", { message: String(e.reason) }),
  );
  const restore = () => {
    for (const item of config.snapshot?.inputs ?? []) {
      const el: any = document.querySelector(item.selector);
      if (el) {
        const setter = Object.getOwnPropertyDescriptor(
          el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : el.tagName === "SELECT"
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(el, item.value);
        if ("checked" in el) el.checked = item.checked;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    if (config.freeze) {
      for (const item of config.snapshot?.canvases ?? []) {
        const el = document.querySelector(item.selector);
        if (el) {
          const image = new Image();
          image.src = item.image;
          image.style.cssText = (el as HTMLElement).style.cssText;
          image.width = (el as HTMLCanvasElement).width;
          image.height = (el as HTMLCanvasElement).height;
          el.replaceWith(image);
        }
      }
    }
    emit("ready");
  };
  addEventListener("load", () => setTimeout(restore, 150));
}
// Trusted export viewer: keep storage outside the opaque-origin artifact.
function exportDataBridge(config: { id: string; data: unknown }) {
  let data = config.data;
  const key = "atelier:" + config.id;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) data = JSON.parse(saved);
  } catch {}
  addEventListener("message", (event) => {
    const frame = document.querySelector("iframe");
    const msg = event.data;
    if (
      !frame ||
      event.source !== frame.contentWindow ||
      !msg?.atelier ||
      !["export-get-data", "export-set-data"].includes(msg.type)
    )
      return;
    let error: string | undefined;
    if (msg.type === "export-set-data") {
      try {
        const json = JSON.stringify(msg.data);
        if (json === undefined || json.length > 2 * 1024 * 1024)
          throw new Error("App data must be JSON within the 2 MiB limit");
        data = JSON.parse(json);
        try {
          localStorage.setItem(key, json);
        } catch {}
      } catch (e) {
        error = e instanceof Error ? e.message : "Could not save app data";
      }
    }
    frame.contentWindow!.postMessage(
      {
        atelier: true,
        type: "data-result",
        requestId: msg.requestId,
        data,
        error,
      },
      "*",
    );
  });
}
export function assemble(
  { document, script, styles }: CompiledDocument,
  options: RenderOptions,
): string {
  const config = {
    id: options.id,
    revision: options.revision,
    data: options.data ?? null,
    snapshot: options.snapshot ?? null,
    standalone: options.standalone ?? false,
    freeze: options.freeze ?? false,
  };
  const bootstrap = `const __name=(fn)=>fn;(${bridge.toString()})(${escape(JSON.stringify(config))});`;
  const rendered = `<!doctype html>${document.htmlOpen}${document.headOpen}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${artifactPolicy}"><style>html{color-scheme:light}body{margin:0;color:#292722;font-family:system-ui,sans-serif}*{box-sizing:border-box}.document{max-width:860px;margin:auto;padding:48px;line-height:1.75}.document h1,.document h2,.document h3{line-height:1.2}.document img,svg{max-width:100%}.document pre{padding:20px;background:#f4f3ef;overflow:auto}.document table{border-collapse:collapse;width:100%}.document td,.document th{padding:10px;border:1px solid #ddd;text-align:left}.document blockquote{border-left:3px solid #c8a780;margin:24px 0;padding-left:20px;color:#666}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.document{padding:0}pre,figure,tr{break-inside:avoid}}${styles.replace(/<\/style/gi, "<\\/style")}</style><script>${bootstrap.replace(/<\/script/gi, "<\\/script")}</script>${document.head}</head>${document.bodyOpen}${document.body}<script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  if (!options.standalone || options.freeze) return rendered;
  // A downloaded document needs its own trusted parent. srcdoc permits the
  // initial inline page, while the parent's frame-src blocks later navigation.
  const attribute = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  function findTitle(
    node: DefaultTreeAdapterMap["node"],
  ): DefaultTreeAdapterMap["element"] | undefined {
    if ("tagName" in node && node.tagName === "title") return node;
    if ("childNodes" in node)
      for (const child of node.childNodes) {
        const title = findTitle(child);
        if (title) return title;
      }
  }
  const title = findTitle(parse(rendered));
  function textContent(node: DefaultTreeAdapterMap["node"]): string {
    if ("value" in node) return node.value;
    return "childNodes" in node
      ? node.childNodes.map(textContent).join("")
      : "";
  }
  // SVG titles can contain elements. Never promote serialized artifact markup
  // into the trusted viewer's HTML title (an HTML RCDATA context).
  const titleText = attribute(title ? textContent(title) : "atelier artifact");
  const storage = `const __name=(fn)=>fn;(${exportDataBridge.toString()})(${escape(JSON.stringify({ id: options.id, data: options.data ?? null }))});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${artifactPolicy}"><title>${titleText}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style><script>${storage.replace(/<\/script/gi, "<\\/script")}</script></head><body><iframe title="Artifact" sandbox="allow-scripts" srcdoc="${attribute(rendered)}"></iframe></body></html>`;
}
