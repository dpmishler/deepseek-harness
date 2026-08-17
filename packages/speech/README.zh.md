# speech/ — speech 能力系列

[English](README.md) | 中文

speech seam、其 Deepgram Flux 提供方适配器，以及轮次编排 Consumer。`speech` 包拥有 Service Definition 角色：STT/TTS 提供方注册表、会话/事件词汇表，以及 `SpeechError` 分类体系。提供方适配器通过显式 id 在 `ctx.speech` 上注册——不像 `ctx.web`，这里没有自动选择。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`speech/`](speech/README.md) | Speech 服务、提供方注册表、会话/事件词汇表 | `ctx.speech` |
| [`speech-deepgram-flux-stt/`](speech-deepgram-flux-stt/README.md) | Deepgram Flux STT 提供方（`wss://api.deepgram.com/v2/listen`） | 注册到 `ctx.speech` |
| [`speech-deepgram-flux-tts/`](speech-deepgram-flux-tts/README.md) | Deepgram Flux TTS 提供方（`wss://api.deepgram.com/v2/speak`） | 注册到 `ctx.speech` |
| [`speech-agent/`](speech-agent/README.md) | Consumer：支持打断（barge-in）的轮次控制器，把 LLM 文本流式送入 TTS，并维护持久化的 `speech-agent/*` 会话日志 | 无——接受已打开的会话，不注册任何服务 |

Deepgram 的 Flux 模型是这些适配器唯一的目标 STT/TTS 模型；Aura 以及旧版的 `/v1/speak`/`/v1/listen` 端点被明确排除在范围之外——协议参考见各适配器自己的 README。子 README 拥有各自的线上消息映射、配置和提供方专属限制。[`examples/voice-agent`](../../examples/voice-agent/README.md) 把这四个包接入 `dsh-llm` 和 `dsh-session` 之上，组成一个可运行的演示。
