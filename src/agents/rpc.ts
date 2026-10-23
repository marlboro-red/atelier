import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/** Both app-server and ACP use JSON messages delimited by newlines. */
export class AgentRpc extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  private resolveClosed!: (error: Error) => void;
  readonly closed = new Promise<Error>((resolve) => {
    this.resolveClosed = resolve;
  });
  private sequence = 0;
  private buffer = "";
  private ended?: Error;
  private closing = false;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  onRequest: (method: string, params: any) => Promise<unknown> = async () => {
    throw new Error("Unsupported agent request");
  };
  constructor(command: string, args: string[], cwd: string) {
    super();
    this.child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      shell: false,
      detached: process.platform !== "win32",
    });
    // Agent diagnostics stay out of the protocol. Do not forward credentials or
    // arbitrary terminal control sequences from a child's stderr.
    this.child.stderr.resume();
    this.child.on("error", (e) =>
      this.fail(new Error(`Cannot start ${command}: ${e.message}`)),
    );
    this.child.on("exit", (code) =>
      this.fail(new Error(`${command} exited (${code ?? "signal"})`)),
    );
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 16 * 1024 * 1024) {
        this.close();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail(new Error("Invalid agent protocol response"));
          this.close();
        }
      }
    });
  }
  private fail(error: Error) {
    if (this.ended) return;
    this.ended = error;
    this.resolveClosed(error);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
  private receive(message: any) {
    if (message.method && message.id !== undefined) {
      void this.onRequest(message.method, message.params)
        .then(
          (result) => this.write({ jsonrpc: "2.0", id: message.id, result }),
          (error) =>
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: String(error.message ?? error) },
            }),
        )
        .catch(() => {});
    } else if (message.method)
      this.emit("notification", message.method, message.params);
    else {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      message.error
        ? p.reject(new Error(message.error.message))
        : p.resolve(message.result);
    }
  }
  private write(value: unknown) {
    if (this.ended) throw this.ended;
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  notify(method: string, params?: unknown) {
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    if (this.ended) return Promise.reject(this.ended);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    this.fail(new Error("Agent connection closed"));
    this.child.stdin.end();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && this.child.pid)
          process.kill(-this.child.pid, signal);
        else this.child.kill(signal);
      } catch {}
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 2000);
    timer.unref();
  }
}
