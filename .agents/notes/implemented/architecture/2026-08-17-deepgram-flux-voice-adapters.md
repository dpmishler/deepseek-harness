# Deepgram Flux STT and TTS Provider Adapters

## Status: Implemented

## Context

DeepSeek Harness needed voice capability for turn-based voice agents. The existing `ctx.voice` seam (Service Definition in `@deepseek-ai/dsh-voice`) defines `SttProvider`, `TtsProvider`, `SttSession`, and `TtsSession` interfaces, plus the `VoiceRuntime` registry and `TurnController` state machine.

This note records the design decisions for the Deepgram Flux provider adapters.

## Decision

### Flux STT (`@deepseek-ai/dsh-flux-stt`)

**Endpoint**: `wss://api.deepgram.com/v2/listen` (not `/v1/listen` — Flux-specific).

**Protocol**: The adapter connects immediately using the `ws` npm package (Node-style `.on()` events, `.ping()` method). `connect()` resolves only after receiving the `Connected` JSON frame — not on WebSocket open. This lets callers detect auth failures (which arrive as `Error` frames before `Connected`) without racing.

**Keepalive**: Uses WebSocket-protocol `ping()` frames rather than a JSON `{ type: "KeepAlive" }` message. The timer resets on every `sendAudio()` call so that continuous audio flow silences the ping. The server disconnects after ~10s without audio or keepalive.

**Configure**: Maps `SttConfigureRequest` to `{ type: "Configure", thresholds: { eot_threshold, ... }, keyterms }` — note the nested `thresholds` object, matching the Deepgram v2 wire format.

**Turn mapping**: Flux's `TurnInfo { event: "EndOfTurn" }` → `SttTurnEvent { kind: "completed" }` (increments `turnIndex`). `TurnInfo { event: "EagerEndOfTurn" }` → `kind: "eager-completed"` (does not increment). `TurnInfo { event: "TurnResumed" }` → `kind: "resumed"`. `Results` frames map to `kind: "progress"` (interim) or `kind: "started"` (speech_final=true).

**Error handling**: An `Error` frame before `Connected` rejects `connect()`. An abnormal close (code not 1000/1001) before `Connected` rejects with a descriptive message. Post-connection errors push `SttErrorEvent { fatal: true }` to the event stream. `sendAudio()`/`configure()` after close throw `VoiceError` with code `SESSION_CLOSED`.

**AbortSignal**: A pre-aborted signal rejects `connect()` immediately with code `ABORTED`.

**Credentials**: The plugin resolves the API key from `ctx.credentials` when mounted, falling back to `$DEEPGRAM_API_KEY`. A missing key makes `connect()` throw `VOICE_PROVIDER_UNAVAILABLE` (not silently skip registration).

### Flux TTS (`@deepseek-ai/dsh-flux-tts`)

**Endpoint**: `wss://api.deepgram.com/v2/speak` (not `/v1/speak`). An Aura model string is rejected at plugin load with `VOICE_INVALID_PROVIDER`.

**Protocol**: Same Node-style `ws` client. `connect()` resolves after `Connected` frame.

**Keepalive**: WebSocket-protocol `ping()` frames, reset by `speak()` calls. The `/v2/speak` spec says to ping when idle >60s; keepalive interval defaults to 20s (conservative).

**Turn lifecycle**: `SpeechStarted` → `turn-started` event with `turnId`; audio frames are tagged with the current `turnId` from the last `SpeechStarted`. `SpeechMetadata` → `turn-completed`. `SpeechInterrupted` → `turn-interrupted` with `textSpoken`/`textRemaining`. Flux TTS cross-turn voice consistency (prosody persistence) is transparent to the adapter.

**Configure**: `configure({})` with no `speed` is a no-op (no frame sent). `configure({ speed })` sends `{ type: "Configure", speed }`.

**close()**: Sends `{ type: "Close" }`, marks session closed, calls `socket.close(1000)`. Returns a synchronously-resolved promise — the server drains async; the caller does not need to await transport close.

**Bug fixed**: The other agent's `onMessage` used `toUint8Array(data).toString()` which produces comma-separated byte values (incorrect). Fixed to `Buffer.from(toUint8Array(data)).toString('utf8')`.

## Rejected alternatives

**WHATWG WebSocket**: Node's global `WebSocket` (and undici's) do not expose `ping()`, which is required for RFC-6455 keepalive without a JSON payload in the application layer. The `ws` npm package was chosen for its Node-style API and `ping()` support.

**Resolving on WS open**: Resolving `connect()` on the WebSocket `open` event would surface auth failures only as runtime errors mid-stream, not as rejected connect promises. The `Connected`-first approach gives callers a clean error boundary.

**JSON KeepAlive for TTS**: Deepgram Flux TTS has no `{ type: "KeepAlive" }` control message — the documented keepalive is WebSocket-protocol ping. Flux STT does have `KeepAlive` but we use `ping()` for consistency across both adapters.
