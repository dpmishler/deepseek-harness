# 语音

[English](voice.md) | 中文

语音能力 seam（`ctx.voice`）来自 [`packages/voice`](../../packages/voice/README.md)：抽象服务、会话与事件词汇，以及 Deepgram Flux STT 和 TTS 提供方适配器。

源码：[`packages/voice/voice/src/index.ts`](../../packages/voice/voice/src/index.ts)

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    ctx.voice (VoiceRuntime)                  │
│                                                             │
│  STT 注册表                     TTS 注册表                   │
│  ┌───────────────┐               ┌───────────────┐          │
│  │ deepgram-flux │               │ deepgram-flux │          │
│  │ (FluxSttProv) │               │ (FluxTtsProv) │          │
│  └───────┬───────┘               └───────┬───────┘          │
│          │ SttSession                    │ TtsSession       │
└──────────┼───────────────────────────────┼──────────────────┘
           │                               │
           ▼                               ▼
   FluxSttConnection              FluxTtsConnection
   WebSocket                      WebSocket
   /v2/listen                     /v2/speak
```

## 能力 seam 角色

| 角色 | 包 | 说明 |
|---|---|---|
| Service Definition | `@deepseek-ai/dsh-voice` | `VoiceRuntime` 服务、类型与错误码 |
| STT 提供方 | `@deepseek-ai/dsh-flux-stt` | Deepgram Flux `/v2/listen` WebSocket 适配器 |
| TTS 提供方 | `@deepseek-ai/dsh-flux-tts` | Deepgram Flux `/v2/speak` WebSocket 适配器 |

## 提供方选择语义

| 条件 | 结果 |
|---|---|
| 已配置 id 已注册且可用 | 选中该提供方 |
| 已配置 id 未注册 | `VOICE_PROVIDER_CONFIGURED_MISSING` |
| 已配置 id 已注册但不可用 | `VOICE_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配置，恰好一个可用提供方 | 选中该提供方 |
| 未配置，多个可用提供方 | `VOICE_PROVIDER_AMBIGUOUS` |
| 未配置，无可用提供方 | `VOICE_PROVIDER_UNAVAILABLE` |

更多详情请参阅 [English](voice.md) 文档。
