/** Process-wide across Case judges; queued cancellation never starts a request. */
export const JUDGE_REQUEST_CONCURRENCY = 4;
export class RequestLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("INVALID_REQUEST_LIMIT");
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("JUDGE_CANCELLED");
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("JUDGE_CANCELLED"));
      };
      const start = () => {
        signal?.removeEventListener("abort", cancel);
        this.active++;
        resolve();
      };
      if (this.active < this.limit) start();
      else { this.queue.push(start); signal?.addEventListener("abort", cancel, {once: true}); }
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}
export const judgeRequests = new RequestLimiter(JUDGE_REQUEST_CONCURRENCY);
