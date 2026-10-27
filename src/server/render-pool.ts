import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { render } from "./render.js";
import { HttpError } from "./store.js";

type RenderInput = Parameters<typeof render>;
// Revisions are immutable, so identical input always renders the same document.
// Reusing finished and in-flight renders avoids a process spawn and a full
// dependency bundle on every view.
export class RenderPool {
  private active = 0;
  private closed = false;
  private children = new Set<ChildProcess>();
  private cache = new Map<string, string>();
  private cachedBytes = 0;
  private pending = new Map<string, Promise<string>>();
  constructor(
    private worker = new URL("./render-worker.mjs", import.meta.url),
    private deadlineMs = 30000,
    private cacheBytes = 128 * 1024 * 1024,
  ) {}
  async run(...input: RenderInput): Promise<string> {
    if (this.closed) throw new HttpError(503, "Renderer is stopping");
    const key = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const job = this.spawn(input).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    const html = await job;
    this.remember(key, html);
    return html;
  }
  private remember(key: string, html: string) {
    const size = Buffer.byteLength(html);
    if (this.closed || size > this.cacheBytes / 4 || this.cache.has(key))
      return;
    this.cache.set(key, html);
    this.cachedBytes += size;
    for (const [oldest, value] of this.cache) {
      if (this.cachedBytes <= this.cacheBytes) break;
      this.cache.delete(oldest);
      this.cachedBytes -= Buffer.byteLength(value);
    }
  }
  private async spawn(input: RenderInput): Promise<string> {
    if (this.closed || this.active >= 2)
      throw new HttpError(503, "Renderer is busy. Try again shortly.");
    this.active++;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "atelier-render-"));
      dir = await realpath(dir);
      if (this.closed) throw new HttpError(503, "Renderer is stopping");
      const env: NodeJS.ProcessEnv = {
        HOME: dir,
        USERPROFILE: dir,
        TMPDIR: dir,
        TEMP: dir,
        TMP: dir,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
      };
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--max-old-space-size=384", fileURLToPath(this.worker)],
          {
            cwd: dir,
            env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          },
        );
        this.children.add(child);
        let answer: string | undefined;
        let failure: Error | undefined;
        const timer = setTimeout(() => {
          failure = new HttpError(
            504,
            "Rendering exceeded its 30-second time limit",
          );
          this.stop(child);
        }, this.deadlineMs);
        child.on("error", (error) => {
          failure = error;
        });
        child.on("message", (message: any) => {
          if (answer !== undefined || failure) return;
          if (
            typeof message?.html === "string" &&
            Buffer.byteLength(message.html) <= 64 * 1024 * 1024
          )
            answer = message.html;
          else
            failure = new HttpError(
              422,
              typeof message?.error === "string"
                ? message.error.slice(0, 4000)
                : "Renderer returned an invalid result",
            );
          this.stop(child);
        });
        child.on("close", () => {
          clearTimeout(timer);
          this.children.delete(child);
          if (failure) reject(failure);
          else if (answer !== undefined) resolve(answer);
          else
            reject(
              new HttpError(
                422,
                "Renderer stopped before completing the document",
              ),
            );
        });
        child.send(input, (error) => {
          if (error) {
            failure = error;
            this.stop(child);
          }
        });
      });
    } finally {
      try {
        if (dir) await rm(dir, { recursive: true, force: true });
      } finally {
        this.active--;
      }
    }
  }
  private stop(child: ChildProcess) {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  close() {
    this.closed = true;
    this.cache.clear();
    this.cachedBytes = 0;
    for (const child of this.children) this.stop(child);
  }
}
