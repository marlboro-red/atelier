import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { render } from "./render.js";
import { HttpError } from "./store.js";

type RenderInput = Parameters<typeof render>;
export class RenderPool {
  private active = 0;
  private closed = false;
  private children = new Set<ChildProcess>();
  constructor(
    private worker = new URL("./render-worker.mjs", import.meta.url),
    private deadlineMs = 30000,
  ) {}
  async run(...input: RenderInput): Promise<string> {
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
    for (const child of this.children) this.stop(child);
  }
}
