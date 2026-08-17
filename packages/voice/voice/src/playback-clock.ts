/**
 * Session-wide playback-position tracking for TTS barge-in. Deepgram Flux's
 * `Interrupt.playback_offset` (and the wire-neutral {@link TtsSession.interrupt}
 * it backs) is a single monotonic clock for the whole session, not a
 * per-turn counter: a caller who tracks how many milliseconds of audio its
 * sink has actually rendered reports that progress here, and reads back the
 * exact value to hand to `interrupt()` at the moment it detects barge-in.
 * @module @deepseek-ai/dsh-voice/playback-clock
 */

import { VoiceError } from './error.ts'

/**
 * A monotonic, session-wide "milliseconds of audio actually heard" counter.
 * Not thread-shared: one instance per open TTS session, owned by whichever
 * component drives the real audio sink (a device, a file writer, or a test
 * double advancing time deterministically).
 */
export class PlaybackClock {
  private playedMs = 0

  /**
   * Advance the clock by audio the sink has now rendered. Called from the
   * playback path as frames are actually written to the output device — not
   * when they are merely received over the wire, so buffered-but-unplayed
   * audio is never counted.
   * @param ms - non-negative milliseconds of newly rendered audio.
   * @throws {@link VoiceError} (`INVALID_PLAYBACK_PROGRESS`) if `ms` is negative or non-finite.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new VoiceError(`playback progress must be a non-negative finite number, got ${ms}`, 'INVALID_PLAYBACK_PROGRESS')
    }
    this.playedMs += ms
  }

  /** The session-wide total of rendered audio in milliseconds, suitable for {@link TtsSession.interrupt}. */
  get elapsedMs(): number {
    return this.playedMs
  }
}
