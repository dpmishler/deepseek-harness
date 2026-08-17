# @deepseek-ai/dsh-speech

[English](README.md) | 中文

**`SpeechRuntime`**（`ctx.speech`）定义了 harness 拥有**什么**流式 speech 能力——打开一个语音转文本（speech-to-text）会话、打开一个文本转语音（text-to-speech）会话——覆盖多个提供方，同时不把面向模型或面向产品的表面绑定到某一家供应商的线上协议。

本包拥有 speech 能力的 Service Definition 角色。不同于 `ctx.web`，提供方的选择从不含糊、也不会自动解析：每一次打开会话的请求都必须显式命名其提供方 id，因此 `openStt()`/`openTts()` 只会分发给那个确切注册的适配器，否则直接失败退出。

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-speech`（本包） | Service Definition：服务本身、提供方注册表、会话/事件词汇表、`SpeechError` 分类体系 |
| `@deepseek-ai/dsh-speech-deepgram-flux-stt` | STT 提供方：通过 `wss://api.deepgram.com/v2/listen` 使用 Deepgram Flux |
| `@deepseek-ai/dsh-speech-deepgram-flux-tts` | TTS 提供方：通过 `wss://api.deepgram.com/v2/speak` 使用 Deepgram Flux |

STT 与 TTS 不共享任何请求 schema 或业务逻辑，但它们被特意设计成一个 seam：`ctx.speech` 是单一的提供方注册表所有者，拥有一套重复 id 策略和一套错误分类体系，其形态呼应 `ctx.web` 的单服务多注册表结构，同时保持注册显式而非按可用性排序。

## 服务 API（`ctx.speech`）

| 成员 | 语义 |
|---|---|
| `registerSttProvider(id, provider)` / `registerTtsProvider(id, provider)` | 在 `id` 下注册一个后端。如果该能力种类下的 id 重复，抛出 `SpeechError` `SPEECH_DUPLICATE_PROVIDER`。返回一个释放函数；随调用方 fiber 一起释放。 |
| `listSttProviders()` / `listTtsProviders()` | 按注册顺序返回已注册提供方 id 的快照。 |
| `openStt(options)` | 在 `options.provider` 命名的提供方上打开一个 STT 会话。当该 id 没有已注册的适配器时，抛出 `SpeechError` `SPEECH_PROVIDER_NOT_REGISTERED`。 |
| `openTts(options)` | 在 `options.provider` 命名的提供方上打开一个 TTS 会话。当该 id 没有已注册的适配器时，抛出 `SpeechError` `SPEECH_PROVIDER_NOT_REGISTERED`。 |

STT 与 TTS 的提供方 id 存在于独立的命名空间：同一个 id 在每个能力种类下都可以各注册一次。

## 词汇表

`SttSession`/`TtsSession` 是一个已打开的、提供方无关的流式会话：`events` 是一个单消费者的 `AsyncIterable`，在会话的整个生命周期内由一个 `for await` 循环驱动。`SttSession.sendAudio()` 把原始音频加入队列；`SttSession.configure()` 应用一次会话中途的轮次检测/关键词更新，并以一个 `configure-ack` 事件确认。`TtsSession.speak()`/`flush()` 把文本流式送入一个轮次并将其关闭；`interrupt()` 报告调用方检测到的打断（barge-in），用于上下文核对（从不用于停止本地播放，那是调用方自己的职责）。

`SttTurnEvent.kind` 命名了提供方的轮次检测状态转换（`progress` | `started` | `eager-completed` | `resumed` | `completed`），而不假设任何特定提供方的消息命名。`TtsTurnMetrics`（`audioDurationMs`、`inputCharacterCount`、`billableCharacterCount`）被一次自然的 `turn-completed` 和一次被打断轮次的 `metrics` 字段共享，因此两条计费路径读取同一种形状。`SpeechRequestId` 与 `SpeechTurnId`（来自 `@deepseek-ai/dsh-brand`）为提供方分配的关联 id 打上品牌类型，使其在类型层面无法与普通字符串混淆。完整契约与 `SpeechError` 的错误码分类体系见 `src/types.ts`。

## 模型体验

无，因为 STT/TTS 提供方注册表只负责打开会话并转发音频/文本；任何面向模型的表面都由类似 `dsh-speech-agent` 的消费方拥有。

#### KV Cache 影响

不适用：本包自己不发起任何模型请求。

## 已知限制与延后工作

- **面向模型的表面存在于消费方中**——`@deepseek-ai/dsh-speech-agent` 把一段完成的文本记录渲染成一次 LLM 请求，并把响应流式送入 TTS，但本包自身从不检视这段文本；`openStt()`/`openTts()` 同样可以被任何其他插件代码直接使用。
- **没有提供方可用性查询**——不同于 `ctx.web`，这里没有 `available()` 检查或自动选择；调用方必须知道哪个提供方 id 已经注册，缺失的 id 只会在 `openStt()`/`openTts()` 调用时失败，而不是在注册时失败。
- **没有重连或重试策略**——一次传输失败会结束该会话（`closed` 或一个被拒绝的 `events` 可迭代对象）；重连、退避与会话中途恢复都由提供方或消费方负责，不属于本 seam 的范围。
