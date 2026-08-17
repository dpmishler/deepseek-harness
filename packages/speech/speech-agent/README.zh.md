# @deepseek-ai/dsh-speech-agent

[English](README.md) | 中文

`ctx.speech`（`@deepseek-ai/dsh-speech`）能力 seam 的 Consumer 角色：一个持久、可复用的 speech-agent 编排层，负责完成 STT 轮次、把 Harness LLM（`@deepseek-ai/dsh-llm`）的输出直接流式送入一个打开的 TTS 会话，并针对提供方精确的 `textSpoken`/`textRemaining` 拆分做打断（barge-in）对账。

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-speech` | Service Definition：`ctx.speech`、STT/TTS 提供方注册表、会话/事件词汇 |
| `@deepseek-ai/dsh-speech-deepgram-flux-stt` / `-tts` | Service Provider：Deepgram Flux 适配器 |
| `@deepseek-ai/dsh-speech-agent`（本包） | Consumer：轮流对话编排、持久历史、`ctx.llm` 绑定 |

## `SpeechAgentController`

主 barrel（`@deepseek-ai/dsh-speech-agent`）只导出不依赖 Cordis、不依赖会话日志的引擎：{@link SpeechAgentController}、{@link PlaybackClock} 与 {@link AsyncEventQueue}。控制器在整个对话生命周期内泵送一个打开的 `SttSession` 和一个打开的 `TtsSession`（均来自 `@deepseek-ai/dsh-speech`）：

- 一次完成的 STT 轮次（`SttTurnEvent.kind === 'completed'`）会调用调用方提供的 `respond(transcript, signal)`，其返回值是 `AsyncIterable<StreamChunk>`——与 `ctx.llm.stream()` 产生的是同一套词汇。每个 `text-delta` 片段都会被直接转发到 `tts.speak()`；流结束时调用 `tts.flush()`。
- 在控制器处于 `thinking` 或 `speaking` 时，一次新的 STT 轮次开始（`kind === 'started'`）即为打断：它会通过 `signal` 中止正在进行的 `respond()` 调用，调用调用方的 `onHaltPlayback()`，并发送 `tts.interrupt(playbackClock.elapsedMs)`——即调用方在驱动真实音频时通过 `reportPlayed()` 上报的、会话级的播放偏移量。`TtsSession.interrupt()` 要求该偏移量在一个会话内严格递增；{@link PlaybackClock} 正是每次打断调用都要读取的那一个计数器。
- 陈旧音频抑制：内部世代计数器在每次打断时递增。属于已被取代世代的 TTS 轮次的音频事件只会让 `discardedFrameCount` 加一，而不会到达 `onAudio()`，因此调用方的播放接收端永远不会渲染出听众已经打断掉的那次响应的音频。
- 生成 vs. 听到对账：控制器累积每次响应的 `text-delta` 片段。自然结束的 `turn-completed` 以 `SpeechAgentTurnCompleted` 上报 `generatedText`（完整响应）。`turn-interrupted` 以 `SpeechAgentTurnInterrupted` 上报精确拆分：`heardText` 是提供方的 `textSpoken`（仅当提供方省略该字段时才回退为 `generatedText`），`remainingText` 是 `textRemaining`。

## 持久历史（`./session-log`）

`withSessionLogging(session, handlers)` 包装调用方的 handlers，使每个与对账相关的回调在委派之前，都向一个 `@deepseek-ai/dsh-session` 的 `Session` 追加一条持久的 `speech-agent/*` `SessionEventMap` 事件：

| 事件 | 记录时机 |
|---|---|
| `speech-agent/turn-transcript` | 每次完成的 STT 轮次 |
| `speech-agent/response-reconciled` | 每次 TTS 轮次的自然结束或打断，携带 `generatedText`/`heardText`/`remainingText`/`interrupted` |
| `speech-agent/session-metadata` | TTS 会话的累计总量，在传输关闭之前通过 `logSessionMetadata()` 记录 |

`projectConversationHistory(session)` 把该持久事件流折叠回普通的 `@deepseek-ai/dsh-llm` `Message`，供下一次 `ctx.llm.stream()` 调用使用。这正是"生成 vs. 听到"的历史约定：助手消息内容永远是 `heardText`，而不是 `generatedText`——被打断截断的响应，会以它实际发生的、被截断的话语延续对话。投影出的助手消息携带固定的 `{ provider: 'speech-agent', model: 'speech-agent' }` 来源：它们是一次持久事件的投影，而不是一次被回放的模型响应，因此从不冒充真实的提供方/模型归属。

## `ctx.llm` 绑定（`./llm-responder`）

`createLlmResponder(llm, buildRequest)` 把 `TurnControllerOptions.respond` 的签名绑定到一个实际的 `LlmRuntime`：`buildRequest(transcript)` 返回请求本身（通常是把 `projectConversationHistory()` 与新的转写文本一起折入 `messages`），返回的函数会把调用方的 `AbortSignal` 转发到 `GenerateOptions.signal`，使打断发生的瞬间就能取消真实适配器的 HTTP 请求，而不仅仅是停止本地消费。

## Invariant

本包的 `./invariant` companion 检查 `speech-agent/turn-transcript.turnIndex` 在一个会话内严格递增，与 `SttTurnEvent` 记录的轮次索引约定一致。

## Known Limitations and Deferred Work

- **没有面向模型的工具，也没有自动的会话接线** —— 本包只提供编排引擎与持久历史辅助函数；宿主负责把它们与真实的音频传输（麦克风采集、扬声器播放）以及一个 `ctx.llm` 调用配置组合起来。本次改动未包含示例组合。
- **`projectConversationHistory` 只覆盖语音轮次** —— 它只折叠 `speech-agent/*` 事件。一个同时携带普通 `user/message`/`assistant/message` 轮次（文本聊天、工具调用）的会话需要自己做合并；本包不会交错这两种历史。
- **没有重连或重试策略** —— 继承自 `@deepseek-ai/dsh-speech`：一次传输失败会结束会话并到达 `onError`；重连是调用方的责任。

## Model Experience

### 投影出的语音轮次历史

#### What the model sees

`projectConversationHistory()` 把每一条持久的 `speech-agent/turn-transcript` 转换成一条普通的用户角色文本消息（该 STT 轮次的最终转写），把每一条 `speech-agent/response-reconciled` 转换成一条普通的助手角色文本消息，其内容为 `heardText`——发生打断时是被截断的话语，否则是完整的生成回复。调用方把这个数组折入 `GenerateOptions.messages`；本包不渲染任何自己的系统提示文本或工具 schema。

#### Token effect

每一个已对账的语音轮次会增加一条数据相关的用户消息，以及（一旦对账完成）一条数据相关的助手消息。本包不做任何私有截断或预算控制；打断会缩短助手消息本身，而不是新增一条独立记录。

#### KV Cache effect

仅追加：一个已对账轮次投影出的消息只写入一次，此后不再修改，因此随着后续轮次不断追加，更早的轮次始终是一个稳定、可复用的前缀。`heardText` 在对账那一刻就已固定——打断改变的是接下来要记录的内容，而不会改变一个已经对账并已发送过的历史轮次。
