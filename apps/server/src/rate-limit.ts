export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** Prune stale keys once the map grows past this size (bounds memory). */
  readonly maxKeys?: number;
}

/** In-memory sliding-window limiter keyed by client IP. Single-process only. */
export class SlidingWindowRateLimiter {
  private hits = new Map<string, readonly number[]>();

  constructor(
    private readonly options: RateLimiterOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  tryConsume(key: string): boolean {
    const timestamp = this.now();
    const windowStart = timestamp - this.options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((hit) => hit > windowStart);
    if (recent.length >= this.options.limit) {
      this.hits.set(key, recent);
      return false;
    }
    this.hits.set(key, [...recent, timestamp]);
    if (this.hits.size > (this.options.maxKeys ?? 10_000)) this.prune(windowStart);
    return true;
  }

  get trackedKeys(): number {
    return this.hits.size;
  }

  private prune(windowStart: number): void {
    this.hits = new Map([...this.hits].filter(([, hits]) => hits.some((hit) => hit > windowStart)));
  }
}
