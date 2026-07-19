Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.

I’m going to read the repository docs and the documentation skill guidance first, then trace the main runtime files so the guide stays grounded in the inspected source only.The first path was off; I’m switching to the actual skill location and then I’ll extract the repository’s own entry points and flow from source.I’ve confirmed the documentation skill path. Next I’m reading the source files that define startup, config, realtime, audio, tutor, and UI so the guide reflects actual code paths rather than guesses.I have the main activation/config surface. I’m now reading the interview, ACP, realtime, audio, and UI files to extract one end-to-end flow and the key file map with line-accurate references where they matter.I have the core control plane. I’m filling in the runtime pieces now: voice pipeline, file highlighting, and webview/home UI, since those define the actual user experience described in the guide.I have enough to draft the architecture, but I’m grabbing line numbers for the most important claims and finishing the remaining UI/audio file tails so the references are precise and the limitations are explicit.# CodeSensei Guide

## Purpose

CodeSensei is a VS Code extension for learning a repository through two related experiences: generating a codebase guide and running a live, voice-driven knowledge check. The README describes the product as “learn any codebase with AI, then test your knowledge through a live, voice-driven conversation,” and the code supports both a guide-generation path and an interview path. The guide flow produces a `CODESENSEI.md` file in the workspace, while the interview flow opens files, highlights relevant lines, and speaks questions and responses through TTS.

A key design choice is that the extension is modular around three external capabilities: ACP agents for repository analysis, OpenAI-compatible STT/LLM/TTS endpoints for the interview loop, and PortAudio-based mic capture for spoken input.

## Stack

This is a TypeScript VS Code extension. The curated source shows:

- VS Code extension APIs for activation, commands, webviews, workspace storage, and decorations.
- ACP agent discovery and JSON-RPC stdio communication.
- OpenAI-compatible HTTP APIs for STT, chat, and TTS.
- PortAudio via `naudiodon2` for microphone capture.
- Webview-based UI for the home panel and audio playback.
- `ws` for the optional realtime provider implementation.

`package.json` confirms the extension targets VS Code `^1.90.0`, activates on `onStartupFinished`, and loads `./dist/extension.js` as the main entrypoint. The source files in this curated view are the implementation layer; build scripts, packaging details, and deployment infrastructure were not available here, so those are intentionally not inferred.

## Entry Points

