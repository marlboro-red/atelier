import { browserJobs } from "./job-queue.js";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { HttpError } from "./store.js";

export function renderPdf(html: string, deadlineMs = 30000): Promise<Buffer> {
  return browserJobs.run(
    "pdf:" +
      createHash("sha256")
        .update(html)
        .update(String(deadlineMs))
        .digest("hex"),
    () => runPdf(html, deadlineMs),
    1,
  );
}
async function runPdf(html: string, deadlineMs = 30000): Promise<Buffer> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let expired = false;
  const watchdog = setTimeout(() => {
    expired = true;
    void browser?.close().catch(() => {});
  }, deadlineMs);
  try {
    try {
      browser = await chromium.launch({
        headless: true,
        timeout: Math.min(deadlineMs, 10000),
      });
    } catch {
      throw new HttpError(
        503,
        "PDF browser is missing. Run: atelier install-browser",
      );
    }
    if (expired) throw new HttpError(504, "PDF export exceeded its time limit");
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const origin = new URL(request.url()).origin;
      const allowed =
        (request.resourceType() === "stylesheet" &&
          origin === "https://fonts.googleapis.com") ||
        (request.resourceType() === "font" &&
          origin === "https://fonts.gstatic.com");
      if (!allowed) return route.abort();
      try {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: 10000,
        });
        if (response.status() >= 300 && response.status() < 400)
          return route.abort();
        await route.fulfill({ response });
      } catch {
        await route.abort();
      }
    });
    await page.setContent(html, { waitUntil: "load", timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "15mm", bottom: "15mm", left: "12mm", right: "12mm" },
    });
    return pdf;
  } catch (error) {
    if (expired) throw new HttpError(504, "PDF export exceeded its time limit");
    throw error;
  } finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
  }
}
