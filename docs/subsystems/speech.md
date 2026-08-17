# Speech

English | [中文](speech.zh.md)

The speech capability seam — one `ctx.speech` service spanning STT (speech-to-text) and TTS (text-to-speech), split across packages: Service Definition ([dsh-speech](../../packages/speech/speech), `ctx.speech` + the provider registries), Service Providers ([dsh-speech-deepgram-flux-stt](../../packages/speech/speech-deepgram-flux-stt), [dsh-speech-deepgram-flux-tts](../../packages/speech/speech-deepgram-flux-tts)), and Consumer ([dsh-speech-agent](../../packages/speech/speech-agent), the `TurnController` orchestration). Unlike `ctx.web`, session-opening calls never auto-select or resolve ambiguity: every `SttOpenOptions.provider`/`TtsOpenOptions.provider` is mandatory, and `openStt()`/`openTts()` dispatch to exactly that registered provider or throw `SPEECH_PROVIDER_NOT_REGISTERED`.

Source: [`packages/speech/speech/src/types.ts`](../../packages/speech/speech/src/types.ts)

## Why STT and TTS share one seam

STT and TTS have unrelated request/event vocabularies and no shared business logic, but a voice conversation always needs both, so `ctx.speech` is one provider-id registry pair (STT and TTS ids share no namespace) with one `SpeechError` taxonomy and one seam-level configuration surface. `dsh-speech-agent`'s `TurnController` is the sole reason the two operations need to interoperate at all — it is the only package that opens one of each and correlates their events.

## Opening a session

```ts type-equiv
/** Options accepted when opening a speech-to-text session. */
interface SttOpenOptions {
  /** Provider id registered via {@link SpeechRuntime.registerSttProvider}. */
  readonly provider: string
  /** Provider-specific model or language selector (for example a Deepgram model id). */
  readonly model?: string
  /** Raw audio format; omit when the caller streams containerized audio the provider can demux. */
  readonly audio?: AudioFormat
  /** Initial keyterm list; see {@link SttConfigureRequest.keyterms}. */
  readonly keyterms?: readonly string[]
  /** Initial language hints; see {@link SttConfigureRequest.languageHints}. */
  readonly languageHints?: readonly string[]
  /** Initial turn-detection thresholds. */
  readonly endOfTurn?: {
    readonly confidence?: number
    readonly eagerConfidence?: number
    readonly timeoutMs?: number
  }
  /** Request-tracking tags opaque to the caller. */
  readonly tags?: readonly string[]
  /** Aborts the connection attempt; has no effect once the session is open. */
  readonly signal?: AbortSignal
}
```

```ts type-equiv
/** Options accepted when opening a text-to-speech session. */
interface TtsOpenOptions {
  /** Provider id registered via {@link SpeechRuntime.registerTtsProvider}. */
  readonly provider: string
  /** Provider-specific voice/model selector. */
  readonly voice?: string
  /** Raw output audio format. */
  readonly audio?: AudioFormat
  /** Initial speech-rate multiplier. */
  readonly speed?: number
  /** Initial delivery-register dial, calm-to-animated. */
  readonly expressivity?: number
  /** Request-tracking tags opaque to the caller. */
  readonly tags?: readonly string[]
  /** Aborts the connection attempt; has no effect once the session is open. */
  readonly signal?: AbortSignal
}
```

## Sessions and provider adapters

An `SttSession`/`TtsSession` is a live duplex stream: `events` is a single-consumer `AsyncIterable` a caller drains with one `for await` loop for the session's whole life, while `sendAudio()`/`speak()`/`flush()`/`interrupt()`/`configure()`/`close()` push the other direction. `SttProvider`/`TtsProvider` are the provider-wire adapters `dsh-speech-deepgram-flux-stt`/`dsh-speech-deepgram-flux-tts` implement and register with `ctx.speech.registerSttProvider(id, provider)`/`registerTtsProvider(id, provider)`.

```ts type-equiv
/**
 * An open, provider-neutral speech-to-text session. `events` is a
 * single-consumer stream: drive it with one `for await` loop for the life of
 * the session.
 */
interface SttSession {
  /** Ends when the transport closes; the final event is always `closed`, or the iterable rejects on an unrecoverable transport failure. */
  readonly events: AsyncIterable<SttEvent>

  /**
   * Enqueue one chunk of raw audio for recognition. Fire-and-forget: the
   * transport owns backpressure. Throws {@link SpeechError} (`SESSION_CLOSED`)
   * once `close()` has been called or `closed` has been observed.
   * @param chunk - raw audio bytes matching the session's negotiated {@link AudioFormat}.
   */
  sendAudio(chunk: Uint8Array): void

  /**
   * Apply a mid-session configuration update; the provider replies with a
   * `configure-ack` event.
   * @param request - fields to change; omitted fields keep their current value.
   */
  configure(request: SttConfigureRequest): void

  /**
   * Request a graceful shutdown: the provider finishes any in-flight turn and
   * emits a final `closed` event before the transport disconnects.
   * @returns settles once the transport has closed.
   */
  close(): Promise<void>
}
```

```ts type-equiv
/** Provider-wire adapter for {@link SttSession}. Register with `ctx.speech.registerSttProvider(id, provider)`. */
interface SttProvider {
  /**
   * Open one session.
   * @param options - session parameters; `options.provider` is this adapter's registered id.
   * @returns the open session once the transport confirms readiness.
   */
  connect(options: SttOpenOptions): Promise<SttSession>
}
```