The main runtime entry is [`src/extension.ts`](src/extension.ts#L23), where `activate()` initializes logging, storage, the home webview, and command registrations. The key commands are:

- start knowledge check
- stop active operation
- show logs
- refresh agents
- test microphone
- test speaker
- clear cached session
- generate codebase guide

The other operational entry points are:

- [`src/ui/homeView.ts`](src/ui/homeView.ts#L28) for the webview panel and its message bridge.
- [`src/interview/orchestrator.ts`](src/interview/orchestrator.ts#L55) for the live interview loop.
- [`src/acp/context.ts`](src/acp/context.ts) for agent-driven codebase analysis.
- [`src/tutor/generator.ts`](src/tutor/generator.ts) for guide generation, although the full file was not included in the final readout here.
- [`src/realtime/chained.ts`](src/realtime/chained.ts#L1) for the STT → chat → TTS pipeline.

## Architecture Map

A useful way to think about the system is:

1. `extension.ts` coordinates startup, commands, caching, and selection of agent/context.
2. `acp/registry.ts` discovers usable ACP agents on the local machine.
3. `acp/context.ts` spins up the selected agent, requests structured JSON about the repo, and parses it into `CodebaseContext`.
4. `interview/orchestrator.ts` uses that context to run the live interview.
5. `realtime/chained.ts` performs the conversational turn logic: transcribe audio, ask the chat model for the next interviewer turn, synthesize audio, and parse file-opening directives.
6. `ui/highlight.ts` opens the requested file and highlights the lines under discussion.
7. `ui/homeView.ts` renders the dashboard and mediates all UI actions, audio playback, and state updates.

The architecture deliberately separates “analyze the repo” from “run the interview.” That makes caching practical and lets the extension reuse context between sessions.

## One Core Flow

The main interview flow is implemented in [`src/extension.ts`](src/extension.ts#L68) and [`src/interview/orchestrator.ts`](src/interview/orchestrator.ts#L111).

1. `startInterview()` checks for a workspace, loads config, and refreshes discovered agents if needed.
2. It looks for a cached session via `sessionStore`, and if present lets the user resume, reuse analysis, or re-analyze.
3. It picks an ACP agent from the discovered set.
4. If no cached context exists, it calls `gatherCodebaseContext()` to ask the agent for a JSON summary of the codebase.
5. It optionally enriches that summary with recent Codex CLI history from `~/.codex/sessions`.
6. It saves the analyzed session for reuse.
7. `InterviewOrchestrator.start()` creates the chained voice provider, validates STT/chat keys, and starts PortAudio mic capture.
8. When the user finishes speaking, the mic emits a recording, which is transcribed, sent to chat, and converted into the next interviewer turn.
9. If the model includes `<open_file>...`, the orchestrator opens the file and highlights the requested lines.
10. TTS audio is played through the webview, and the session transcript is persisted after each turn.

That flow is half-duplex by design: the mic pauses while the assistant is speaking so the assistant does not hear its own output.

## Essential Setup

Based on the source and README, the minimum viable setup is:

- Open a workspace folder in VS Code.
- Have at least one supported ACP agent available on the machine. The built-in registry currently supports Codex and Devin, and custom agents can be configured in settings.
- Provide STT and chat API keys. The defaults point to OpenRouter-compatible endpoints.
- Provide a TTS endpoint. The defaults point to a local Kokoro FastAPI-compatible endpoint.
- Have PortAudio working for microphone capture via `naudiodon2`.

The extension also exposes settings for agent selection, agent-specific configs, audio device selection, silence timing, STT/TTS model and voice, interview difficulty, and guide depth. Since the build and packaging files were not part of the curated view, I cannot verify installation or release steps beyond what the extension and README imply.

## Key Files

- [`src/extension.ts`](src/extension.ts#L23): activation, command wiring, session reuse, guide creation, mic/speaker tests.
- [`src/interview/orchestrator.ts`](src/interview/orchestrator.ts#L55): owns the interview state machine and turn-taking.
- [`src/realtime/chained.ts`](src/realtime/chained.ts#L1): implements STT, chat, TTS, file-open parsing, and transcript state.
- [`src/acp/registry.ts`](src/acp/registry.ts#L1): discovers built-in and custom ACP agents and probes their capabilities.
- [`src/acp/context.ts`](src/acp/context.ts#L1): launches an ACP agent, requests structured codebase context, and parses JSON output.
- [`src/ui/homeView.ts`](src/ui/homeView.ts#L28): webview state, agent selection, audio device UI, transcript/event display, and playback bridge.
- [`src/ui/highlight.ts`](src/ui/highlight.ts#L25): opens files and applies line-range highlighting.
- [`src/audio/portAudioMic.ts`](src/audio/portAudioMic.ts#L1): microphone capture and voice activity detection.
- [`src/interview/sessionStore.ts`](src/interview/sessionStore.ts#L1): cached analysis and transcript persistence.
- [`src/config.ts`](src/config.ts#L1): settings loading and env-var fallback for API keys.

## Unknowns and Limitations

- The curated view did not include build scripts, package manager lockfiles, CI, or release infrastructure, so I did not infer how the extension is built, packaged, or published.
- `src/tutor/generator.ts` was referenced by the main entrypoint, but the file contents were not available in the final inspected set, so the guide-generation internals remain partially opaque.
- The realtime provider files are present, but the main interview flow currently uses the chained HTTP-based path; the broader realtime integration appears auxiliary and is not fully traceable from the provided files alone.
- The README mentions marketplace release automation, but the underlying workflow file was not included, so those details are intentionally not expanded here.
- The code contains multiple external dependencies on local machine state and services, but only the ones directly visible in source were documented above.
