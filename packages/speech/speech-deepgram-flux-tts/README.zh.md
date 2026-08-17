# @deepseek-ai/dsh-speech-deepgram-flux-tts

[English](README.md) | 中文

在 `ctx.speech`（由 `@deepseek-ai/dsh-speech` 拥有）上注册一个基于 Deepgram Flux 的 `TtsProvider`。每个会话向 `wss://api.deepgram.com/v2/speak` 打开一个 WebSocket——**绝不**使用 `/v1/speak`（Aura）；根据 [Deepgram 的文档](https://developers.deepgram.com/reference/text-to-speech-api/speak-flux)，Aura 模型字符串在 `/v2/speak` 上会被拒绝。

## 注册

```yaml
plugins:
  speech: {}
  speech-deepgram-flux-tts:
    apiKey: ${DEEPGRAM_API_KEY} # or omit and export $DEEPGRAM_API_KEY
```

`apply()` 会把这个提供方注册到稳定的 `PROVIDER_ID`（`deepgram-flux`）下；通过 `ctx.speech.openTts({ provider: 'deepgram-flux', ... })` 打开一个会话。缺失 API 密钥（既没有 `config.apiKey` 也没有 `$DEEPGRAM_API_KEY`）会在加载时抛出异常——这个提供方没有 `available()` 逃生阀。

## 协议映射

发送在 `/v2/speak` URL 上的查询参数：`model`（来自 `options.voice`，格式为 `flux-{voice}-{lang}`，默认 `flux-alexis-en`）、`encoding`/`sample_rate`（来自 `options.audio`，若使用模型的原生采样率则省略）、`speed`（来自 `options.speed`）、`expressivity`（来自 `options.expressivity`——对该连接固定不变；Deepgram 不接受通过 `Configure` 修改它）。鉴权方式是在 WebSocket 握手上携带 `Authorization: Token <apiKey>`，通过 undici 的 `WebSocket` 发送。

| Deepgram `/v2/speak` 消息 | `TtsEvent` |
|---|---|
| `Connected` | `connected`（`requestId`、`modelName`） |
| 二进制 `Audio` 帧 | `audio`（`turnId` 是连接自己追踪的活动轮次；见下文） |
| `SpeechStarted` | `turn-started`；同时设置连接的活动轮次 id |
| `SpeechMetadata` | `turn-completed` |
| `SpeechInterrupted` | `turn-interrupted` |
| `Flushed` | `turn-flushed` |
| `SessionMetadata` | `session-completed` |
| `ConfigureSuccess` | `configure-ack`（`ok: true`、`appliedSpeed`） |
| `ConfigureFailure` | `configure-ack`（`ok: false`、`failureCode`、`failureField`、`failureValue`、`failureMessage`） |
| `Warning` | `warning` |
| `Error` | `error` |
| WebSocket `close` | `closed` |

线上的二进制 `Audio` 帧不携带轮次标识，因此 `FluxTtsConnection` 会追踪最近一次 `SpeechStarted.speech_id`，并把它附加到每一个 `audio` 事件上，直到下一次 `SpeechStarted`；如果某个帧在第一次 `SpeechStarted` 之前就意外到达，会被丢弃，而不是带着一个合成的 id 发出。`TtsSession.interrupt(playbackOffsetMs)` 会发送 `{"type":"Interrupt","playback_offset":{"type":"time_ms","value":playbackOffsetMs}}`；不带参数调用它会完全省略 `playback_offset`（服务端随后也会在 `SpeechInterrupted` 中省略 `text_spoken`/`text_remaining`，与本 seam 自身的契约一致）。`close()` 会发送 `{"type":"Close"}` 并等待服务端排空剩余音频并自行关闭传输——它**不会**强制关闭 socket，那样会截断排空过程。

## 模型体验

无，因为 Deepgram Flux TTS 适配器只负责打开会话；它只是渲染调用方流式送入的任意文本，不添加自己的提示词或 schema。

#### KV Cache 影响

不适用：本包自己不发起任何模型请求。

## 已知限制与延后工作

- **`expressivity` 无法在会话中途更改**——根据 Deepgram 的设计，它对该连接是固定的（beta 阶段；不能通过 `Configure` 设置）；想要不同取值的调用方必须打开一个新会话。
- **`mip_opt_out` 和 `tag` 查询参数未被暴露**——提供方无关的 `TtsOpenOptions` 没有对应字段。
- **意外关闭后没有重连**——异常的 WebSocket 关闭会像其他情况一样呈现为一个 `closed` 事件；调用方必须通过打开一个新会话来重连。
