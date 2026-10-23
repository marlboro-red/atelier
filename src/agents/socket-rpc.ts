import WebSocket from "ws";
import { createConnection } from "node:net";
import { EventEmitter } from "node:events";

/** A client of an existing local server. Closing this socket never stops it. */
export class SocketRpc extends EventEmitter {
  private socket: WebSocket;
  private ready: Promise<void>;
  private error?: Error;
  private sequence = 0;
  private resolveClosed!: (error: Error) => void;
  readonly closed = new Promise<Error>((resolve) => {
    this.resolveClosed = resolve;
  });
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(path: string) {
    super();
    this.socket = new WebSocket("ws://localhost/", {
      createConnection: () => createConnection(path),
      followRedirects: false,
      handshakeTimeout: 5000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
      this.socket.once("close", () => reject(new Error("Codex socket closed")));
    });
    void this.ready.catch(() => {});
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("Codex socket closed")));
    this.socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        // This connection only reads metadata. It never subscribes to a thread
        // or answers native tool approvals on behalf of the user's client.
        if (message.method) {
          this.emit("notification", message.method, message.params);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } catch {
        this.fail(new Error("Invalid Codex socket response"));
        this.socket.terminate();
      }
    });
  }
  private fail(error: Error) {
    if (this.error) return;
    this.error = error;
    this.resolveClosed(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  async request(method: string, params: unknown, timeout = 5000): Promise<any> {
    await this.ready;
    if (this.error) throw this.error;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.fail(error);
      });
    });
  }
  notify(method: string) {
    if (this.error) throw this.error;
    this.socket.send(JSON.stringify({ method }));
  }
  close() {
    this.fail(new Error("Codex connection closed"));
    this.socket.terminate();
  }
}
