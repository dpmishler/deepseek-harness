/**
 * Session-wide playback-position tracking for TTS barge-in. Deepgram Flux's
 * `Interrupt.playback_offset` (and the wire-neutral {@link TtsSession.interrupt}
 * it backs) is a single monotonic clock for the whole session, not a
 * per-turn counter: a caller that tracks how many milliseconds of audio its
 * sink has actually rendered reports that progress here, and reads back the
 * exact value to hand to `interrupt()` at the moment it detects barge-in.
 * @module @deepseek-ai/dsh-speech-agent/playback-clock
 */

import { SpeechAgentError } from './error.ts'

/**
 * A monotonic, session-wide "milliseconds of audio actually heard" counter.
 * Not thread-shared: one instance per open TTS session, owned by whichever
 * component drives the real audio sink (a device, a file writer, or a test
 * double advancing time deterministically).
 */
export class PlaybackClock {
  private playedMs = 0
  private lastInterruptOffsetMs: number | undefined

  /**
   * Advance the clock by audio the sink has now rendered. Called from the
   * playback path as frames are actually written to the output device — not
   * when they are merely received over the wire, so buffered-but-unplayed
   * audio is never counted.
   * @param ms - non-negative milliseconds of newly rendered audio.
   * @throws {@link SpeechAgentError} (`INVALID_PLAYBACK_PROGRESS`) if `ms` is negative or non-finite.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new SpeechAgentError(`playback progress must be a non-negative finite number, got ${ms}`, 'INVALID_PLAYBACK_PROGRESS')
    }
    this.playedMs += ms
  }

  /** The session-wide total of rendered audio in milliseconds. */
  get elapsedMs(): number {
    return this.playedMs
  }

  /**
   * Consume the current elapsed position as the offset for the next
   * `interrupt()` call. Flux TTS requires each interrupt's `playback_offset`
   * to strictly exceed the previous one and rejects a non-advancing offset
   * with an `INVALID_INTERRUPT_OFFSET` warning (the interrupt itself is then
   * ignored as reconciliation, though the caller's own local cancellation —
   * stopping playback and aborting the LLM response — is unaffected). Two
   * barge-ins in a row with no {@link advance} between them (for example, the
   * assistant is `thinking` and no audio has played since the previous
   * interrupt) would otherwise resend the same value, so this method returns
   * `undefined` instead of a stale offset — the caller must then invoke
   * `interrupt()` with no argument, which still cancels the turn but forfeits
   * `textSpoken`/`textRemaining`.
   * @returns the offset to send, or `undefined` when it would not advance past the previous interrupt's offset.
   */
  consumeInterruptOffsetMs(): number | undefined {
    if (this.lastInterruptOffsetMs !== undefined && this.playedMs <= this.lastInterruptOffsetMs) return undefined
    this.lastInterruptOffsetMs = this.playedMs
    return this.playedMs
  }
}