```ts type-equiv
/**
 * An open, provider-neutral text-to-speech session. `events` is a
 * single-consumer stream: drive it with one `for await` loop for the life of
 * the session. A session is a sequence of turns: `speak()` streams text into
 * the active turn and `flush()` closes it; `interrupt()` cancels the active
 * turn on caller-detected barge-in.
 */
interface TtsSession {
  /** Ends when the transport closes; the final event is always `closed`, or the iterable rejects on an unrecoverable transport failure. */
  readonly events: AsyncIterable<TtsEvent>

  /**
   * Stream text into the active turn (starting one if none is active). Send
   * plain text; whitespace between separate calls is the caller's
   * responsibility. Throws {@link SpeechError} (`SESSION_CLOSED`) once closed.
   * @param text - text to synthesize, appended verbatim to the active turn.
   */
  speak(text: string): void

  /** End the active turn: the provider generates its remaining audio and reports completion. A call with no active turn is a no-op. */
  flush(): void

  /**
   * Cancel the active turn because the caller detected barge-in. Stop local
   * playback before calling this — the round trip is for context
   * reconciliation, not for stopping audio — and discard any `audio` events
   * that arrive before the resulting `turn-interrupted` event.
   * @param playbackOffsetMs - milliseconds of session audio the listener had
   *   actually heard when the barge-in was detected, measured from the start
   *   of the session. Required to receive `textSpoken`/`textRemaining` on the
   *   reply; each call's offset must exceed the previous interrupt's.
   */
  interrupt(playbackOffsetMs?: number): void

  /**
   * Apply a mid-session configuration update; the provider replies with a
   * `configure-ack` event.
   * @param request - fields to change; omitted fields keep their current value.
   */
  configure(request: TtsConfigureRequest): void

  /**
   * Request a graceful shutdown: the provider drains all queued audio and
   * emits a final `session-completed` then `closed` event before the
   * transport disconnects.
   * @returns settles once the transport has closed.
   */
  close(): Promise<void>
}
```

```ts type-equiv
/** Provider-wire adapter for {@link TtsSession}. Register with `ctx.speech.registerTtsProvider(id, provider)`. */
interface TtsProvider {
  /**
   * Open one session.
   * @param options - session parameters; `options.provider` is this adapter's registered id.
   * @returns the open session once the transport confirms readiness.
   */
  connect(options: TtsOpenOptions): Promise<TtsSession>
}
```

## Turn-taking events

`SttEvent`'s `turn` variant carries a `kind` — `progress`, `started`, `eager-completed`, `resumed`, `completed` — modeling a provider's native turn-detection state machine (Deepgram Flux's `TurnInfo.event`). `TtsEvent`'s `turn-started`/`audio`/`turn-completed`/`turn-interrupted` model one synthesis turn from start to its natural or barge-in-cancelled end. See [`dsh-speech-deepgram-flux-stt`](../../packages/speech/speech-deepgram-flux-stt/README.md) and [`dsh-speech-deepgram-flux-tts`](../../packages/speech/speech-deepgram-flux-tts/README.md) for the exact wire-message mapping, and [`dsh-speech-agent`](../../packages/speech/speech-agent/README.md) for how `TurnController` correlates both streams into one barge-in-aware conversation.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspeech--speechruntime"></a>

### `ctx.speech` — `SpeechRuntime`

The speech capability service (`ctx.speech`). Holds two independent provider-id registries — STT and TTS share no namespace — and dispatches `openStt()`/`openTts()` straight to the id named in the request.

```ts cordis-catalog
/**
 * Register an STT provider under `id`. Throws {@link SpeechError}
 * `SPEECH_DUPLICATE_PROVIDER` if `id` is already registered for STT.
 * @param id - stable id; callers pass this as {@link SttOpenOptions.provider}.
 * @param provider - the provider adapter.
 * @returns disposer that removes the registration immediately when called; also disposed with the calling fiber.
 */
registerSttProvider(id: string, provider: SttProvider): () => void

/**
 * Register a TTS provider under `id`. Throws {@link SpeechError}
 * `SPEECH_DUPLICATE_PROVIDER` if `id` is already registered for TTS.
 * @param id - stable id; callers pass this as {@link TtsOpenOptions.provider}.
 * @param provider - the provider adapter.
 * @returns disposer that removes the registration immediately when called; also disposed with the calling fiber.
 */
registerTtsProvider(id: string, provider: TtsProvider): () => void

/**
 * List registered STT provider ids in registration order.
 * @returns snapshot of registered STT provider ids.
 */
listSttProviders(): string[]

/**
 * List registered TTS provider ids in registration order.
 * @returns snapshot of registered TTS provider ids.
 */
listTtsProviders(): string[]

/**
 * Open an STT session on the provider named by `options.provider`.
 * @param options - session parameters; `options.provider` selects the registered adapter.
 * @returns the open session once the transport confirms readiness.
 */
async openStt(options: SttOpenOptions): Promise<SttSession>

/**
 * Open a TTS session on the provider named by `options.provider`.
 * @param options - session parameters; `options.provider` selects the registered adapter.
 * @returns the open session once the transport confirms readiness.
 */
async openTts(options: TtsOpenOptions): Promise<TtsSession>
```

Source: [`packages/speech/speech/src/index.ts:36`](../../packages/speech/speech/src/index.ts)
<!-- END GENERATED cordis-surface -->

## Model Experience

None of these types reach a model request directly; a consumer such as `dsh-speech-agent` turns a completed transcript into a `user/message` and owns any model-visible surface from there.
