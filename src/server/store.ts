import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Artifact,
  Revision,
  RevisionMetadata,
  Comment,
  Content,
  Anchor,
} from "../shared/schema.js";
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export class Store {
  db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "atelier.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS revisions (artifact_id TEXT NOT NULL REFERENCES artifacts(id), number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(artifact_id,number));
 CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS comments_artifact ON comments(artifact_id);
 CREATE TABLE IF NOT EXISTS thumbnails (artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id), revision INTEGER NOT NULL, version TEXT NOT NULL, image BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS app_data (artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id), data TEXT NOT NULL);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(app_data)")
        .all()
        .some((column) => column.name === "version")
    )
      this.db.exec(
        "ALTER TABLE app_data ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
      );
    if (
      !this.db
        .prepare("PRAGMA table_xinfo(artifacts)")
        .all()
        .some((column) => column.name === "updated_at")
    ) {
      this.db.exec(
        "ALTER TABLE artifacts ADD COLUMN updated_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.updatedAt')) VIRTUAL",
      );
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS artifacts_updated ON artifacts(updated_at DESC,id DESC)",
    );
    // Migrate once, rather than parsing source blobs during every history read.
    if (
      !this.prepare(
        "SELECT name FROM sqlite_master WHERE name='revision_metadata'",
      ).get()
    ) {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE revision_metadata (
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(artifact_id,number));
          INSERT INTO revision_metadata SELECT artifact_id,number,
            json_set(json_remove(data,'$.content'),'$.kind',json_extract(data,'$.content.kind')) FROM revisions;`);
      });
    }
  }
  list(
    options: { limit?: number; cursor?: string; search?: string } = {},
  ): Artifact[] {
    const limit = Math.max(1, Math.min(200, options.limit ?? 200));
    const split = options.cursor?.lastIndexOf("|") ?? -1;
    if (options.cursor && split < 1)
      throw new HttpError(400, "Invalid library cursor");
    const date = options.cursor?.slice(0, split) ?? "9999";
    const id = options.cursor?.slice(split + 1) ?? "~";
    const search = (options.search ?? "").toLowerCase();
    return this.prepare(
      `SELECT artifacts.data, thumbnails.revision AS thumbnail_revision, thumbnails.version AS thumbnail_version
      FROM artifacts LEFT JOIN thumbnails ON thumbnails.artifact_id=artifacts.id
      WHERE (artifacts.updated_at,artifacts.id)<(?,?)
      AND (?='' OR instr(lower(json_extract(artifacts.data,'$.title') || ' ' || json_extract(artifacts.data,'$.description')),?)>0)
      ORDER BY artifacts.updated_at DESC,artifacts.id DESC LIMIT ?`,
    )
      .all(date, id, search, search, limit)
      .map((row) => {
        const artifact = JSON.parse(row.data as string);
        if (row.thumbnail_revision === artifact.head)
          artifact.thumbnailVersion = row.thumbnail_version;
        return artifact;
      });
  }
  get(id: string): Artifact {
    const r = this.prepare("SELECT data FROM artifacts WHERE id=?").get(id);
    if (!r) throw new HttpError(404, "Artifact not found");
    return JSON.parse(r.data as string);
  }
  revisions(
    id: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 200,
  ): RevisionMetadata[] {
    this.get(id);
    return this.prepare(
      "SELECT data FROM revision_metadata WHERE artifact_id=? AND number<? ORDER BY number DESC LIMIT ?",
    )
      .all(id, before, limit)
      .map((r) => JSON.parse(r.data as string));
  }
  revision(id: string, n?: number): Revision {
    const a = this.get(id);
    const r = this.prepare(
      "SELECT data FROM revisions WHERE artifact_id=? AND number=?",
    ).get(id, n ?? a.head);
    if (!r) throw new HttpError(404, "Revision not found");
    return JSON.parse(r.data as string);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  create(input: {
    title: string;
    description: string;
    author: string;
    summary: string;
    content: Content;
  }): Artifact {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const a: Artifact = {
        id: randomUUID(),
        title: input.title,
        description: input.description,
        kind: input.content.kind,
        head: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.prepare("INSERT INTO artifacts(id,data) VALUES (?,?)").run(
        a.id,
        JSON.stringify(a),
      );
      this.insertRevision({
        artifactId: a.id,
        number: 1,
        author: input.author,
        summary: input.summary,
        content: input.content,
        createdAt: now,
        commentIds: [],
      });
      return a;
    });
  }
  rename(id: string, title: string): Artifact {
    const name = title.trim();
    if (!name || name.length > 160)
      throw new HttpError(400, "Use a name between 1 and 160 characters");
    const artifact = this.get(id);
    artifact.title = name;
    artifact.updatedAt = new Date().toISOString();
    this.prepare("UPDATE artifacts SET data=? WHERE id=?").run(
      JSON.stringify(artifact),
      id,
    );
    return artifact;
  }
  remove(id: string, baseRevision: number) {
    this.transaction(() => {
      const artifact = this.get(id);
      if (artifact.head !== baseRevision)
        throw new HttpError(
          409,
          "The artifact has a newer revision. Reopen Delete to review the current artifact.",
        );
      this.prepare("DELETE FROM comments WHERE artifact_id=?").run(id);
      this.prepare("DELETE FROM app_data WHERE artifact_id=?").run(id);
      this.prepare("DELETE FROM thumbnails WHERE artifact_id=?").run(id);
      this.prepare("DELETE FROM revisions WHERE artifact_id=?").run(id);
      this.prepare("DELETE FROM artifacts WHERE id=?").run(id);
    });
  }
  private insertRevision(r: Revision) {
    const { content, ...metadata } = r;
    this.prepare("INSERT INTO revision_metadata VALUES (?,?,?)").run(
      r.artifactId,
      r.number,
      JSON.stringify({ ...metadata, kind: content.kind }),
    );
    this.prepare("INSERT INTO revisions VALUES (?,?,?)").run(
      r.artifactId,
      r.number,
      JSON.stringify(r),
    );
  }
  update(
    id: string,
    input: {
      baseRevision: number;
      author: string;
      summary: string;
      content: Content;
      commentIds: string[];
    },
  ): Revision {
    return this.transaction(() => {
      const a = this.get(id);
      if (a.head !== input.baseRevision)
        throw new HttpError(
          409,
          `Revision conflict: latest is ${a.head}; you started from ${input.baseRevision}`,
        );
      for (const cid of new Set(input.commentIds)) {
        const c = this.comment(id, cid);
        if (c.status !== "resolved") {
          c.status = "addressed";
          this.saveComment(c);
        }
      }
      const now = new Date().toISOString();
      const r: Revision = {
        artifactId: id,
        number: a.head + 1,
        createdAt: now,
        author: input.author,
        summary: input.summary,
        content: input.content,
        commentIds: input.commentIds,
      };
      this.insertRevision(r);
      a.head = r.number;
      a.kind = r.content.kind;
      a.updatedAt = now;
      this.prepare("UPDATE artifacts SET data=? WHERE id=?").run(
        JSON.stringify(a),
        id,
      );
      return r;
    });
  }
  comments(id: string): Comment[] {
    this.get(id);
    return this.prepare("SELECT data FROM comments WHERE artifact_id=?")
      .all(id)
      .map((r) => JSON.parse(r.data as string));
  }
  comment(id: string, cid: string): Comment {
    const row = this.prepare(
      "SELECT data FROM comments WHERE id=? AND artifact_id=?",
    ).get(cid, id);
    if (!row) throw new HttpError(404, "Comment not found");
    return JSON.parse(row.data as string);
  }
  addComment(
    id: string,
    input: {
      revision: number;
      body: string;
      author: string;
      anchor: Anchor | null;
    },
  ): Comment {
    this.revision(id, input.revision);
    const c: Comment = {
      ...input,
      id: randomUUID(),
      artifactId: id,
      status: "open",
      createdAt: new Date().toISOString(),
      replies: [],
    };
    this.saveComment(c);
    return c;
  }
  saveComment(c: Comment) {
    this.prepare(
      "INSERT INTO comments VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(c.id, c.artifactId, JSON.stringify(c));
  }
  dataRecord(id: string): { data: unknown; dataVersion: number } {
    this.get(id);
    const row = this.prepare(
      "SELECT data,version FROM app_data WHERE artifact_id=?",
    ).get(id);
    return {
      data: row ? JSON.parse(row.data as string) : null,
      dataVersion: Number(row?.version ?? 0),
    };
  }
  data(id: string): unknown {
    return this.dataRecord(id).data;
  }
  setData(id: string, data: unknown, baseVersion?: number) {
    return this.transaction(() => {
      this.get(id);
      const row = this.prepare(
        "SELECT version FROM app_data WHERE artifact_id=?",
      ).get(id);
      const current = Number(row?.version ?? 0);
      if (baseVersion !== undefined && baseVersion !== current)
        throw new HttpError(
          409,
          "Saved data changed in another viewer. Reload before saving again.",
        );
      const version = current + 1;
      this.prepare(
        "INSERT INTO app_data(artifact_id,data,version) VALUES (?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET data=excluded.data,version=excluded.version",
      ).run(id, JSON.stringify(data), version);
      return { dataVersion: version };
    });
  }
  saveThumbnail(id: string, revision: number, image: Uint8Array): boolean {
    const row = this.prepare("SELECT data FROM artifacts WHERE id=?").get(id);
    // A slower check must not replace a newer revision's preview, or recreate
    // a preview for an artifact deleted while the browser was running.
    if (!row || JSON.parse(row.data as string).head !== revision) return false;
    this.prepare(
      "INSERT INTO thumbnails VALUES (?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET revision=excluded.revision, version=excluded.version, image=excluded.image",
    ).run(id, revision, `${revision}-${randomUUID()}`, image);
    return true;
  }
  thumbnail(id: string): Uint8Array {
    const artifact = this.get(id);
    const row = this.prepare(
      "SELECT revision,image FROM thumbnails WHERE artifact_id=?",
    ).get(id);
    if (!row || row.revision !== artifact.head)
      throw new HttpError(404, "No preview for the current revision");
    return row.image as Uint8Array;
  }
  close() {
    this.statements.clear();
    this.db.close();
  }
}
