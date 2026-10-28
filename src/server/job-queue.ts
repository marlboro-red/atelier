import { HttpError } from "./store.js";

/** Bounded FIFO within priority, with an upper bound on time spent waiting. */
export class JobQueue {
  private active = 0;
  private closed = false;
  private sequence = 0;
  private pending = new Map<string, Promise<unknown>>();
  private queue: {
    priority: number;
    sequence: number;
    start: () => void;
    cancel: () => void;
  }[] = [];
  constructor(
    private concurrency = 2,
    private capacity = 32,
    private waitMs = 30000,
  ) {}
  run<T>(key: string, task: () => Promise<T>, priority = 0): Promise<T> {
    if (this.closed)
      return Promise.reject(new HttpError(503, "Job queue is closed"));
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    if (this.active >= this.concurrency && this.queue.length >= this.capacity)
      return Promise.reject(
        new HttpError(503, "Job queue is full. Try again shortly."),
      );
    const result = new Promise<T>((resolve, reject) => {
      const entry = {
        priority,
        sequence: this.sequence++,
        cancel: () => {
          clearTimeout(timer);
          reject(new HttpError(503, "Job queue is closed"));
        },
        start: () => {
          clearTimeout(timer);
          this.active++;
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.queue.sort(
                (a, b) => b.priority - a.priority || a.sequence - b.sequence,
              );
              this.queue.shift()?.start();
            });
        },
      };
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((item) => item !== entry);
        reject(new HttpError(503, "Job queue wait exceeded its time limit"));
      }, this.waitMs);
      if (this.active < this.concurrency) entry.start();
      else this.queue.push(entry);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }
  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) entry.cancel();
  }
}
export const browserJobs = new JobQueue();
