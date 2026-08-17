# 语音智能体演示：带打断的 Deepgram Flux STT/TTS

[English](README.md) | 中文

将 speech 能力 seam（`ctx.speech`）、其 Deepgram Flux 提供方、`@deepseek-ai/dsh-speech-agent` 的 `TurnController` 以及 `ctx.llm` 组合成一次支持打断（barge-in）的可运行语音对话演示。`cordis.yml` 挂载了 settings、credentials、`dsh-llm-deepseek`、`dsh-session`、`dsh-speech` 以及两个 Deepgram Flux 提供方；在没有 `$DEEPGRAM_API_KEY` 时，这两个提供方行都被 `disabled`（二者在加载时缺少密钥都会直接失败退出，没有 `available()` 逃生阀，因此无密钥启动——CI、没有 Deepgram 账号的贡献者——绝不能挂载它们）。

## 架构

```text
                 audio in                                  audio out
  microphone ───────────────▶ SttSession ───┐      ┌─── TtsSession ───────────────▶ speaker
  (caller-owned)             (Deepgram Flux    │      │  (Deepgram Flux
                              /v2/listen)      │      │   /v2/speak)
                                    │           │      │        ▲
                                    │ turn events      │        │ speak()/flush()/interrupt()
                                    ▼           │      │        │
                          ┌─────────────────────────────────────────────┐
                          │              TurnController                 │
                          │  listening ──▶ thinking ──▶ speaking ──▶... │
                          │  generation counter · PlaybackClock         │
                          │  stale-audio suppression                   │
                          └───────────────────┬─────────────┬───────────┘
                                               │ respond()    │ withSessionLogging()
                                               ▼              ▼
                                        ctx.llm.stream()   Session (speech-agent/*)
                                     (dsh-llm-deepseek)   (durable transcript, response,
                                                            turn-completed/-interrupted)
```

`TurnController` 从不直接接触麦克风或扬声器——调用方把原始音频送入 `SttSession.sendAudio()`，把 `onAudio` 帧渲染到自己的输出设备，并通过 `reportPlayed()` 报告播放进度。本演示的测试使用伪造的音频 I/O（见下文）；真实调用方会替换为真实的采集/播放设备。

**打断路径：** 当控制器处于 `thinking` 或 `speaking` 状态时出现一次 STT `started` 轮次，会递增代次计数器、通过 `AbortSignal` 中止正在进行的 `ctx.llm.stream()` 调用、停止本地播放，并携带 `PlaybackClock` 当前的会话级偏移量调用 `TtsSession.interrupt()`。任何已经为被取代代次在传输中的 TTS `audio` 帧都会被丢弃（`TurnController.discardedFrameCount`），而不会到达输出设备。完整机制见 [`speech-agent` 的 README](../../packages/speech/speech-agent/README.md)。

## 运行方式

无密钥（不需要外部账号）：下面的自动化测试套件本身就是可运行的演示——这个组合没有交互式终端界面，这与 `packages/speech/*` 下其他包的测试先行方式一致。

```sh
DSH_HOME=$(mktemp -d) pnpm vitest run examples/voice-agent/tests/keyless-smoke.e2e.ts
```

该测试通过真实的 Cordis Loader 启动真实的 `cordis.yml`，直接在真实的 `ctx.speech` 上注册伪造的 STT/TTS 提供方（取代 Deepgram——这是昂贵且不确定的网络边界），以及一个本地脚本化的 `respond()`（取代真实的模型调用），并驱动一次完整的轮次外加一次打断。其余部分——`ctx.speech` 的注册/分发、`TurnController`，以及持久化的 `speech-agent/*` 会话日志——都是真实的。

配齐两个提供方账号（真实的 Deepgram Flux TTS、真实的 DeepSeek）：

```sh
DEEPSEEK_API_KEY=... DEEPGRAM_API_KEY=... pnpm vitest run examples/voice-agent/tests/live.e2e.ts
```

该测试通过一次真实的 `ctx.llm.stream()` 调用和一次真实的 Deepgram Flux `/v2/speak` 会话驱动一次轮次（STT 仍是伪造的脚本化文本记录——本仓库没有可用于真实 `/v2/listen` 往返的录音音频素材；该提供方自身的握手已由 `packages/speech/speech-deepgram-flux-stt/tests/live.e2e.ts` 独立验证）。它会打印本演示的延迟测量结果（见下文）并断言收到了真实合成的音频字节。

## 演示脚本

[`assets/demo-script.json`](assets/demo-script.json) 是用于手动验证真实麦克风/扬声器配置的规范两轮对话：提出一个问题，在回答进行到一半时打断并提出一个不相关的问题，然后让第二个回答自然完成。依次期待会话日志中出现：`speech-agent/transcript` → `speech-agent/response` → （被打断轮次的 `speech-agent/turn-interrupted`，或自然完成轮次的 `speech-agent/turn-completed`），并由一个共享的 `generation` 编号关联。

## 可复现的延迟测量方法

`tests/live.e2e.ts` 从（伪造的、脚本化的）STT 轮次最终确定的那一刻起，测量两个时间区间：

- `firstAudioLatencyMs`——直到第一个 Deepgram Flux TTS `audio` 帧到达 `onAudio`。这是调用方可观测的"首个声音时间"：DeepSeek 产出第一个 `text-delta` 的时间，加上本包 `speak()` 调用的时间，再加上 Deepgram 从合成到首帧的时间。
- `turnLatencyMs`——直到 `speech-agent/turn-completed`，即完整响应的总生成与合成时间。

配齐两个密钥后连续运行多次 `tests/live.e2e.ts` 来复现（单次运行噪声很大——提供方负载和网络状况会主导任何一次测量结果）；该测试在每次运行时把两个数值打印到标准输出，而不是断言一个固定上限，因此 CI 不会因提供方延迟波动而变得不稳定。与 `packages/speech/speech-deepgram-flux-tts/tests/live.e2e.ts`（仅 TTS）和 `packages/speech/speech-deepgram-flux-stt/tests/live.e2e.ts`（仅 STT）对比，可以分离出某次测量结果主要由管线的哪一段主导。

## 已知限制与延后工作

- **没有真实的麦克风/扬声器演示**——本 leaf 没有交互式终端界面；`assets/demo-script.json` 为接入真实音频 I/O 的调用方记录了一份人工走查步骤，但本目录本身不提供这样的接线（参见 `dsh-speech-agent` 自己的"没有音频 I/O"限制）。
- **实时测试中没有真正端到端的 STT**——`tests/live.e2e.ts` 用脚本化的文本记录代替向真实 `/v2/listen` 会话馈送真实语音音频，原因是本仓库缺少录音素材。
