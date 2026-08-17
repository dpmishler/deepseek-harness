# Agent Note: 基于 ctx.speech 的支持打断（barge-in）语音编排

Status: implemented

[English](2026-08-17-speech-agent-barge-in-orchestration.md) | 中文

## Problem

`@deepseek-ai/dsh-speech`（Service Definition）以及它的 Deepgram Flux STT/TTS 提供方会打开提供方无关的流式会话，但仓库中没有任何东西把一段最终确定的 STT 文本记录变成一次 LLM 请求，也没有把 LLM 的响应流式送入 TTS。缺少这个 Consumer，`ctx.speech` 就完全没有面向模型的表面，任何想要实现语音对话的调用方都没有可以依赖的打断（barge-in）、取消传播或播放偏移量处理——每个消费方都得从零发明自己的轮次状态机、代次追踪，以及 Flux `Interrupt` 偏移量记账。此前对这一切片的一次尝试（提交 `33dbd22972`，在 `e59b02d46f` 被回退）把这个 seam 本身重复实现为与 `ctx.speech` 并存的第二个 `ctx.voice` 注册表，并且带着真实的回归问题一起提交（一个被截断的测试文件、一个 flush 计数断言不匹配，以及若干提供方分发错误契约不匹配）。

## Decision

`@deepseek-ai/dsh-speech-agent` 是一个没有自己 `ctx` 键的 Consumer 包：`TurnController` 接受调用方已经打开的 `SttSession`/`TtsSession`（通过 `ctx.speech.openStt()`/`openTts()` 打开）以及一个 `respond(transcript, signal): AsyncIterable<StreamChunk>` 回调——与 `LlmRuntime.stream()` 已经产出的同一套 `@deepseek-ai/dsh-llm` chunk 词汇表，因此真实的 `respond` 只是围绕 `ctx.llm.stream()` 的一层薄闭包。这使得本包在设计上与 Cordis、会话日志都无关：`TurnController` 可以在完全没有 context 的情况下针对伪造会话进行单元测试，而 `./consumer.ts`（一个独立模块，被排除在主入口之外）是唯一依赖 `@deepseek-ai/dsh-session` 的文件。

每个响应都会获得一个单调递增的 `generation` 编号，正常开始一次响应和发生打断时都会递增它。`TurnController` 并发拉取 `SttSession.events` 与 `TtsSession.events`：一次 `completed` STT 轮次会开启一个新代次，并把模型的 `text-delta` chunk 直接流式送入 `TtsSession.speak()`，在流结束时 flush；当控制器处于 `thinking` 或 `speaking` 状态时到来的一次 `started` STT 轮次就是打断——它会通过 `AbortSignal` 中止正在进行的 `respond()` 调用、停止本地播放，并调用 `TtsSession.interrupt()`。一个在 `turn-started` 时记录的 `speakingGeneration` 字段，使 TTS 拉取循环可以丢弃那些所属代次在到达之前就已被取代的 `audio` 帧（`TurnController.discardedFrameCount`），而不是把陈旧音频交给调用方。

`PlaybackClock` 拥有 Flux TTS 的 `Interrupt.playback_offset` 所要求的会话级"实际已听到的音频毫秒数"计数器。它的 `consumeInterruptOffsetMs()` 会返回 `undefined`，而不是重复上一次打断的偏移量——这是本设计相对于被回退版本新增的协议正确性修复：Flux TTS 对一个不前进的偏移量会以 `INVALID_INTERRUPT_OFFSET` 回应并把该次打断当作核对忽略（不过调用方自己已经发出的取消动作不受影响），而被回退的代码没有针对这一点做防护。

`onResponseGenerated(generation, text)` 对每个代次恰好触发一次——在正常 flush 时携带完整文本，或者在 flush 之前被打断取代时携带已经流式生成的部分文本——给出生成内容与实际听到内容核对中"生成内容"的一半。`onSpeechInterrupted`/`onTurnCompleted` 现在也会收到同一个 `generation`（从 `speakingGeneration` 读取），因此 `./consumer.ts` 的 `withSessionLogging` 可以把全部四个 `speech-agent/*` 事件（`transcript`、`response`、`turn-completed`、`turn-interrupted`）以同一个 id 关联并持久化记录，而不必从日志的先后位置推断关联关系。`./invariant.ts` 检查一个会话完整持久化日志中的两种关系：`speech-agent/transcript` 的代次严格递增，以及 `speech-agent/turn-interrupted.audioPlayedMs` 从不减少（呼应 `PlaybackClock` 自身的契约）；当二者都存在时，`textSpoken + textRemaining` 必须逐字重建出对应的 `speech-agent/response` 文本。

