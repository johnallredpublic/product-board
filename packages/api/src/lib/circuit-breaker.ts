export interface CircuitBreakerOptions {
  threshold?: number
  cooldownMs?: number
  now?: () => number // injectable clock for testing
}

/**
 * A minimal circuit breaker. After `threshold` consecutive failures it opens for
 * `cooldownMs`, failing fast instead of hammering a downstream that's already down.
 *
 * Deliberately crude: in Lambda each execution environment has its OWN breaker, so
 * a truly effective one needs shared state (DynamoDB/Redis) and a half-open probe.
 * Naming that limitation is better than presenting the toy as complete.
 */
export class CircuitBreaker {
  private failures = 0
  private openUntil = 0
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.threshold ?? 5
    this.cooldownMs = opts.cooldownMs ?? 30_000
    this.now = opts.now ?? Date.now
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.now() < this.openUntil) throw new Error('circuit open')
    try {
      const result = await fn()
      this.failures = 0
      return result
    } catch (e) {
      if (++this.failures >= this.threshold) this.openUntil = this.now() + this.cooldownMs
      throw e
    }
  }

  get isOpen() {
    return this.now() < this.openUntil
  }
}
