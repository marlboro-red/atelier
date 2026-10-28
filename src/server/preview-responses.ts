/** Bounded cache of serialized/encoded previews, keyed by validated state and encoding. */
export class PreviewResponses {
  private entries = new Map<string, Buffer>();
  private pending = new Map<string, Promise<Buffer>>();
  private bytes = 0;
  private closed = false;
  constructor(private budget = 32 * 1024 * 1024) {}
  async get(key: string, create: () => Promise<Buffer>): Promise<Buffer> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const job = Promise.resolve()
      .then(create)
      .then((value) => {
        if (!this.closed && value.length <= this.budget / 2) {
          this.entries.set(key, value);
          this.bytes += value.length;
          while (this.bytes > this.budget) {
            const oldest = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(oldest)!.length;
            this.entries.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }
  close() {
    this.closed = true;
    this.entries.clear();
    this.bytes = 0;
  }
}
