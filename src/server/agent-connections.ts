import {
  connectCodexSession,
  listCodexSessions,
} from "../agents/codex-queue.js";
import { watchFeedback } from "../agents/watch.js";
import { Feedback } from "./feedback.js";
import { HttpError } from "./store.js";
import type { Adapter } from "../agents/adapters.js";

export const localAgents = {
  list: listCodexSessions,
  connect: (session: string) =>
    connectCodexSession({ session, cwd: process.cwd() }),
};
export class AgentConnections {
  private active = new Map<
    string,
    {
      session: string;
      control: AbortController;
      ready: Promise<void>;
      done: Promise<void>;
      adapter?: Adapter;
    }
  >();
  private closed = false;
  constructor(
    private feedback: Feedback,
    private changed: (id: string) => void,
    private agents = localAgents,
  ) {}
  list() {
    return this.agents.list();
  }
  async connect(id: string, session: string) {
    if (this.closed) throw new HttpError(503, "atelier is stopping");
    const current = this.active.get(id);
    if (current) {
      if (current.session !== session)
        throw new HttpError(409, "Disconnect the current conversation first");
      await current.ready;
      const status = this.feedback.status(id);
      if (!status.connected)
        throw new HttpError(
          409,
          "Conversation disconnected. Refresh and connect again.",
        );
      return status;
    }
    if (this.active.size >= 32)
      throw new HttpError(
        503,
        "Disconnect an artifact before connecting another conversation",
      );
    if (this.feedback.status(id).connected)
      throw new HttpError(
        409,
        "An agent is already connected. Disconnect it first.",
      );
    let connected!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      connected = resolve;
      failed = reject;
    });
    const entry = {
      session,
      control: new AbortController(),
      ready,
      done: Promise.resolve(),
      adapter: undefined as Adapter | undefined,
    };
    this.active.set(id, entry);
    entry.done = (async () => {
      try {
        entry.adapter = await this.agents.connect(session);
        entry.control.signal.throwIfAborted();
        const prefix = `/artifacts/${encodeURIComponent(id)}/feedback/`;
        await watchFeedback({
          id,
          provider: "codex",
          adapter: entry.adapter,
          signal: entry.control.signal,
          state: () => "connected",
          log: () => {},
          onConnected: () => {
            connected();
            this.changed(id);
          },
          request: async (path, _method, body: any) => {
            if (!path.startsWith(prefix))
              throw new Error("Invalid internal feedback request");
            switch (path.slice(prefix.length)) {
              case "connect":
                return this.feedback.connect(id, "codex", session);
              case "heartbeat":
                return this.feedback.heartbeat(id, body.token, body.state);
              case "claim":
                return this.feedback.claim(id, body.token);
              case "finish": {
                const result = this.feedback.finish(
                  id,
                  body.token,
                  body.ids,
                  body.error,
                );
                this.changed(id);
                return result;
              }
              case "disconnect":
                return this.feedback.disconnect(id, body.token);
              default:
                throw new Error("Unknown internal feedback request");
            }
          },
        });
      } catch (error) {
        failed(error);
      } finally {
        failed(new Error("Conversation disconnected"));
        entry.adapter?.close();
        if (this.active.get(id) === entry) this.active.delete(id);
        this.changed(id);
      }
    })();
    await ready;
    const status = this.feedback.status(id);
    if (!status.connected)
      throw new HttpError(
        409,
        "Conversation disconnected. Refresh and connect again.",
      );
    return status;
  }
  async stop(id: string) {
    const entry = this.active.get(id);
    if (!entry) return;
    entry.control.abort();
    entry.adapter?.close();
    await entry.done;
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
  }
}
