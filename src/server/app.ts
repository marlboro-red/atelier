import Fastify from "fastify";
import { z } from "zod";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { Store, HttpError } from "./store.js";
import {
  createSchema,
  revisionSchema,
  commentSchema,
} from "../shared/schema.js";
import { render } from "./render.js";
import { checkPreview, type PreviewCheck } from "./check.js";
import { workspacePolicy } from "../shared/security.js";
export function createApp(store: Store, previewPort = 4311) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
  });
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host?.split(":")[0];
    if (!["localhost", "127.0.0.1", "atelier.localhost"].includes(host ?? ""))
      throw new HttpError(403, "Unrecognized local hostname");
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://${req.headers.host}` &&
      origin !== "http://127.0.0.1:5173"
    )
      throw new HttpError(403, "Cross-origin access denied");
    reply.header("Content-Security-Policy", workspacePolicy(previewPort));
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
  });
  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: e.issues.map((i) => i.message).join("; ") });
    reply
      .code(e.statusCode ?? 500)
      .send({ error: e.message ?? "Internal error" });
  });
  async function check(
    id: string,
    revision: number,
    viewport = { width: 1280, height: 900 },
    screenshot = false,
  ): Promise<PreviewCheck> {
    const address = app.server.address();
    if (!address || typeof address === "string")
      return {
        status: "unavailable",
        revision,
        viewport,
        errors: [],
        warnings: [
          "The workspace must be listening on a TCP port for a browser check.",
        ],
        durationMs: 0,
      };
    return checkPreview(
      `http://127.0.0.1:${address.port}/a/${encodeURIComponent(id)}/revisions/${revision}`,
      revision,
      viewport,
      screenshot,
    );
  }
  const changed = (id: string) => events.emit("change", { id });
  const params = (req: any) =>
    req.params as { id: string; n: string; cid: string };
  app.get("/api/health", async () => ({ ok: true, previewPort }));
  app.get("/api/artifacts", async () => store.list());
  app.post("/api/artifacts", async (req, reply) => {
    const a = store.create(createSchema.parse(req.body));
    changed(a.id);
    return reply.code(201).send({ ...a, preview: await check(a.id, a.head) });
  });
  app.get("/api/artifacts/:id", async (req) => store.get(params(req).id));
  app.get("/api/artifacts/:id/revisions", async (req) =>
    store
      .revisions(params(req).id)
      .map(({ content, ...r }) => ({ ...r, kind: content.kind })),
  );
  app.get("/api/artifacts/:id/revisions/:n", async (req) =>
    store.revision(
      params(req).id,
      z.coerce.number().int().positive().parse(params(req).n),
    ),
  );
  app.post("/api/artifacts/:id/revisions", async (req, reply) => {
    const id = params(req).id;
    const r = store.update(id, revisionSchema.parse(req.body));
    changed(id);
    return reply.code(201).send({ ...r, preview: await check(id, r.number) });
  });
  app.post("/api/artifacts/:id/restore", async (req) => {
    const id = params(req).id;
    const body = z
      .object({
        revision: z.number().int().positive(),
        baseRevision: z.number().int().positive(),
        author: z.string().max(100).default("Agent"),
      })
      .parse(req.body);
    const r = store.update(id, {
      baseRevision: body.baseRevision,
      content: store.revision(id, body.revision).content,
      summary: `Restored revision ${body.revision}`,
      author: body.author,
      commentIds: [],
    });
    changed(id);
    return { ...r, preview: await check(id, r.number) };
  });
  app.post("/api/artifacts/:id/duplicate", async (req) => {
    const id = params(req).id;
    const body = z
      .object({
        revision: z.number().int().positive(),
        author: z.string().max(100).default("Agent"),
      })
      .parse(req.body);
    const a = store.get(id);
    const copy = store.create({
      title: a.title + " — copy",
      description: a.description,
      author: body.author,
      summary: `Copied from ${a.id} revision ${body.revision}`,
      content: store.revision(id, body.revision).content,
    });
    changed(copy.id);
    return { ...copy, preview: await check(copy.id, copy.head) };
  });
  app.post("/api/artifacts/:id/check", async (req) => {
    const id = params(req).id;
    const input = z
      .object({
        revision: z.number().int().positive().optional(),
        width: z.number().int().min(320).max(2560).default(1280),
        height: z.number().int().min(320).max(2160).default(900),
        screenshot: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    const revision = store.revision(id, input.revision);
    return check(
      id,
      revision.number,
      {
        width: input.width,
        height: input.height,
      },
      input.screenshot,
    );
  });
  app.get("/api/artifacts/:id/comments", async (req) =>
    store.comments(params(req).id),
  );
  app.post("/api/artifacts/:id/comments", async (req, reply) => {
    const id = params(req).id;
    const c = store.addComment(id, commentSchema.parse(req.body));
    changed(id);
    return reply.code(201).send(c);
  });
  app.patch("/api/artifacts/:id/comments/:cid", async (req) => {
    const { id, cid } = params(req);
    const input = z
      .object({
        status: z
          .enum(["open", "in_progress", "addressed", "resolved"])
          .optional(),
        reply: z.string().trim().min(1).max(10000).optional(),
        author: z.string().max(100).default("Agent"),
      })
      .parse(req.body);
    const c = store.comment(id, cid);
    if (input.status) c.status = input.status;
    if (input.reply)
      c.replies.push({
        body: input.reply,
        author: input.author,
        createdAt: new Date().toISOString(),
      });
    store.saveComment(c);
    changed(id);
    return c;
  });
  app.get("/api/artifacts/:id/data", async (req) => ({
    data: store.data(params(req).id),
  }));
  app.put("/api/artifacts/:id/data", async (req) => {
    const body = z
      .object({ data: z.unknown().refine((v) => v !== undefined) })
      .parse(req.body);
    if (JSON.stringify(body.data).length > 2 * 1024 * 1024)
      throw new HttpError(413, "App data limit is 2 MB");
    store.setData(params(req).id, body.data);
    return { ok: true };
  });
  app.get("/api/events", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    reply.raw.write(": connected\n\n");
    streams.add(reply.raw);
    const listener = (data: unknown) =>
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    events.on("change", listener);
    const timer = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20000);
    reply.raw.on("close", () => {
      clearInterval(timer);
      streams.delete(reply.raw);
      events.off("change", listener);
    });
  });
  app.post("/api/artifacts/:id/export", async (req, reply) => {
    const id = params(req).id;
    const input = z
      .object({
        revision: z.number().int().positive(),
        format: z.enum(["html", "pdf"]),
        snapshot: z.unknown().optional(),
      })
      .parse(req.body);
    const r = store.revision(id, input.revision);
    const html = await render(r.content, {
      id,
      revision: r.number,
      data: store.data(id),
      snapshot: input.snapshot,
      standalone: true,
      freeze: input.format === "pdf",
    });
    const name =
      store
        .get(id)
        .title.replace(/[^a-zA-Z0-9_-]/g, "-")
        .slice(0, 80) + `-v${r.number}`;
    reply.header(
      "Content-Disposition",
      `attachment; filename="${name}.${input.format}"`,
    );
    if (input.format === "html") return reply.type("text/html").send(html);
    const { chromium } = await import("playwright");
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      throw new HttpError(
        503,
        "PDF browser is missing. Run: atelier install-browser",
      );
    }
    try {
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
      return reply.type("application/pdf").send(pdf);
    } finally {
      await browser.close();
    }
  });
  return app;
}
export function createPreviewApp(store: Store, workspacePort = 4310) {
  const app = Fastify();
  app.get("/preview/:id/:n", async (req, reply) => {
    const host = req.headers.host?.split(":")[0];
    if (!["localhost", "127.0.0.1", "atelier.localhost"].includes(host ?? ""))
      return reply.code(403).send("Invalid host");
    if (req.headers["sec-fetch-dest"] !== "iframe")
      return reply
        .code(403)
        .type("text/plain")
        .send("Open this artifact through the Atelier workspace.");
    const { id, n } = req.params as any;
    reply.header(
      "Content-Security-Policy",
      `sandbox allow-scripts; frame-ancestors http://atelier.localhost:${workspacePort} http://localhost:${workspacePort} http://127.0.0.1:${workspacePort} http://127.0.0.1:5173`,
    );
    reply.header("Cache-Control", "no-store");
    try {
      const r = store.revision(id, Number(n));
      return reply.type("text/html").send(
        await render(r.content, {
          id,
          revision: r.number,
          data: store.data(id),
        }),
      );
    } catch (e: any) {
      const message = JSON.stringify(e.message).replace(/</g, "\\u003c");
      return reply
        .type("text/html")
        .send(
          `<html><body style="font-family:system-ui;padding:40px"><h2>Preview needs a fix</h2><pre id="error" style="white-space:pre-wrap"></pre><script>const message=${message};document.getElementById('error').textContent=message;parent.postMessage({atelier:true,type:'runtime-error',message},'*')</script></body></html>`,
        );
    }
  });
  return app;
}
