import { describe, it, expect } from 'vitest'
import { runWithCorrelation, getCorrelationId, newCorrelationId } from '../src/obs/correlation.js'
import { withCorrelationId } from '../src/obs/observability.js'

// Pure unit test — no AWS.

describe('correlation', () => {
  it('exposes the id within a scope and nothing outside it', () => {
    expect(getCorrelationId()).toBeUndefined()
    const inside = runWithCorrelation('t1', () => getCorrelationId())
    expect(inside).toBe('t1')
    expect(getCorrelationId()).toBeUndefined()
  })

  it('restores the parent id after a nested scope', () => {
    runWithCorrelation('outer', () => {
      expect(getCorrelationId()).toBe('outer')
      runWithCorrelation('inner', () => expect(getCorrelationId()).toBe('inner'))
      expect(getCorrelationId()).toBe('outer')
    })
  })

  it('enriches an outgoing payload with the current id (survives the hop)', () => {
    const enriched = runWithCorrelation('trace-9', () => withCorrelationId({ a: 1 }))
    expect(enriched).toEqual({ a: 1, correlationId: 'trace-9' })
  })

  it('leaves the payload unchanged when there is no context', () => {
    expect(withCorrelationId({ a: 1 })).toEqual({ a: 1 })
  })

  it('generates unique ids', () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId())
  })
})
