import Fastify from "fastify";
import { AgentConnections, localAgents } from "./agent-connections.js";
import { Feedback } from "./feedback.js";
import { z } from "zod";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { Store, HttpError } from "./store.js";
import {
  createSchema,
  revisionSchema,
  commentSchema,
} from "../shared/schema.js";
import { RenderPool } from "./render-pool.js";
import { checkPreview, type PreviewCheck } from "./check.js";
import { renderPdf } from "./pdf.js";
import { workspacePolicy } from "../shared/security.js";
export function createApp(
  store: Store,
  previewPort = 4311,
  agents = localAgents,
) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const renderer = new RenderPool(
    undefined,
    undefined,
    undefined,
    store.directory,
  );
  const feedback = new Feedback(store);
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const streams = new Set<ServerResponse>();
  const connections = new AgentConnections(
    feedback,
    (id) => events.emit("change", { id }),
    agents,
  );
  app.addHook("preClose", async () => {
    await connections.close();
    renderer.close();
    for (const stream of streams) stream.end();
  });
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host?.split(":")[0];
    if (!["localhost", "127.0.0.1", "atelier.localhost"].includes(host ?? ""))
      throw new HttpError(403, "Unrecognized local hostname");
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`)
      throw new HttpError(403, "Cross-origin access denied");
    if (
      req.headers["sec-fetch-site"] === "cross-site" &&
      req.headers["sec-fetch-mode"] !== "navigate"
    )
      throw new HttpError(403, "Cross-site resource access denied");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    reply.header("Content-Security-Policy", workspacePolicy());
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
    let html: string;
    try {
      html = await renderer.run(store.revision(id, revision).content, {
        id,
        revision,
        data: store.data(id),
      });
    } catch (error) {
      return {
        status: "failed",
        revision,
        viewport,
        errors: [String(error)],
        warnings: [],
        durationMs: 0,
      };
    }
    const { thumbnail, ...report } = await checkPreview(
      `http://127.0.0.1:${address.port}/a/${encodeURIComponent(id)}/revisions/${revision}`,
      revision,
      viewport,
      screenshot,
      30000,
      html,
    );
    if (
      thumbnail &&
      viewport.width === 1280 &&
      viewport.height === 900 &&
      store.saveThumbnail(id, revision, Buffer.from(thumbnail, "base64"))
    )
      changed(id);
    return report;
  }
  const backgroundChecks = new Set<Promise<unknown>>();
  app.addHook("preClose", async () => {
    await Promise.allSettled(backgroundChecks);
  });
  async function publicationCheck(id: string, revision: number, wait = true) {
    const job = check(id, revision);
    if (wait) return job;
    backgroundChecks.add(job);
    void job.finally(() => backgroundChecks.delete(job)).catch(() => {});
    return { status: "pending", revision };
  }
  const changed = (id: string) => events.emit("change", { id });
  const params = (req: any) =>
    req.params as { id: string; n: string; cid: string };
  app.get("/api/health", async () => ({
    ok: true,
    service: "atelier",
    version: "0.1.0",
    previewPort,
  }));
  app.get("/api/artifacts", async () => store.list());
  app.post("/api/artifacts", async (req, reply) => {
    const input = createSchema.parse(req.body);
    const a = store.create(input);
    changed(a.id);
    return reply
      .code(201)
      .send({
        ...a,
        preview: await publicationCheck(a.id, a.head, input.waitForCheck),
      });
  });
  app.get("/api/artifacts/:id", async (req) => store.get(params(req).id));
  app.get("/api/artifacts/:id/thumbnail", async (req, reply) =>
    reply
      .type("image/jpeg")
      .header("Cache-Control", "private, max-age=3600")
      .send(Buffer.from(store.thumbnail(params(req).id))),
  );
  app.patch("/api/artifacts/:id", async (req) => {
    const id = params(req).id;
    const { title } = z
      .object({ title: z.string().trim().min(1).max(160) })
      .parse(req.body);
    const artifact = store.rename(id, title);
    changed(id);
    return artifact;
  });
  app.delete("/api/artifacts/:id", async (req) => {
    const id = params(req).id;
    const { baseRevision } = z
      .object({ baseRevision: z.number().int().positive() })
      .parse(req.body);
    store.remove(id, baseRevision);
    await connections.stop(id);
    changed(id);
    return { deleted: true, id };
  });
  app.get("/api/artifacts/:id/revisions", async (req) => {
    const { before, limit } = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(200),
      })
      .parse(req.query);
    return store.revisions(params(req).id, before, limit);
  });
  app.get("/api/artifacts/:id/revisions/:n", async (req) =>
    store.revision(
      params(req).id,
      z.coerce.number().int().positive().parse(params(req).n),
    ),
  );
  app.get("/api/artifacts/:id/revisions/:n/preview", async (req, reply) => {
    const { id, n } = params(req);
    const r = store.revision(id, z.coerce.number().int().positive().parse(n));
    reply.header("Cache-Control", "no-store");
    try {
      return {
        html: await renderer.run(r.content, {
          id,
          revision: r.number,
          data: store.data(id),
        }),
      };
    } catch (error) {
      const message = JSON.stringify(
        error instanceof Error ? error.message : String(error),
      ).replace(/</g, "\\u003c");
      return {
        html: `<html><body style="font-family:system-ui;padding:40px"><h2>Preview needs a fix</h2><pre id="error" style="white-space:pre-wrap"></pre><script>const message=${message};document.getElementById('error').textContent=message;parent.postMessage({atelier:true,type:'runtime-error',message},'*')</script></body></html>`,
      };
    }
  });
  app.post("/api/artifacts/:id/revisions", async (req, reply) => {
    const id = params(req).id;
    const input = revisionSchema.parse(req.body);
    const r = store.update(id, input);
    changed(id);
    return reply
      .code(201)
      .send({
        ...r,
        preview: await publicationCheck(id, r.number, input.waitForCheck),
      });
  });
  app.post("/api/artifacts/:id/restore", async (req) => {
    const id = params(req).id;
    const body = z
      .object({
        revision: z.number().int().positive(),
        baseRevision: z.number().int().positive(),
        author: z.string().max(100).default("Agent"),
        notifyAgent: z.boolean().default(false),
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
        notifyAgent: z.boolean().default(false),
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
  // A viewer read is passive; only an agent's explicit read records receipt.
  app.post("/api/artifacts/:id/comments/read", async (req) => {
    const id = params(req).id;
    z.object({})
      .strict()
      .parse(req.body ?? {});
    let updated = false;
    const comments = store.transaction(() => {
      const comments = store.comments(id);
      for (const comment of comments) {
        if (!comment.acknowledgedAt && comment.status !== "resolved") {
          comment.acknowledgedAt = new Date().toISOString();
          store.saveComment(comment);
          updated = true;
        }
      }
      return comments;
    });
    if (updated) changed(id);
    return comments;
  });
  app.post("/api/artifacts/:id/comments", async (req, reply) => {
    const id = params(req).id;
    const input = commentSchema
      .extend({ notifyAgent: z.boolean().default(false) })
      .parse(req.body);
    const { notifyAgent, ...comment } = input;
    const c = store.transaction(() => {
      const created = store.addComment(id, comment);
      if (notifyAgent) feedback.enqueue(id, created.id, "comment");
      return created;
    });
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
        notifyAgent: z.boolean().default(false),
      })
      .parse(req.body);
    const c = store.comment(id, cid);
    const reopened = input.status === "open" && c.status !== "open";
    if (input.status) c.status = input.status;
    if (input.notifyAgent && input.reply) c.status = "open";
    if (input.notifyAgent && (input.reply || reopened)) delete c.acknowledgedAt;
    if (input.reply)
      c.replies.push({
        body: input.reply,
        author: input.author,
        createdAt: new Date().toISOString(),
      });
    store.transaction(() => {
      store.saveComment(c);
      if (input.notifyAgent && (input.reply || reopened))
        feedback.enqueue(id, c.id, input.reply ? "reply" : "reopened");
    });
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
  app.get("/api/agents/codex/sessions", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return await connections.list();
    } catch {
      throw new HttpError(
        503,
        "Open Codex to connect a conversation, then refresh this list.",
      );
    }
  });
  app.post("/api/artifacts/:id/feedback/codex", async (req) => {
    const input = z
      .object({ session: z.string().uuid() })
      .strict()
      .parse(req.body);
    return connections.connect(params(req).id, input.session);
  });
  app.get("/api/artifacts/:id/feedback", async (req) =>
    feedback.status(params(req).id),
  );
  app.post("/api/artifacts/:id/feedback/connect", async (req) => {
    const input = z
      .object({
        provider: z.enum(["codex", "copilot", "claude"]),
        session: z.string().min(1).max(300),
      })
      .parse(req.body);
    const result = feedback.connect(
      params(req).id,
      input.provider,
      input.session,
    );
    changed(params(req).id);
    return result;
  });
  app.post("/api/artifacts/:id/feedback/heartbeat", async (req) => {
    const input = z
      .object({
        token: z.string().uuid(),
        state: z.enum([
          "connected",
          "working",
          "needs_permission",
          "awaiting_agent",
        ]),
      })
      .parse(req.body);
    return feedback.heartbeat(params(req).id, input.token, input.state);
  });
  app.post("/api/artifacts/:id/feedback/claim", async (req) => {
    const input = z.object({ token: z.string().uuid() }).parse(req.body);
    return feedback.claim(params(req).id, input.token);
  });
  app.post("/api/artifacts/:id/feedback/finish", async (req) => {
    const input = z
      .object({
        token: z.string().uuid(),
        ids: z.array(z.number().int().positive()).min(1).max(50),
        error: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const result = feedback.finish(
      params(req).id,
      input.token,
      input.ids,
      input.error,
    );
    changed(params(req).id);
    return result;
  });
  app.post("/api/artifacts/:id/feedback/disconnect", async (req) => {
    const input = z
      .object({ token: z.string().uuid().optional() })
      .parse(req.body);
    const result = feedback.disconnect(params(req).id, input.token);
    await connections.stop(params(req).id);
    changed(params(req).id);
    return result;
  });
  app.post("/api/artifacts/:id/feedback/retry", async (req) => {
    const result = feedback.retry(params(req).id);
    changed(params(req).id);
    return result;
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
    const html = await renderer.run(r.content, {
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
    const pdf = await renderPdf(html);
    return reply.type("application/pdf").send(pdf);
  });
  return app;
}
// Keep the old port closed to executable previews for existing bookmarks.
export function createPreviewApp() {
  const app = Fastify();
  app.get("/preview/:id/:n", async (_req, reply) =>
    reply
      .code(403)
      .type("text/plain")
      .send("Open this artifact through the atelier workspace."),
  );
  return app;
}