## Alternatives considered

**在 `ctx.speech` 旁再实现一个 `ctx.voice` 能力 seam。** 这正是被回退的 `33dbd22972` 所做的事，也正是让它超出自身 PR 范围的原因：`ctx.speech` 已经拥有 STT/TTS 的 Service Definition，一个与之竞争的注册表是在重复它，而不是完成它。`dsh-speech-agent` 是既有 seam 的一个 Consumer，不是第二个 seam。

**让文本记录经过完整的 agent-loop turn/step 机制（`user/message`/`assistant/message`）。** 一次语音对话的 STT/TTS 往返并不适合面向工具调用的 step 模型，而且现有每一个 `SessionEventMap` 持久化轮次先例（`turn/start`、`step/start`）都由 `dsh-agent-loop` 拥有，不属于某个能力 Consumer。专用的、仅写日志的 `speech-agent/*` 事件让面向模型的文本记录与响应保持持久化（满足"模型可见即已记录"），同时不接管 loop 自己的轮次记账。

**通过把 `textSpoken`/`textRemaining` 文本与一个待处理的 `speech-agent/response` 做匹配，来把 `speech-agent/turn-interrupted`/`turn-completed` 关联到其代次。** 本不变式的一个早期草稿正是这样做的；这种方式是模糊的（一次偶然的文本匹配会关联到错误的代次），并且对只有自然完成的会话会泄漏无限增长的待处理状态。把真实的 `generation` 编号通过 `onTurnCompleted`/`onSpeechInterrupted`（来源于 `TurnController.speakingGeneration`）传递出去，使这次关联变得精确，并让不变式可以确定性地清理已解决的条目。

## Consequences

调用方只需把 `TurnController`接入已经打开的会话，就能"免费"获得打断取消、陈旧音频抑制，以及符合 Flux 协议的播放偏移量；代价是本包仍然不做任何音频 I/O、不在 Flux STT 的 `eager-completed`/`resumed` 事件上做推测式生成，也不做重连——这些都记录在包 README 的已知限制中，而不是在这里解决。`examples/voice-agent` 演示了完整的组合：`tests/keyless-smoke.e2e.ts` 通过真实的 Loader 启动真实的 `cordis.yml`，使用伪造的 STT/TTS 提供方和一个脚本化的 `respond()`；`tests/live.e2e.ts`（可选启用，需要 `$DEEPSEEK_API_KEY` 与 `$DEEPGRAM_API_KEY` 两者）通过一次真实的 `ctx.llm.stream()` 调用和一次真实的 Deepgram Flux `/v2/speak` 会话驱动一次轮次，打印本演示的延迟测量方法（`firstAudioLatencyMs`、`turnLatencyMs`）而不断言一个固定上限。

## Testing

`packages/speech/speech-agent/tests/turn-controller.spec.ts` 针对伪造会话覆盖了完整的状态机：自然完成、说话过程中的打断、两次打断之间没有 `PlaybackClock.advance()` 的竞态（证明第二次 `interrupt()` 调用会省略其偏移量）、当没有 `turn-started` 先行到达时终态 TTS 事件的代次回退归因、未识别事件的 `assertNever` 路径，以及每个拉取循环失败归一化逻辑中 Error 与非 Error 两个分支——达到 100% 分支覆盖率。`tests/playback-clock.spec.ts`、`tests/consumer.spec.ts` 和 `tests/invariant.spec.ts` 分别覆盖了时钟的单调偏移量契约、持久化日志封装器的精确事件形状，以及不变式的接受/拒绝场景。`examples/voice-agent/tests/keyless-smoke.e2e.ts` 是必需的真实组合测试：它证明 `ctx.speech` 的注册/分发、`TurnController`，以及持久化的 `speech-agent/*` 日志，三者通过真实的 Loader 协同工作。
