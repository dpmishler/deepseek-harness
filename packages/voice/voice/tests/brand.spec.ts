import { describe, expect, it } from 'vitest'
import { SpeechRequestId, SpeechTurnId } from '../src/brand.ts'

describe('brand', () => {
  it('brands strings as SpeechRequestId and SpeechTurnId', () => {
    expect(SpeechRequestId('req-1')).toBe('req-1')
    expect(SpeechTurnId('dg_sp_abc')).toBe('dg_sp_abc')
  })
})
