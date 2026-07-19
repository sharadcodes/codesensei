# AI CodeSensei

<div align="center">

**Learn any codebase with AI, then test your knowledge through a live, voice-driven conversation.**

Built with ❤ by [sharadcodes](https://github.com/sharadcodes) · [g-savitha](https://github.com/g-savitha) · [iamnabina](https://github.com/iamnabina)

</div>

---

## Overview

AI CodeSensei helps you understand a codebase, then tests your knowledge through a live, voice-driven **Knowledge Check** session. It uses ACP agents (Codex, Devin, etc.) to analyze your repository, then conducts a real-time conversation where it asks questions about the code, opens the relevant files, and highlights the exact lines it's asking about.

## Features

### Code Tutor Guide

Generates a comprehensive `AI CodeSensei.md` guide by reading your repository with your selected ACP agent. Choose from three depths:

- **Quick Overview** (~5 min) — purpose, stack, entry points, architecture map
- **Guided Walkthrough** (~10 min) — major modules, data/control flow, conventions
- **Deep Dive** (15+ min) — architecture, abstractions, workflow tracing, risks

### Knowledge Check

A live, voice-driven interview about your codebase:

1. **Discovers ACP agents** (Codex, Devin, OpenCode, Gemini CLI, etc.) from the [Agent Client Protocol](https://agentclientprotocol.com/) registry
2. **Analyzes your codebase** — the agent reads your repo and produces a structured learning summary with key files and suggested topics
3. **Conducts a voice session** — speech-to-text captures your answers, an LLM evaluates them, and text-to-speech responds
4. **Auto-opens files** — as it asks about specific code, it opens the file and highlights the exact line range
5. **Adaptive difficulty** — adjusts question difficulty based on your responses

## Requirements

- **VS Code 1.90+**
- **An ACP agent** installed (e.g. `npx -y @agentclientprotocol/codex-acp`)
- **An STT API key** — OpenRouter or any OpenAI-compatible endpoint
- **A chat API key** — OpenRouter or any OpenAI-compatible endpoint
- **A TTS endpoint** — [Kokoro FastAPI](https://github.com/remsky/Kokoro-FastAPI) (local, free) or any OpenAI-compatible TTS
- **PortAudio** — bundled for Windows; macOS/Linux may need `portaudio` installed

## Quick Start

1. Install AI CodeSensei from the VS Code Marketplace
2. Open the workspace you want to learn
3. Click the **AI CodeSensei** icon in the Activity Bar
4. Click **↻ Agents** to discover available ACP agents
5. Select an agent (check icon)
6. Click **Start session** to begin a Knowledge Check
7. Speak naturally — the evaluator listens, responds, and asks follow-up questions

## Configuration

All settings live under the `AI CodeSensei.*` namespace. Open Settings (`Ctrl+,`) and search for `AI CodeSensei`.

### Speech-to-Text (STT)

| Setting | Default | Description |
| --- | --- | --- |
| `AI CodeSensei.stt.baseUrl` | `https://openrouter.ai/api/v1` | OpenAI-compatible STT endpoint |
| `AI CodeSensei.stt.model` | `mistralai/voxtral-mini-transcribe` | STT model slug |
| `AI CodeSensei.stt.apiKey` | — | API key. Falls back to `OPENROUTER_API_KEY`, then `OPENAI_API_KEY` |
| `AI CodeSensei.stt.path` | `/audio/transcriptions` | Endpoint path |
| `AI CodeSensei.stt.language` | `en` | ISO-639-1 language code. Empty = auto-detect |

### Text-to-Speech (TTS)

| Setting | Default | Description |
| --- | --- | --- |
| `AI CodeSensei.tts.baseUrl` | `http://localhost:8881/v1` | OpenAI-compatible TTS endpoint (Kokoro FastAPI by default) |
| `AI CodeSensei.tts.model` | `tts-1` | TTS model |
| `AI CodeSensei.tts.apiKey` | `not-needed` | API key (Kokoro doesn't require one) |
| `AI CodeSensei.tts.voice` | `af_heart` | Voice name (Kokoro: `af_heart`, `af_bella`, `af_nova`, etc.) |
| `AI CodeSensei.tts.path` | `/audio/speech` | Endpoint path |
| `AI CodeSensei.tts.responseFormat` | `wav` | Audio format: `wav`, `flac`, `ogg`, `mp3`, `opus` |

### Chat (LLM)

| Setting | Default | Description |
| --- | --- | --- |
| `AI CodeSensei.chat.baseUrl` | `https://openrouter.ai/api/v1` | OpenAI-compatible chat endpoint |
| `AI CodeSensei.chat.model` | `openai/gpt-5.6` | Chat model for Knowledge Check orchestration |
| `AI CodeSensei.chat.apiKey` | — | API key. Falls back to `OPENROUTER_API_KEY`, then `OPENAI_API_KEY` |
| `AI CodeSensei.chat.path` | `/chat/completions` | Endpoint path |

### Audio

| Setting | Default | Description |
| --- | --- | --- |
| `AI CodeSensei.audio.inputDeviceId` | `-1` | PortAudio device ID. `-1` = system default. Use the in-app dropdown to pick. |
| `AI CodeSensei.audio.silenceSeconds` | `2` | Seconds of silence before ending a speech segment |
| `AI CodeSensei.audio.beepEnabled` | `true` | Play a beep when it's your turn to speak |

### ACP Agents

| Setting | Default | Description |
| --- | --- | --- |
| `AI CodeSensei.acp.selectedAgentId` | — | Pre-selected agent ID (`codex`, `devin`, etc.) |
| `AI CodeSensei.acp.agentConfigs` | `{}` | Per-agent config map (model, reasoning effort, sandbox, etc.) |
| `AI CodeSensei.acp.contextPrompt` | *(see default)* | Prompt sent to the agent for codebase analysis |
| `AI CodeSensei.acp.customAgents` | `[]` | Additional stdio-based ACP agents |

### Interview

| Setting | Default | Description |
| --- | --- | --- |
| `AI CodeSensei.interview.maxQuestions` | `0` | Max questions (0 = unlimited) |
| `AI CodeSensei.interview.difficulty` | `adaptive` | `adaptive`, `junior`, `mid`, `senior`, `staff` |
| `AI CodeSensei.tutor.explanationMode` | `guided` | Guide depth: `quick`, `guided`, `deep` |

## Commands

| Command | Description |
| --- | --- |
| `AI CodeSensei: Start Knowledge Check` | Begin a voice-driven interview session |
| `AI CodeSensei: Stop Active Operation` | Stop the current session or guide generation |
| `AI CodeSensei: Generate Codebase Guide` | Create a `AI CodeSensei.md` learning guide |
| `AI CodeSensei: Refresh ACP Agents` | Re-scan for available agents |
| `AI CodeSensei: Test Microphone` | Verify mic capture is working |
| `AI CodeSensei: Test Speaker (TTS)` | Verify TTS playback is working |
| `AI CodeSensei: Clear Cached Session` | Delete cached analysis and start fresh |
| `AI CodeSensei: Show Logs` | Open the AI CodeSensei output channel |

## Architecture

- **ACP layer** — discovers and launches agents via the standard [Agent Client Protocol](https://agentclientprotocol.com/) registry. Any agent that publishes an `agent.json` works automatically.
- **Chained voice pipeline** — PortAudio mic capture → VAD → STT → LLM chat → TTS → webview playback. All components are swappable behind their interfaces.
- **Source policy** — the Code Tutor guide generator creates a curated, read-only analysis workspace with only permitted files, preventing the agent from accessing secrets or irrelevant files.

## License

[MIT](LICENSE)
