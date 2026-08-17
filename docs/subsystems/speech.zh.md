# 语音

[English](speech.md) | 中文

speech 能力 seam——一个 `ctx.speech` 服务，横跨 STT（speech-to-text，语音转文本）与 TTS（text-to-speech，文本转语音），拆分到多个包中：Service Definition（[dsh-speech](../../packages/speech/speech)，`ctx.speech` 加上提供方注册表）、Service Provider（[dsh-speech-deepgram-flux-stt](../../packages/speech/speech-deepgram-flux-stt)、[dsh-speech-deepgram-flux-tts](../../packages/speech/speech-deepgram-flux-tts)），以及 Consumer（[dsh-speech-agent](../../packages/speech/speech-agent)，`TurnController` 编排）。不同于 `ctx.web`，打开会话的调用从不自动选择或解析歧义：每一个 `SttOpenOptions.provider`/`TtsOpenOptions.provider` 都是必填项，`openStt()`/`openTts()` 只会分发给那个确切注册的提供方，否则抛出 `SPEECH_PROVIDER_NOT_REGISTERED`。

来源：[`packages/speech/speech/src/types.ts`](../../packages/speech/speech/src/types.ts)

## 为什么 STT 与 TTS 共享一个 seam

STT 与 TTS 拥有互不相关的请求/事件词汇表，也没有共享的业务逻辑，但一次语音对话总是需要两者，因此 `ctx.speech` 是一对提供方 id 注册表（STT 与 TTS 的 id 不共享命名空间），拥有一套 `SpeechError` 分类体系和一套 seam 级配置表面。`dsh-speech-agent` 的 `TurnController` 是这两个操作需要互相协作的唯一理由——它是唯一同时打开二者各一个会话、并关联它们事件的包。

## 打开一个会话

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

## 会话与提供方适配器

`SttSession`/`TtsSession` 是一个存活中的双工流：`events` 是一个单消费者的 `AsyncIterable`，调用方用一个 `for await` 循环在整个会话生命周期内消费它，而 `sendAudio()`/`speak()`/`flush()`/`interrupt()`/`configure()`/`close()` 则朝相反方向推送。`SttProvider`/`TtsProvider` 是 `dsh-speech-deepgram-flux-stt`/`dsh-speech-deepgram-flux-tts` 实现并通过 `ctx.speech.registerSttProvider(id, provider)`/`registerTtsProvider(id, provider)` 注册的提供方线上适配器。

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

## 轮次交互事件

`SttEvent` 的 `turn` 变体携带一个 `kind`——`progress`、`started`、`eager-completed`、`resumed`、`completed`——建模一个提供方原生的轮次检测状态机（Deepgram Flux 的 `TurnInfo.event`）。`TtsEvent` 的 `turn-started`/`audio`/`turn-completed`/`turn-interrupted` 建模一次合成轮次从开始到其自然结束或被打断取消结束的全过程。精确的线上消息映射见 [`dsh-speech-deepgram-flux-stt`](../../packages/speech/speech-deepgram-flux-stt/README.md) 和 [`dsh-speech-deepgram-flux-tts`](../../packages/speech/speech-deepgram-flux-tts/README.md)；`TurnController` 如何把两路事件流关联成一次支持打断的对话，见 [`dsh-speech-agent`](../../packages/speech/speech-agent/README.md)。

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

## 模型体验

这些类型都不会直接触及一次模型请求；像 `dsh-speech-agent` 这样的消费方把一段完成的文本记录变成一条 `user/message`，并从那里开始拥有任何面向模型的表面。
