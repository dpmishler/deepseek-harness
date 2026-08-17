# @deepseek-ai/dsh-speech-agent

[English](README.md) | 中文

在 speech 能力 seam（`ctx.speech`，来自 `@deepseek-ai/dsh-speech`）与 LLM 能力（`ctx.llm`，来自 `@deepseek-ai/dsh-llm`）之上实现支持打断（barge-in）的轮次编排。这是 [capability seam](../../../docs/architecture.md#capability-seams) 意义上的一个 **Consumer**——它使用已经打开的 `SttSession`/`TtsSession` 以及已经打开的 LLM 流，本身不拥有任何服务（`ctx` 键）。这是一个库，不是被挂载的 Cordis 插件：调用方自行打开会话并直接接入 `TurnController`。

## `TurnController`

`TurnController`端到端驱动一次语音对话：

1. 拉取已打开的 `SttSession.events`。一次 `completed` 轮次的文本记录会被报告（`onTranscript`）并开启一个新的**响应代次（response generation）**——`TurnController.respond(transcript, signal)` 直接流式产出 `@deepseek-ai/dsh-llm` 的 `StreamChunk` 词汇表，因此真实的 `respond` 形如 `(transcript, signal) => ctx.llm.stream({ ...options, messages: [...history, userMessage(transcript)], signal })`。
2. 将每个 `text-delta` 直接转发进已打开的 `TtsSession.speak()`（`onAssistantTextDelta` 仅用于 UI 回显），并在模型流结束后调用 `flush()`。
3. 拉取已打开的 `TtsSession.events`，将 `audio` 帧转发给 `onAudio`，并报告 `turn-completed`/`turn-interrupted` 结果。
4. 发生打断时——控制器处于 `thinking` 或 `speaking` 状态时出现了新的 STT `started` 轮次——中止正在进行的 LLM 调用、停止播放（`onHaltPlayback`），并携带会话级播放偏移量调用 `TtsSession.interrupt()`。

### 打断取消与陈旧音频抑制

每个响应代次都会获得一个单调递增的 `generation` 编号。打断会递增该编号，并通过 `AbortSignal` 中止正在进行的 `respond()` 调用；之后到达的、属于某个已被取代代次的 `audio` 帧（在发送 `Interrupt` 时已经在 TTS WebSocket 上传输中）会被丢弃，而不会到达 `onAudio`——参见 `TurnController.discardedFrameCount`。这就是取消的传播路径：LLM 生成、TTS 合成与播放都以同一个代次计数器为键，因此一次取消可以同时使三者失效而不产生相互竞争。

### 会话级播放偏移量

Flux TTS 的 `Interrupt.playback_offset` 是整个会话的单一时钟，而不是逐轮次计数，并且每次打断的偏移量都必须严格超过上一次——一个不前进的偏移量会被以 `INVALID_INTERRUPT_OFFSET` 警告忽略。`PlaybackClock` 拥有这个计数器：驱动真实音频输出的调用方在帧被实际渲染（而不是仅仅被接收）时调用 `TurnController.reportPlayed(ms)`，而 `bargeIn()` 通过 `PlaybackClock.consumeInterruptOffsetMs()` 获取下一个合法偏移量——当该时钟自上一次打断以来没有前进（例如同一个 `thinking` 阶段内连续发生两次打断，此时还没有任何音频播放过）时，返回 `undefined`。这时 `TurnController` 会以不带参数的方式调用 `interrupt()`：轮次仍会被取消，但回复中不再包含 `textSpoken`/`textRemaining`。

### 生成内容与实际听到内容的核对

`onResponseGenerated(generation, text)` 对每个代次恰好触发一次，携带模型产生的完整文本——如果响应自然 flush，则是完整文本；如果打断在 flush 之前取代了该代次，则是已经流式生成的部分文本。将其与对应的 `onSpeechInterrupted` 回复中的 `textSpoken`/`textRemaining`（Flux TTS 自己给出的、听众实际听到与被取消部分的拆分，以同一个 `generation` 关联）进行比较，即可核对听众究竟听到了什么。下文的 `withSessionLogging` 会把这两部分都写入持久化记录，使这种核对在重放（replay）之后依然可用。

## `./consumer.ts`：持久化会话日志集成

`withSessionLogging(session, handlers)` 会包装调用方自己的 `TurnControllerHandlers`，使每个与核对相关的回调在委托之前都向 `@deepseek-ai/dsh-session` 的 `Session` 追加一条持久化事件：

| 事件 | 来源 | 携带内容 |
|---|---|---|
| `speech-agent/transcript` | `onTranscript` | `generation`、`turnIndex`、`transcript`、`endOfTurnConfidence` |
| `speech-agent/response` | `onResponseGenerated` | `generation`、`text`——核对中"生成内容"的一半 |
| `speech-agent/turn-completed` | `onTurnCompleted` | `generation`、`turnId` 以及 `TtsTurnMetrics` |
| `speech-agent/turn-interrupted` | `onSpeechInterrupted` | `generation`、`turnId`、`audioPlayedMs`、`textSpoken`/`textRemaining`——核对中"实际听到"的一半——以及 `TtsTurnMetrics` |

`logSessionCompleted(session, totals)` 单独追加 `speech-agent/session-completed`（累计总量），因为 `TtsSessionCompletedEvent` 是在传输层被消费的（调用方自己的 `tts.events` 循环或关闭路径），并不经过 `TurnControllerHandlers`。

该模块被排除在本包的主入口（`./index.ts`）之外，因为它是唯一需要 `@deepseek-ai/dsh-session` 的 `Session` 类型的模块；对 `TurnController` 本身的单元测试完全不需要会话，这与上文[「`TurnController`」](#turncontroller)一节的会话日志无关设计保持一致。

`./invariant.ts` 检查这些事件在一个会话完整日志中建立的持久化关系：`speech-agent/transcript` 的代次严格递增，`speech-agent/turn-interrupted` 的 `audioPlayedMs` 从不减少（与 `PlaybackClock` 自身的单调契约相呼应），并且在同一个 `generation` 上，当二者都存在时，`textSpoken + textRemaining` 必须逐字重建出对应 `speech-agent/response` 的文本。

## 模型体验

无，因为 `TurnController` 只对已经打开的 STT/TTS 会话进行编排，并转发调用方通过 `respond` 提供的文本记录或响应文本；它自己不构建任何系统提示词或工具 schema——那些属于调用方的 `respond` 所做的 `ctx.llm.stream()` 调用。

#### KV Cache 影响

不适用：本包自己不发起任何模型请求。

## 已知限制与延后工作

- **没有推测式（eager）响应生成**——`TurnController` 只在确认的 `completed` STT 轮次上开始响应；Flux STT 的 `eager-completed`/`resumed` 事件（可选的 `eagerEndOfTurn` 配置）是本包目前有意不处理的 seam 级词汇表，以牺牲延迟优势为代价，换取永远不必撤回一个推测式响应。
- **打断检测仅依赖 STT**——控制器把一次新的 STT `started` 事件当作唯一的打断信号，遵循 Deepgram 自己等价逻辑（目前未作为公开方法暴露）。
- **没有重连或多路合并**——一个 `TurnController` 在整个对话生命周期中只驱动一个 STT 会话和一个 TTS 会话；意外传输关闭后的重连，以及多个音频参与者的合并，都由调用方负责，不属于本包范围。
- **没有音频 I/O**——`TurnController` 从不接触麦克风、扬声器或音频文件；调用方负责把原始音频送入 `SttSession.sendAudio()`，把 `onAudio` 帧渲染到自己的输出设备，并通过 `reportPlayed()` 报告播放进度。
