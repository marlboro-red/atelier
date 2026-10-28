import { randomUUID } from "node:crypto";
import { Store, HttpError } from "./store.js";

export type Provider = "codex" | "copilot" | "claude";
export type FeedbackEvent = { id: number; commentId: string; kind: string };
const leaseMs = 30_000;

/** The database records dispatch before an adapter writes to an agent. A crash
 * at that boundary is ambiguous and requires an explicit retry, never replay. */
export class Feedback {
  constructor(
    private store: Store,
    private now = Date.now,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_connections (
        artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
        token TEXT NOT NULL, provider TEXT NOT NULL, session TEXT NOT NULL,
        enabled INTEGER NOT NULL, heartbeat INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        comment_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        token TEXT, created_at INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS feedback_pending ON feedback_events(artifact_id,status,id);
    `);
    if (
      !store
        .prepare("SELECT name FROM sqlite_master WHERE name='feedback_counts'")
        .get()
    ) {
      store.transaction(() =>
        store.db.exec(`
        CREATE TABLE feedback_counts (artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE, status TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(artifact_id,status));
        INSERT INTO feedback_counts SELECT artifact_id,status,COUNT(*) FROM feedback_events GROUP BY artifact_id,status;
        CREATE TRIGGER feedback_count_insert AFTER INSERT ON feedback_events BEGIN
          INSERT INTO feedback_counts VALUES(NEW.artifact_id,NEW.status,1) ON CONFLICT(artifact_id,status) DO UPDATE SET n=n+1;
        END;
        CREATE TRIGGER feedback_count_update AFTER UPDATE OF status ON feedback_events WHEN OLD.status<>NEW.status BEGIN
          UPDATE feedback_counts SET n=n-1 WHERE artifact_id=OLD.artifact_id AND status=OLD.status;
          INSERT INTO feedback_counts VALUES(NEW.artifact_id,NEW.status,1) ON CONFLICT(artifact_id,status) DO UPDATE SET n=n+1;
        END;
        CREATE TRIGGER feedback_count_delete AFTER DELETE ON feedback_events WHEN OLD.status NOT IN ('delivered','cancelled') BEGIN
          UPDATE feedback_counts SET n=n-1 WHERE artifact_id=OLD.artifact_id AND status=OLD.status;
        END;
      `),
      );
    }
  }
  enqueue(id: string, commentId: string, kind: string) {
    this.store
      .prepare(
        "INSERT INTO feedback_events(artifact_id,comment_id,kind,created_at) VALUES (?,?,?,?)",
      )
      .run(id, commentId, kind, this.now());
  }
  private connection(id: string) {
    this.store.get(id);
    return this.store
      .prepare("SELECT * FROM feedback_connections WHERE artifact_id=?")
      .get(id);
  }
  status(id: string) {
    const c = this.connection(id);
    const connected =
      !!c && !!c.enabled && Number(c.heartbeat) > this.now() - leaseMs;
    const counts = this.store
      .prepare("SELECT status,n FROM feedback_counts WHERE artifact_id=?")
      .all(id);
    const count = (status: string) =>
      Number(counts.find((r) => r.status === status)?.n ?? 0);
    return {
      provider: c?.provider ?? null,
      session: c?.session ?? null,
      enabled: !!c?.enabled,
      connected,
      state: connected ? c!.state : "disconnected",
      queued: count("queued"),
      uncertain: count("uncertain") + (!connected ? count("dispatching") : 0),
      delivered: count("delivered"),
    };
  }
  connect(id: string, provider: Provider, session: string) {
    return this.store.transaction(() => {
      const c = this.connection(id);
      if (c?.enabled && Number(c.heartbeat) > this.now() - leaseMs)
        throw new HttpError(
          409,
          "An agent is already connected to this artifact. Disconnect it first.",
        );
      this.store
        .prepare(
          "UPDATE feedback_events SET status='uncertain',error='Connection ended before delivery was confirmed' WHERE artifact_id=? AND status='dispatching'",
        )
        .run(id);
      const token = randomUUID();
      this.store
        .prepare(
          "INSERT INTO feedback_connections VALUES (?,?,?,?,1,?,'connected') ON CONFLICT(artifact_id) DO UPDATE SET token=excluded.token,provider=excluded.provider,session=excluded.session,enabled=1,heartbeat=excluded.heartbeat,state='connected'",
        )
        .run(id, token, provider, session, this.now());
      return { token };
    });
  }
  private authorize(id: string, token: string) {
    const c = this.connection(id);
    if (
      !c?.enabled ||
      c.token !== token ||
      Number(c.heartbeat) <= this.now() - leaseMs
    )
      throw new HttpError(
        409,
        "Agent connection expired or was disconnected. Start a new connection.",
      );
  }
  heartbeat(id: string, token: string, state: string) {
    this.authorize(id, token);
    this.store
      .prepare(
        "UPDATE feedback_connections SET heartbeat=?,state=? WHERE artifact_id=? AND token=?",
      )
      .run(this.now(), state, id, token);
    return { ok: true };
  }
  disconnect(id: string, token?: string) {
    if (token) this.authorize(id, token);
    else this.store.get(id);
    this.store
      .prepare(
        "UPDATE feedback_connections SET enabled=0,state='disconnected' WHERE artifact_id=?",
      )
      .run(id);
    this.store
      .prepare(
        "UPDATE feedback_events SET status='uncertain',error='Disconnected during delivery' WHERE artifact_id=? AND status='dispatching'",
      )
      .run(id);
    return { ok: true };
  }
  claim(id: string, token: string): FeedbackEvent[] {
    return this.store.transaction(() => {
      this.authorize(id, token);
      if (
        this.store
          .prepare(
            "SELECT id FROM feedback_events WHERE artifact_id=? AND status='dispatching'",
          )
          .get(id)
      )
        return [];
      const rows = this.store
        .prepare(
          "SELECT id,comment_id,kind FROM feedback_events WHERE artifact_id=? AND status='queued' ORDER BY id LIMIT 50",
        )
        .all(id);
      const claimed: FeedbackEvent[] = [];
      for (const row of rows) {
        const c = this.store.comment(id, String(row.comment_id));
        // Feedback already resolved manually must not trigger an agent later.
        const status = ["resolved", "addressed"].includes(c.status)
          ? "cancelled"
          : "dispatching";
        this.store
          .prepare("UPDATE feedback_events SET status=?,token=? WHERE id=?")
          .run(status, token, row.id);
        if (status === "dispatching")
          claimed.push({
            id: Number(row.id),
            commentId: String(row.comment_id),
            kind: String(row.kind),
          });
      }
      return claimed;
    });
  }
  finish(id: string, token: string, ids: number[], error?: string) {
    return this.store.transaction(() => {
      this.authorize(id, token);
      for (const eventId of ids)
        this.store
          .prepare(
            "UPDATE feedback_events SET status=?,error=? WHERE id=? AND artifact_id=? AND token=? AND status='dispatching'",
          )
          .run(
            error ? "uncertain" : "delivered",
            error?.slice(0, 1000) ?? null,
            eventId,
            id,
            token,
          );
      // Retain bounded recent terminal detail; counters retain lifetime totals.
      for (const status of ["delivered", "cancelled"])
        this.store
          .prepare(
            `DELETE FROM feedback_events WHERE id IN (
          SELECT id FROM feedback_events WHERE artifact_id=? AND status=? AND id < (
            SELECT id FROM feedback_events WHERE artifact_id=? AND status=? ORDER BY id DESC LIMIT 1 OFFSET 499
          ) LIMIT 100)`,
          )
          .run(id, status, id, status);
      return { ok: true };
    });
  }
  retry(id: string) {
    const c = this.connection(id);
    if (
      c?.enabled &&
      Number(c.heartbeat) > this.now() - leaseMs &&
      c.state !== "connected"
    )
      throw new HttpError(
        409,
        "Wait for the current agent turn or disconnect before retrying.",
      );
    if (!c?.enabled || Number(c.heartbeat) <= this.now() - leaseMs)
      this.store
        .prepare(
          "UPDATE feedback_events SET status='uncertain' WHERE artifact_id=? AND status='dispatching'",
        )
        .run(id);
    this.store
      .prepare(
        "UPDATE feedback_events SET status='queued',token=NULL,error=NULL WHERE artifact_id=? AND status='uncertain'",
      )
      .run(id);
    return { ok: true };
  }
}
