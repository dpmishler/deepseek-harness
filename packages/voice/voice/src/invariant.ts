/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-voice`: the
 * `voice/transcript` stream's `turnIndex` must strictly increase within one
 * session, matching {@link SttTurnEvent}'s documented "increments after every
 * `completed`" contract — `voice/transcript` is appended exactly at that
 * transition (see `./consumer.ts`).
 * @module @deepseek-ai/dsh-voice/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-voice'

/** Cordis companion plugin name. */
export const name = 'voice-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Check one candidate event against the last known `turnIndex` for its session, without mutating `lastTurnIndex` until the caller commits it. */
function checkedTurnIndex(event: SessionEvent, lastTurnIndex: number, fail: InvariantFailure): number {
  if (event.type !== 'voice/transcript') return lastTurnIndex
  const { turnIndex } = event.data
  if (turnIndex <= lastTurnIndex) {
    fail(`session event ${event.seq} carries voice/transcript.turnIndex ${turnIndex}, which does not strictly increase past ${lastTurnIndex}`)
    return lastTurnIndex
  }
  return turnIndex
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const lastTurnIndex = new WeakMap<Session, number>()
  const staged = new WeakMap<SessionEvent, { session: Session; turnIndex: number }>()

  const seed = (session: Session): number => {
    let last = -1
    for (const event of session.events) last = checkedTurnIndex(event, last, fail)
    lastTurnIndex.set(session, last)
    return last
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const lastFor = (session: Session): number => lastTurnIndex.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const turnIndex = checkedTurnIndex(event, lastFor(session), fail)
    staged.set(event, { session, turnIndex })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching voice-transcript-fold validation')
    }
    staged.delete(event)
    lastTurnIndex.set(session, candidate.turnIndex)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the voice-transcript-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
