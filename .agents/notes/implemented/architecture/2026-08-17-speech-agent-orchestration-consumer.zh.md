# Agent Note: 面向 ctx.speech 的 speech-agent 编排 Consumer

Status: implemented

[English](2026-08-17-speech-agent-orchestration-consumer.md) | 中文

## 问题

`@deepseek-ai/dsh-speech`（`ctx.speech` 能力 seam）及其 Deepgram Flux STT/TTS 提供方适配器是作为基础切片交付的，并明确记录了一个缺口："尚未接入任何面向模型的工具或 voice-agent Consumer"。打开 STT/TTS 会话目前只能从临时插件代码中使用；没有任何东西驱动完整的轮流对话——完成用户的 STT 轮次、把 Harness LLM 的回复直接流式送入 TTS,并针对打断（barge-in）用提供方精确的 `textSpoken`/`textRemaining` 拆分做对账。

此前对该编排层的一次尝试（`packages/voice/*`，提交 `33dbd22972`）被回退（`e59b02d46f`），原因是它把 `ctx.speech` 重复实现成了第二个、与之竞争的 `ctx.voice` 能力 seam，而不是消费已经接好的那一个；同时它自己的测试携带两类缺陷：一个 `for await` 泵循环测试在等待 `controller.run()` 结算之前，从未对其伪造会话调用 `queue.end()`（这是测试自身的死锁，不是库本身的缺陷，表现为 Vitest 的 5 秒超时），以及三个断言了 `VoiceRuntime` 分发从未实现过的错误约定的测试。

## 决策

`@deepseek-ai/dsh-speech-agent`（`packages/speech/speech-agent`）是既有 `ctx.speech` seam 的 Consumer 角色——它不注册任何竞争能力，而是直接从 `@deepseek-ai/dsh-speech` 导入 `SttSession`/`TtsSession`/`SpeechError`。它交付四个可独立导入的部分：

- **`SpeechAgentController`**（主 barrel）：一个不依赖 Cordis、也不依赖会话日志的轮次状态机（`idle`/`listening`/`thinking`/`speaking`），泵送一个打开的 `SttSession` 和一个打开的 `TtsSession`。一次完成的 STT 轮次会调用调用方提供的 `respond(transcript, signal): AsyncIterable<StreamChunk>`，并把每个 `text-delta` 转发给 `tts.speak()`，随后调用 `tts.flush()`。在 `thinking`/`speaking` 期间开始的新 STT 轮次即为打断：它通过 `signal` 中止 `respond()`，调用 `onHaltPlayback()`，并发送 `tts.interrupt(playbackClock.elapsedMs)`。
- **`PlaybackClock`**：`TtsSession.interrupt()` 所要求的、会话级单调递增的"实际已听到的音频毫秒数"计数器（每次调用的偏移量必须严格大于上一次）。
- **陈旧音频抑制**：内部世代计数器在每次打断时递增；属于已被取代世代的 TTS `audio` 事件只会让 `discardedFrameCount` 加一，而不会到达 `onAudio()`。
- **"生成 vs. 听到"对账**：控制器按世代累积每次响应的 `text-delta` 片段。自然结束的 `turn-completed` 上报完整的 `generatedText`；被打断的 `turn-interrupted` 上报 `generatedText`，并附带 `heardText`（提供方的 `textSpoken`，仅当提供方未给出时才回退为 `generatedText`）与 `remainingText`。
- **`./session-log`（可选子路径）**：`withSessionLogging(session, handlers)` 追加持久化的 `speech-agent/turn-transcript` 与 `speech-agent/response-reconciled`（通过声明合并并入 `@deepseek-ai/dsh-session` 的 `SessionEventMap`）；`projectConversationHistory(session)` 把该日志折叠回普通的 `Message`，供下一次请求使用，其中助手内容始终是 `heardText`——而非 `generatedText`。这正是"生成 vs. 听到"的**持久历史**约定：被打断截断的响应，会以它实际发生的、被截断的话语延续对话。
- **`./llm-responder`（可选子路径）**：`createLlmResponder(llm, buildRequest)` 把 `respond()` 的签名绑定到一个实际的 `LlmRuntime.stream()`,并把调用方的 `AbortSignal` 转发到 `GenerateOptions.signal`,使打断能真正取消底层提供方请求，而不仅仅是本地消费——这正是"把 Harness LLM 输出直接流式送入 TTS"的具体实现。

持久日志与 `ctx.llm` 集成都保留为独立的模块导出（不进入主 barrel），这样对控制器本身的单元测试既不需要 `@deepseek-ai/dsh-session`，也不需要一个真实的 `LlmRuntime`，与被回退设计自身给出的理由一致。

本包的 `./invariant` companion 检查 `speech-agent/turn-transcript.turnIndex` 在一个会话内严格递增（对应被回退的 `dsh-voice` companion，按新的事件名调整）。

