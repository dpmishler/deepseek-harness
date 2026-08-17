import { describe, expect, it } from 'vitest'
import { VoiceError } from '../src/error.ts'

describe('VoiceError', () => {
  it('carries message, code, and name', () => {
    const error = new VoiceError('boom', 'SOME_CODE')
    expect(error.message).toBe('boom')
    expect(error.code).toBe('SOME_CODE')
    expect(error.name).toBe('VoiceError')
    expect(error).toBeInstanceOf(Error)
  })

  it('chains a cause', () => {
    const cause = new Error('root cause')
    const error = new VoiceError('boom', 'SOME_CODE', { cause })
    expect(error.cause).toBe(cause)
  })

  it('rejects an empty message', () => {
    expect(() => new VoiceError('', 'SOME_CODE')).toThrow('VoiceError message must be a non-empty string')
  })

  it('rejects an empty code', () => {
    expect(() => new VoiceError('boom', '')).toThrow('VoiceError code must be a non-empty string')
  })
})
