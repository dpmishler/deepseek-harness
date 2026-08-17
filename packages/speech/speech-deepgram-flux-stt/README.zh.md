# @deepseek-ai/dsh-speech-deepgram-flux-stt

[English](README.md) | 中文

在 `ctx.speech`（由 `@deepseek-ai/dsh-speech` 拥有）上注册一个基于 Deepgram Flux 的 `SttProvider`。每个会话向 `wss://api.deepgram.com/v2/listen` 打开一个 WebSocket——**绝不**使用 `/v1/listen`（Nova/旧版）或任何 Aura 端点；根据 [Deepgram 的文档](https://developers.deepgram.com/docs/flux/quickstart)，Flux 要求使用 `/v2/listen`。

## 注册

```yaml
plugins:
  speech: {}
  speech-deepgram-flux-stt:
    apiKey: ${DEEPGRAM_API_KEY} # or omit and export $DEEPGRAM_API_KEY
```

`apply()` 会把这个提供方注册到稳定的 `PROVIDER_ID`（`deepgram-flux`）下；通过 `ctx.speech.openStt({ provider: 'deepgram-flux', ... })` 打开一个会话。缺失 API 密钥（既没有 `config.apiKey` 也没有 `$DEEPGRAM_API_KEY`）会在加载时抛出异常——这个提供方没有 `available()` 逃生阀，否则 `ctx.speech` 会把请求分发给一个永远无法连接的提供方。

## 协议映射

发送在 `/v2/listen` URL 上的查询参数：`model`（来自 `options.model`，默认 `flux-general-en`）、`encoding`/`sample_rate`（来自 `options.audio`，对容器化音频省略）、`eot_threshold`/`eager_eot_threshold`/`eot_timeout_ms`（来自 `options.endOfTurn`）、重复的 `keyterm`/`language_hint`（来自 `options.keyterms`/`options.languageHints`）。鉴权方式是在 WebSocket 握手上携带 `Authorization: Token <apiKey>`，通过 undici 的 `WebSocket` 发送（Node 的全局 `WebSocket` 无法设置自定义请求头）。

| Deepgram `/v2/listen` 消息 | `SttEvent` |
|---|---|
| `Connected` | `connected` |
| `TurnInfo`（`event: Update`） | `turn`（`kind: 'progress'`） |
| `TurnInfo`（`event: StartOfTurn`） | `turn`（`kind: 'started'`） |
| `TurnInfo`（`event: EagerEndOfTurn`） | `turn`（`kind: 'eager-completed'`） |
| `TurnInfo`（`event: TurnResumed`） | `turn`（`kind: 'resumed'`） |
| `TurnInfo`（`event: EndOfTurn`） | `turn`（`kind: 'completed'`） |
| `Error` | `error`（`fatal: true`） |
| `ConfigureSuccess` | `configure-ack`（`ok: true`） |
| `ConfigureFailure` | `configure-ack`（`ok: false`、`failureCode`、`failureMessage`） |
| WebSocket `close` | `closed` |

`SttSession.configure()` 会发送一条 `Configure` 控制消息：阈值字段嵌套在 `thresholds` 下，`keyterms: []` 会清空列表（按 Deepgram 的行为，省略该字段则保持不变），`languageHints: null`/省略会从消息中完全剔除（服务端视为"不变更"），而 `languageHints: []` 会被显式发送以清空语言提示。`/v2/listen` 上没有客户端发送的 `KeepAlive`——那个消息只存在于旧版的 `/v1/listen` 流上。

## 模型体验

无，因为 Deepgram Flux STT 适配器只负责打开会话；面向模型的表面属于把一段文本记录变成 `user/message` 的那个消费方。

#### KV Cache 影响

不适用：本包自己不发起任何模型请求。

## 已知限制与延后工作

- **没有本地模型/语言提示校验**——向 `flux-general-en` 发送 `language_hint`，或者一个超出范围的阈值，都会被服务端拒绝（`ConfigureFailure` 或连接级错误），而不是在请求发出之前在本地捕获。
- **`profanity_filter`、`numerals`、`redact`、`mip_opt_out`、`tag` 查询参数未被暴露**——提供方无关的 `SttOpenOptions` 没有对应字段；未来的修订需要提供方专属的透传或 seam 级新增字段。
- **意外关闭后没有重连**——除调用方主动 `close()` 之外的任何异常 WebSocket 关闭，都会像其他情况一样呈现为一个 `closed` 事件；调用方必须通过打开一个新会话来重连。
