# Interview Lele

A VSCode extension that turns your codebase into a live, voice-driven technical interview.

## What it does

1. **Discovers ACP agents** (Codex, Devin, OpenCode, Gemini CLI, etc.) from the
   [Agent Client Protocol](https://agentclientprotocol.com/) registry plus any
   local registry at `~/.windsurf/acp/registry.json`.
2. **Spins up the agent you pick** to read your codebase and produce a
   structured interview-relevant summary (key files + suggested topics with
   file/line ranges).
3. **Starts a two-way voice interview** using any OpenAI-compatible Realtime
   API endpoint (STT + TTS + LLM on one WebSocket).
4. As it talks, it **automatically opens files and highlights the exact code
   range** it is asking about, so you see what the interviewer sees.
5. You answer out loud; the interviewer listens, acknowledges, and asks the
   next question — like a real interview.

## Requirements

- VSCode 1.90+
- `ffmpeg` (and ideally `ffplay`) on your PATH — used for microphone capture
  and speaker playback. VSCode webviews cannot access the mic, so capture runs
  in the extension host via ffmpeg, the same approach used by the major CLI
  agents.
- An OpenAI-compatible Realtime API key (OpenAI, Speaches, SCX, etc.).
- At least one ACP agent installed (e.g. `npx -y @agentclientprotocol/codex-acp`).

## Quick start

1. Install the extension from the `.vsix`.
2. Open the workspace you want to be interviewed on.
3. Open the **Interview Lele** view in the Activity Bar.
4. Click the refresh icon next to **ACP Agents** to discover agents.
5. Click the check icon on an agent to select it.
6. Run **Interview Lele: Start Interview** from the Command Palette.
7. Allow the agent to analyze the codebase, then talk to the interviewer.

## Configuration

All settings live under the `interviewLele.*` namespace. Highlights:

| Setting | Purpose |
| --- | --- |
| `realtime.baseUrl` | OpenAI-compatible Realtime WebSocket URL. |
| `realtime.model` | Realtime model id (e.g. `gpt-4o-realtime-preview`). |
| `realtime.apiKey` | API key. Falls back to `OPENAI_API_KEY`. |
| `realtime.voice` | TTS voice (`alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`). |
| `realtime.instructions` | System prompt for the interviewer persona. |
| `realtime.inputFormat` / `outputFormat` | Audio formats (`pcm16`, `g711_*`, `opus`). |
| `realtime.turnDetection` | `server_vad` (default) or `none`. |
| `audio.ffmpegPath` | Path to ffmpeg. Defaults to `ffmpeg` on PATH. |
| `audio.inputDevice` | Optional explicit input device. |
| `acp.registryUrl` | Remote ACP registry. |
| `acp.localRegistryPath` | Optional local registry.json to merge in. |
| `acp.selectedAgentId` | Pre-selected agent id. |
| `acp.contextPrompt` | Prompt used to extract interview context. |
| `interview.maxQuestions` | Stop after N questions (0 = unlimited). |

## Modularity

- The Realtime layer is behind a `RealtimeProvider` interface; the
  OpenAI-compatible implementation is in `src/realtime/openai.ts`. Swap it for
  any provider that emits the same events.
- ACP agents are discovered via the standard ACP registry format, so any
  future agent (Antigravity, etc.) that publishes an `agent.json` works
  automatically on Windows and macOS.

## License

MIT
