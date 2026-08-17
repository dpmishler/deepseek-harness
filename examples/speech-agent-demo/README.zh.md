# 语音 Agent 演示

[English](README.md) | 中文

这里的 `cordis.yml` 接好了一个完整的双工语音 agent 的生产组合：

- `@deepseek-ai/dsh-speech`（`ctx.speech`）以及 Deepgram Flux STT/TTS 提供方（`@deepseek-ai/dsh-speech-deepgram-flux-stt`/`-tts`）。
- `@deepseek-ai/dsh-llm` 以及 DeepSeek 适配器（`@deepseek-ai/dsh-llm-deepseek`）。
- `@deepseek-ai/dsh-session`，用于持久的 `speech-agent/*` 事件日志。

轮流对话、打断对账以及持久的"生成 vs. 听到"历史**不是**这张图上的插件——它们是 `@deepseek-ai/dsh-speech-agent` 库，由同时拥有真实音频传输（麦克风采集、扬声器播放）的应用代码来组合，而本仓库并不提供该传输层。应用代码要调用的 API，见 [`@deepseek-ai/dsh-speech-agent` 的 README](../../packages/speech/speech-agent/README.md)。

## 前置条件

1. 一个可以访问 Flux STT 与 Flux TTS 的 Deepgram API key：`DEEPGRAM_API_KEY`。
2. 一个 DeepSeek API key：`DEEPSEEK_API_KEY`。
3. 两者都设置在环境变量中，或写在根目录的 `.env` 文件中。

## 一个完整组合是什么样子

```ts
import { boot, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  SpeechAgentController,
  PlaybackClock,
} from '@deepseek-ai/dsh-speech-agent'
import { withSessionLogging, projectConversationHistory } from '@deepseek-ai/dsh-speech-agent/session-log'
import { createLlmResponder } from '@deepseek-ai/dsh-speech-agent/llm-responder'

loadEnv('speech-agent-demo')
const ctx = await boot('speech-agent-demo', resolveConfigPath('cordis.yml', undefined))

const session = ctx.sessions.create(SessionId(crypto.randomUUID()))
const stt = await ctx.speech.openStt({ provider: 'deepgram-flux' })
const tts = await ctx.speech.openTts({ provider: 'deepgram-flux' })
const playbackClock = new PlaybackClock()

const respond = createLlmResponder(ctx.llm, transcript => ({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [
    ...projectConversationHistory(session),
    { id: crypto.randomUUID() as never, role: 'user', content: [{ type: 'text', text: transcript }], source: { kind: 'user' } },
  ],
}))

const controller = new SpeechAgentController({
  stt,
  tts,
  playbackClock,
  respond,
  handlers: withSessionLogging(session, {
    onTranscript: () => {},
    onAudio: chunk => mySpeaker.write(chunk), // and call playbackClock.advance()/controller.reportPlayed() as frames actually render
    onHaltPlayback: () => mySpeaker.pause(),
    onSpeechInterrupted: () => {},
    onError: (error) => console.error(error),
  }),
})
void controller.run()

myMicrophone.on('data', (chunk) => stt.sendAudio(chunk))
```

`myMicrophone`/`mySpeaker` 是本仓库不提供的、宿主专属的音频 I/O。

## 无需真实凭据即可验证

上面这条完整链路——真实的 `ctx.speech`、真实的 `ctx.llm`、真实的 `SpeechAgentController`/`withSessionLogging`/`createLlmResponder`，通过真实的提供方与一个伪造的 LLM 适配器代替真实网络调用：

```sh
pnpm exec vitest run packages/speech/speech-agent/tests/demo.spec.ts
```

该测试端到端地驱动一次自然轮次和一次打断轮次，并断言持久的 `speech-agent/response-reconciled` 事件以及"生成 vs. 听到"的历史投影。本 `cordis.yml` 的真实提供方路径需要上述两个 API key，本仓库的测试套件在此处不会执行它。

## 排障

| 现象 | 原因 | 解决办法 |
|---|---|---|
| 插件加载失败，提示"no Deepgram API key" | 未设置 `DEEPGRAM_API_KEY` | 设置该环境变量，或将其加入 `.env` |
| `SPEECH_PROVIDER_NOT_REGISTERED` | 传给 `openStt`/`openTts` 的提供方 id 有误 | 使用 `deepgram-flux`，与本 `cordis.yml` 一致 |
| 连接在约 10 秒后断开 | 没有发送音频 | 确保持续调用 `sendAudio()` |
| `NET-0004` TTS 错误 | TTS 会话空闲超过 60 秒 | 缩短轮次之间的空闲时间 |
