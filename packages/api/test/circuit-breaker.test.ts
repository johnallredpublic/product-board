import { describe, it, expect } from 'vitest'
import { CircuitBreaker } from '../src/lib/circuit-breaker.js'

// Pure unit test with an injected clock — no real waiting.

const boom = () => Promise.reject(new Error('boom'))

describe('circuit breaker', () => {
  it('opens after the failure threshold and then fails fast', async () => {
    let t = 0
    const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => t })

    for (let i = 0; i < 3; i++) await expect(cb.run(boom)).rejects.toThrow('boom')

    // Open now: fails fast WITHOUT invoking fn.
    let called = false
    await expect(cb.run(async () => { called = true; return 1 })).rejects.toThrow('circuit open')
    expect(called).toBe(false)
    expect(cb.isOpen).toBe(true)
  })

  it('closes after the cooldown and resets on success', async () => {
    let t = 0
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => t })

    await expect(cb.run(boom)).rejects.toThrow('boom')
    await expect(cb.run(boom)).rejects.toThrow('boom') // opens
    expect(cb.isOpen).toBe(true)

    t = 1001 // advance past cooldown
    expect(cb.isOpen).toBe(false)

    const result = await cb.run(async () => 42) // allowed again, succeeds -> resets
    expect(result).toBe(42)
    expect(cb.isOpen).toBe(false)
  })
})
