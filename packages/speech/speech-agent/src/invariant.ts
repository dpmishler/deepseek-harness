/**
 * Package-owned durable invariants for `@deepseek-ai/dsh-speech-agent`'s
 * `speech-agent/*` session events.
 * @module @deepseek-ai/dsh-speech-agent/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-speech-agent'

/** Cordis companion plugin name. */
export const name = 'speech-agent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Per-session state this companion tracks across the log to check
 * cross-event relationships that no single event's own fields can express.
 */
interface SessionState {
  /** The most recently seen `speech-agent/transcript.generation`; generations are session-wide and strictly increasing. */
  lastGeneration: number | undefined
  /** The most recently seen `speech-agent/turn-interrupted.audioPlayedMs`; mirrors `PlaybackClock`'s monotonic session-wide counter. */
  lastAudioPlayedMs: number | undefined
  /** The pending `speech-agent/response` text for a generation not yet resolved by a matching `turn-completed`/`turn-interrupted`. */
  responseByGeneration: Map<number, string>
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate one `speech-agent/*` event against this session's accumulated state. */
function validateEvent(state: SessionState, event: SessionEvent, fail: InvariantFailure): void {
  switch (event.type) {
    case 'speech-agent/transcript': {
      const { generation } = event.data
      // Every completed STT turn starts exactly one new response generation,
      // and `TurnController.generation` only ever increments — so across the
      // whole durable log, transcript generations are strictly increasing,
      // never repeated and never observed out of order.
      if (state.lastGeneration !== undefined && generation <= state.lastGeneration) {
        fail(`speech-agent/transcript generation ${generation} did not exceed the previous generation ${state.lastGeneration}`)
      }
      state.lastGeneration = generation
      return
    }
    case 'speech-agent/response':
      state.responseByGeneration.set(event.data.generation, event.data.text)
      return
    case 'speech-agent/turn-completed':
      // A natural completion resolves its generation: nothing further can
      // reference it, matching `TurnController`'s own single-active-response
      // discipline (a generation's TTS turn ends in exactly one outcome).
      state.responseByGeneration.delete(event.data.generation)
      return
    case 'speech-agent/turn-interrupted': {
      const { generation, audioPlayedMs, textSpoken, textRemaining } = event.data
      // PlaybackClock.elapsedMs is session-wide and monotonic, and
      // TurnController.bargeIn() only ever interrupts with its current
      // value — so durable audioPlayedMs never decreases across a session.
      if (state.lastAudioPlayedMs !== undefined && audioPlayedMs < state.lastAudioPlayedMs) {
        fail(`speech-agent/turn-interrupted audioPlayedMs ${audioPlayedMs} preceded the earlier ${state.lastAudioPlayedMs}`)
      }
      state.lastAudioPlayedMs = audioPlayedMs
      // Flux TTS's own text_spoken/text_remaining split is computed FROM the
      // exact text this session generated for the SAME generation, so when
      // both the split and this session's own generated-text record are
      // present, they must reconstruct each other verbatim — the
      // generated-vs-heard contract this package exists to keep durable.
      const generated = state.responseByGeneration.get(generation)
      if (textSpoken !== undefined && textRemaining !== undefined && generated !== undefined) {
        const heard = `${textSpoken}${textRemaining}`
        if (heard !== generated) {
          fail(
            `speech-agent/turn-interrupted generation ${generation}: textSpoken+textRemaining `
            + `(${JSON.stringify(heard)}) does not reconstruct its speech-agent/response text (${JSON.stringify(generated)})`,
          )
        }
      }
      state.responseByGeneration.delete(generation)
      return
    }
    default:
      return
  }
}

/** Install validation for loaded and newly appended `speech-agent/*` events, one state machine per session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, SessionState>()
  const stateFor = (session: Session): SessionState => {
    let state = states.get(session)
    if (state === undefined) {
      state = { lastGeneration: undefined, lastAudioPlayedMs: undefined, responseByGeneration: new Map() }
      states.set(session, state)
    }
    return state
  }
  for (const session of ctx.sessions.list()) {
    const state = stateFor(session)
    for (const event of session.events) validateEvent(state, event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(stateFor(session), event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
