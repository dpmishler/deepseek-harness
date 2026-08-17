/**
 * Session-wide playback-position tracking for TTS barge-in. Deepgram Flux's
 * `Interrupt.playback_offset` (and the wire-neutral {@link TtsSession.interrupt}
 * it backs, from `@deepseek-ai/dsh-speech`) is a single monotonic clock for
 * the whole session, not a per-turn counter: a caller who tracks how many
 * milliseconds of audio its sink has actually rendered reports that progress
 * here, and reads back the exact value to hand to `interrupt()` at the
 * moment it detects barge-in.
 * @module @deepseek-ai/dsh-speech-agent/playback-clock
 */

import { SpeechError } from '@deepseek-ai/dsh-speech'

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
   * @param ms - non-negative finite milliseconds of newly rendered audio.
   * @throws {@link SpeechError} (`SPEECH_AGENT_INVALID_PLAYBACK_PROGRESS`) if `ms` is negative or non-finite.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new SpeechError(
        `playback progress must be a non-negative finite number, got ${ms}`,
        'SPEECH_AGENT_INVALID_PLAYBACK_PROGRESS',
      )
    }
    this.playedMs += ms
  }

  /** The session-wide total of rendered audio in milliseconds, suitable for `TtsSession.interrupt()`. */
  get elapsedMs(): number {
    return this.playedMs
  }
}