同一改动中修复的工作区缺陷：`tsconfig.base.json` 在 `packages/voice` 目录被回退删除之后，仍在 `@deepseek-ai/dsh-*` 路径通配符与 invariant glob 中保留了 `./packages/voice/*/src` 与 `./packages/voice/*/src/invariant.ts`——一条指向不存在目录的悬空 glob 条目。两处均已移除；`tsconfig.host.json` 新增了本包的工程引用。

## 曾考虑的替代方案

**整体复活 `packages/voice/*`。** 否决，理由与原始回退相同：这会重新引入第二个、与已接好的 `ctx.speech` 竞争的能力 seam（`ctx.voice`），而不是消费 `tsconfig.base.json` 既有通配符及其余代码树已经接好的那一个。

**原地修复被回退的测试套件并重新合入 `packages/voice`。** 曾考虑过，但被回退代码树自己的 `VoiceRuntime` 用一套不同的错误码命名空间重复实现了 `SpeechRuntime` 的提供方注册表逻辑（注册/列出/打开、重复 id 与未注册错误）；继续沿用会让同一能力存在两套注册表。其编排引擎、播放时钟与异步队列的设计是合理的，被近乎原样复用，只是重新指向 `@deepseek-ai/dsh-speech` 既有的类型。

**为每种结局各用一个持久事件（分开的 `turn-completed`/`turn-interrupted` 事件类型），与被回退设计完全一致。** 否决，改为一个带 `interrupted: boolean` 判别字段的 `speech-agent/response-reconciled` 事件：两种结局是同一个事实——"这次响应结束了；这是生成的内容，这是被听到的内容"——单一事件类型让 `projectConversationHistory` 只需一次查询而非两次，也让 invariant 与历史投影代码只需折叠一种形状而不是联合类型。

**在投影出的助手消息 `source` 中固定编造出原始 LLM 调用的 `provider`/`model`。** `AssistantMessage.source` 要求 `ModelMessageSource`（`kind: 'model'` 加 `provider`/`model`），但控制器的 `respond()` 签名故意对是哪条路由产生了某个片段保持不透明，持久化的 `speech-agent/response-reconciled` 事件也不记录它。编造归属会把一条重建出来的消息误呈现为真实的提供方回放（暗示它具备并不存在的 `replayState` 兼容性）。投影改为使用固定的 `{ provider: 'speech-agent', model: 'speech-agent' }` 哨兵值，并记录为有意为之。

**把可运行的演示做成新的 `examples/<leaf>/run.ts` 脚本。** `examples/AGENTS.md` 规定示例只保留 `cordis.yml` 编排与 e2e/快照场景；一个临时的长驻脚本不符合这一形态。演示改为放在本包自己 `tests/` 下的一个真实可运行的 Vitest 编排套件中，针对伪造的 `SttSession`/`TtsSession` 以及一个脚本化的 `LlmAdapter`；本次改动未添加 `examples/` leaf；一个生产组合（真实 Deepgram Flux + DeepSeek，一个真实的音频传输）被推迟到未来的包或示例。

## 结果

`ctx.speech` 获得了一个有文档、有测试的 Consumer；包 README 中"尚未接入任何面向模型的工具或 voice-agent Consumer"的局限性收窄为"尚无面向模型的*工具*"——程序化组合（一个演示、未来的一个工具）现在无需手写轮流对话、打断处理或历史对账即可驱动完整的语音对话。`projectConversationHistory` 只折叠 `speech-agent/*` 事件；一个混合了语音轮次与普通文本 `user/message`/`assistant/message` 历史的会话需要自己做合并，这留给组合方处理。悬空失效的 `packages/voice/*` tsconfig glob 条目已移除，之后的 `tsc -b` 调用不会再在那里悄悄匹配零个文件。

## 测试

确定性的单元/编排测试（无网络、无真实定时器）覆盖：自然轮次完成（STT 定稿 → LLM 流式 → TTS speak/flush）、打断（暂停播放、中止信号传播、带播放偏移量的 interrupt、陈旧音频抑制、有/无提供方偏移量两种情形下的 `textSpoken`/`textRemaining` 对账）、STT 与 TTS 两侧的非 `Error` 与 `Error` 传输/响应失败、一个无法识别的 TTS 事件类型（`assertNever`）、以及跨轮次的世代映射清理（连续轮次之间不泄漏 `generatedText`）。会话日志测试覆盖持久事件的结构与 `projectConversationHistory` 的“生成 vs. 听到”折叠，包括防御性分支（未对账的尾随转写、孤立的对账事件、无关的交错会话事件类型）。invariant companion 针对全新会话、在 companion 挂载前已存在的会话、重复的 `turnIndex` 与递减的 `turnIndex` 均有测试。测试用有上限的微任务轮询辅助函数 `waitUntil` 取代了固定次数的 `await Promise.resolve()`，正是这个改动揭示（并让我们修复）了原始回退所归咎于被回退套件的那一类“测试在等待 `run()` 结算之前从未调用 `queue.end()`”死锁。
