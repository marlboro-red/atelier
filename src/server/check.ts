import { browserJobs } from "./job-queue.js";
import { createHash } from "node:crypto";
import { workspacePolicy } from "../shared/security.js";
import { chromium } from "playwright";

export type PreviewCheck = {
  status: "passed" | "failed" | "unavailable";
  revision: number;
  viewport: { width: number; height: number };
  errors: string[];
  warnings: string[];
  durationMs: number;
  screenshot?: { mimeType: "image/png"; data: string };
  thumbnail?: string;
};

// Browser checks are bounded; a burst of publications must not launch an
// unbounded number of Chromium processes or hold publish responses forever.
export async function checkPreview(
  url: string,
  revision: number,
  viewport = { width: 1280, height: 900 },
  screenshot = false,
  deadlineMs = 30000,
  html?: string,
): Promise<PreviewCheck> {
  const key =
    "check:" +
    createHash("sha256")
      .update(
        JSON.stringify([url, revision, viewport, screenshot, deadlineMs, html]),
      )
      .digest("hex");
  try {
    return await browserJobs.run(key, () =>
      runCheck(url, revision, viewport, screenshot, deadlineMs, html),
    );
  } catch (error) {
    return {
      status: "unavailable",
      revision,
      viewport,
      errors: [],
      warnings: [String(error)],
      durationMs: 0,
    };
  }
}
async function runCheck(
  url: string,
  revision: number,
  viewport = { width: 1280, height: 900 },
  screenshot = false,
  deadlineMs = 30000,
  html?: string,
): Promise<PreviewCheck> {
  const start = Date.now();
  const errors: string[] = [],
    warnings: string[] = [];
  const result = (status: PreviewCheck["status"]): PreviewCheck => ({
    status,
    revision,
    viewport,
    errors: [...errors],
    warnings: [...warnings],
    durationMs: Date.now() - start,
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let expired = false;
  const watchdog = setTimeout(() => {
    expired = true;
    void browser?.close().catch(() => {});
  }, deadlineMs);
  const add = (list: string[], text: string) => {
    const message = text.slice(0, 1500);
    if (list.length < 20 && !list.includes(message)) list.push(message);
  };
  try {
    try {
      browser = await chromium.launch({ headless: true, timeout: 10000 });
    } catch (error) {
      warnings.push(
        `Chromium could not start. Run atelier install-browser. ${String(error).slice(0, 500)}`,
      );
      return result("unavailable");
    }
    if (expired) throw new Error("Preview check exceeded its time limit");
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => add(errors, error.message));
    page.on("console", (message) => {
      if (message.type() === "error") add(errors, message.text());
      else if (message.type() === "warning") add(warnings, message.text());
    });
    page.on("requestfailed", (request) =>
      add(
        errors,
        `${request.url()}: ${request.failure()?.errorText ?? "request failed"}`,
      ),
    );
    const workspace = new URL(url).origin;
    let suppressedWrites = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const target = new URL(request.url());
      if (
        target.origin === workspace &&
        !["GET", "HEAD"].includes(request.method())
      ) {
        if (
          request.method() === "PUT" &&
          /^\/api\/artifacts\/[^/]+\/data$/.test(target.pathname)
        ) {
          suppressedWrites++;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: '{"ok":true}',
          });
        }
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: '{"error":"Preview checks do not mutate the workspace"}',
        });
      }
      return route.continue();
    });
    if (html !== undefined) {
      // The trusted parent retains the same navigation boundary as the workspace,
      // but does not load React, history, subscriptions, or library metadata.
      const encoded = JSON.stringify(html).replace(/</g, "\\u003c");
      await page.route(url, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: { "Content-Security-Policy": workspacePolicy() },
          body: `<!doctype html><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0;display:block}</style><iframe sandbox="allow-scripts" title="Artifact"></iframe><script>const frame=document.querySelector('iframe');addEventListener('message',event=>{if(event.source!==frame.contentWindow||!event.data?.atelier)return;const msg=event.data;if(msg.type==='save-data'){window.__atelierSuppressedWrites=(window.__atelierSuppressedWrites||0)+1;frame.contentWindow.postMessage({atelier:true,type:'data-result',requestId:msg.requestId},'*')}});frame.srcdoc=${encoded};</script>`,
        }),
      );
    }
    await page.addInitScript(() => {
      if (window !== top) return;
      const state = { ready: false, errors: [] as string[] };
      (window as any).__atelierPreviewCheck = state;
      addEventListener("message", (event) => {
        if (
          event.source !== document.querySelector("iframe")?.contentWindow ||
          !event.data?.atelier
        )
          return;
        if (event.data.type === "ready") state.ready = true;
        if (event.data.type === "runtime-error" && state.errors.length < 20)
          state.errors.push(String(event.data.message).slice(0, 1500));
      });
    });
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    if (!response?.ok()) {
      add(
        errors,
        `Workspace returned HTTP ${response?.status() ?? "no response"}`,
      );
      return result("failed");
    }
    await page.waitForFunction(() => {
      const state = (window as any).__atelierPreviewCheck;
      return state?.ready || state?.errors.length;
    });
    await page.waitForTimeout(300);
    const state = await page.evaluate(
      () => (window as any).__atelierPreviewCheck,
    );
    for (const error of state.errors) add(errors, error);
    if (!state.ready && !errors.length)
      add(errors, "Artifact did not signal that it was ready");
    const frame = page
      .frames()
      .find((frame) => frame.parentFrame() === page.mainFrame());
    if (!frame) add(errors, "Artifact frame is missing");
    else if (
      state.ready &&
      (await frame.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ))
    )
      add(warnings, "Artifact overflows the viewport horizontally");
    suppressedWrites += await page.evaluate(
      () => (window as any).__atelierSuppressedWrites || 0,
    );
    if (suppressedWrites)
      add(
        warnings,
        "App-data writes were simulated during this check; saved data was not changed.",
      );
    const report = result(errors.length ? "failed" : "passed");
    if (state.ready && frame) {
      try {
        report.thumbnail = (
          await page
            .locator("iframe")
            .screenshot({ type: "jpeg", quality: 60, timeout: 5000 })
        ).toString("base64");
      } catch {
        report.warnings.push("Could not capture an artifact thumbnail.");
      }
    }
    if (screenshot)
      report.screenshot = {
        mimeType: "image/png",
        data: (await page.screenshot({ type: "png", timeout: 5000 })).toString(
          "base64",
        ),
      };
    return report;
  } catch (error) {
    add(
      errors,
      expired
        ? "Preview check exceeded its time limit"
        : `Preview check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result("failed");
  } finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
  }
}
