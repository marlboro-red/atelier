import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { render } from "./render.js";
import { assemble, type CompiledDocument } from "./render-document.js";
import { DiskCache } from "./disk-cache.js";
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
  private disk?: DiskCache;
  private fingerprint?: Promise<string>;
  constructor(
    private worker = new URL("./render-worker.mjs", import.meta.url),
    private deadlineMs = 30000,
    private cacheBytes = 128 * 1024 * 1024,
    private cacheDirectory?: string,
  ) {
    if (cacheDirectory)
      this.disk = new DiskCache(
        join(cacheDirectory, "cache", "compiled"),
        cacheBytes,
      );
  }
  private version() {
    return (this.fingerprint ??= Promise.all(
      [
        "./render.ts",
        "./render-document.ts",
        "./imports.ts",
        "./cdn.ts",
        "../shared/security.ts",
        "../../package-lock.json",
      ].map((path) => readFile(new URL(path, import.meta.url))),
    ).then((files) => {
      const hash = createHash("sha256");
      for (const file of files) hash.update(file);
      return hash.digest("hex");
    }));
  }
  async run(...input: RenderInput): Promise<string> {
    if (this.closed) throw new HttpError(503, "Renderer is stopping");
    const compiled =
      this.worker.href === new URL("./render-worker.mjs", import.meta.url).href;
    const key = createHash("sha256")
      .update(compiled ? await this.version() : "test-worker")
      .update(JSON.stringify(compiled ? input[0] : input))
      .digest("hex");
    const finish = (value: string) => {
      if (this.closed) throw new HttpError(503, "Renderer is stopping");
      const html = compiled
        ? assemble(JSON.parse(value) as CompiledDocument, input[1])
        : value;
      if (Buffer.byteLength(html) > 64 * 1024 * 1024)
        throw new HttpError(422, "Rendered document exceeds 64 MiB");
      return html;
    };
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return finish(cached);
    }
    const existing = this.pending.get(key);
    if (existing) return finish(await existing);
    const job = (async () => {
      const disk = await this.disk?.get(key);
      if (disk !== undefined) {
        try {
          if (compiled) {
            const value = JSON.parse(disk);
            if (
              typeof value.script !== "string" ||
              typeof value.styles !== "string" ||
              !["htmlOpen", "headOpen", "bodyOpen", "head", "body"].every(
                (key) => typeof value.document?.[key] === "string",
              )
            )
              throw new Error("Invalid compilation cache");
          }
          this.remember(key, disk);
          return disk;
        } catch {
          /* Rebuild damaged cache entries. */
        }
      }
      const result = await this.spawn(input);
      this.remember(key, result);
      await this.disk?.put(key, result);
      return result;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return finish(await job);
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
        ...(this.cacheDirectory
          ? {
              ATELIER_SCRIPT_CACHE: join(
                this.cacheDirectory,
                "cache",
                "scripts",
              ),
            }
          : {}),
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
