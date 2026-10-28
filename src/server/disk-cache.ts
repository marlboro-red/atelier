import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  stat,
  rm,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Best-effort, atomic cache. Losing the cache must never lose user content. */
export class DiskCache {
  private writes = Promise.resolve();
  constructor(
    private directory: string,
    private budget = 128 * 1024 * 1024,
  ) {}
  async get(key: string): Promise<string | undefined> {
    try {
      const path = join(this.directory, key);
      if ((await stat(path)).size > this.budget) return;
      const value = await readFile(path, "utf8");
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return value;
    } catch {
      return;
    }
  }
  put(key: string, value: string): Promise<void> {
    if (Buffer.byteLength(value) > this.budget / 4) return Promise.resolve();
    this.writes = this.writes
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, value, { mode: 0o600 });
          await rename(temporary, join(this.directory, key));
        } finally {
          await rm(temporary, { force: true });
        }
        const entries = await Promise.all(
          (await readdir(this.directory))
            .filter((name) => /^[a-f0-9]{64}$/.test(name))
            .map(async (name) => {
              const info = await stat(join(this.directory, name)).catch(
                () => null,
              );
              return { name, size: info?.size ?? 0, time: info?.mtimeMs ?? 0 };
            }),
        );
        let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of entries.sort((a, b) => a.time - b.time)) {
          if (bytes <= this.budget) break;
          await rm(join(this.directory, entry.name), { force: true });
          bytes -= entry.size;
        }
      })
      .catch(() => {});
    return this.writes;
  }
}
