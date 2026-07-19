Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.

I’ll inspect only the curated files and ground the guide in verified source references.# Codebase Tutor Guide

## Purpose

Codebase Tutor is a VS Code extension for learning an unfamiliar repository and then testing that understanding through a live, voice-driven “Ask Me Anything” session. It uses an Agent Client Protocol (ACP) agent to inspect the open workspace and produce structured context: a project summary, important files, and knowledge-check topics tied to source ranges. A voice model then asks questions while the extension opens and highlights the relevant code. The extension can also generate a standalone `CODEBASE_TUTOR.md` onboarding guide. See [README.md](README.md) and the registered commands in [package.json](package.json#L20).

## Stack

This is a TypeScript extension targeting VS Code 1.90 or newer. Its extension-host bundle is exposed as `dist/extension.js`; the declared build uses esbuild to produce CommonJS for Node 18. TypeScript performs static checking, while `@types/vscode` and `@types/node` provide host APIs. Runtime dependencies are deliberately small:

- `ws` implements the OpenAI-compatible Realtime WebSocket client.
- `naudiodon2` supports PortAudio microphone capture in chained voice mode.
- Node child processes launch ACP agents, `ffmpeg`, and `ffplay`.
- VS Code APIs provide commands, configuration, the Home webview, file opening, selections, and decorations.

These facts come directly from [package.json](package.json#L317); no broader build or deployment environment was available for inspection.

## Entry points

The manifest activates the extension after VS Code startup and points to `dist/extension.js` as its runtime entry. It contributes commands for starting and stopping interviews, refreshing agents, testing audio, showing logs, and generating a guide ([package.json](package.json#L16)).

The source entry point is [`activate`](src/extension.ts#L20) in [src/extension.ts](src/extension.ts). It initializes logging and agent configuration storage, registers the Home webview, and binds manifest command IDs to their handlers. The same file owns the top-level lifecycle for interview and guide operations, including cancellation and cleanup.

For interviews, begin with [`startInterview`](src/extension.ts#L64). For generated documentation, begin with [`createTutorGuide`](src/extension.ts#L190).

## Architecture map

The code is organized into five cooperating areas:

1. **Extension shell and UI:** [src/extension.ts](src/extension.ts) coordinates commands and lifecycle. [src/ui/homeView.ts](src/ui/homeView.ts) presents state and user controls. [src/ui/highlight.ts](src/ui/highlight.ts#L29) resolves a requested path, opens it, selects the requested range, centers it, and applies a persistent decoration.

2. **ACP integration:** [src/acp/registry.ts](src/acp/registry.ts#L53) declares built-in Codex and Devin launch specifications, checks whether their launchers are on `PATH`, and probes ACP capabilities. Custom stdio agents can also be supplied through settings. [src/acp/client.ts](src/acp/client.ts) manages the child process and ACP request/response protocol.

3. **Context and guide generation:** [src/acp/context.ts](src/acp/context.ts#L21) asks an ACP agent for structured JSON and normalizes it into `CodebaseContext`. [src/tutor/generator.ts](src/tutor/generator.ts#L45) creates a curated analysis workspace and asks the selected agent for Markdown while enforcing read-only Codex settings.

4. **Interview coordination:** [src/interview/orchestrator.ts](src/interview/orchestrator.ts#L76) turns codebase context into interview instructions, manages voice state, dispatches file-opening tool calls, counts questions, and performs cleanup.

5. **Voice and audio adapters:** [src/realtime/provider.ts](src/realtime/provider.ts#L41) defines the Realtime provider contract. [src/realtime/openai.ts](src/realtime/openai.ts#L22) implements it over WebSocket. Audio capture and playback live under `src/audio/`, while [src/realtime/chained.ts](src/realtime/chained.ts) provides the separate STT/chat/TTS path.

## Core flow: starting a realtime interview

A command invokes `runInterview`, which creates a cancellable operation and delegates to `startInterview`. The extension requires an open workspace, loads configuration, refreshes agent discovery if necessary, and asks the user to choose an agent ([src/extension.ts](src/extension.ts#L50)).

When the agent is launchable, `gatherCodebaseContext` starts an `AcpClient`, initializes an ACP session, and requests minified JSON containing a summary, files, and topics. Streaming message chunks are accumulated and parsed; malformed or unstructured output degrades to a plain summary with empty file and topic lists ([src/acp/context.ts](src/acp/context.ts#L21)).

The resulting context enters `InterviewOrchestrator.start`. In `auto` mode, the presence of a realtime API key selects realtime mode; otherwise chained mode is selected ([src/interview/orchestrator.ts](src/interview/orchestrator.ts#L102)). Realtime mode embeds up to 20 topics and 30 important files in the evaluator instructions and registers two model tools: `open_file` and `end_interview`.

The WebSocket provider configures voice, audio formats, turn detection, instructions, and tools ([src/realtime/openai.ts](src/realtime/openai.ts#L62)). Microphone PCM chunks are forwarded to the provider, returned audio chunks are sent to playback, and speech events update the UI state. Before asking about concrete code, the model calls `open_file`; the orchestrator validates its arguments, calls `openAndHighlight`, reports the result to the model, and increments the question count ([src/interview/orchestrator.ts](src/interview/orchestrator.ts#L227)). Cancellation or `end_interview` terminates the session and releases resources.

## Essential setup

Based only on the inspected manifest and README:

1. Use VS Code 1.90 or newer.
2. Install project dependencies using the package manager implied by the available `npm` scripts.
3. Ensure `ffmpeg` is available on `PATH`; `ffplay` is preferred for streamed playback.
4. Ensure at least one ACP agent launcher is available. Built-in discovery currently probes Codex through `npx -y @agentclientprotocol/codex-acp` and Devin through `devin acp` ([src/acp/registry.ts](src/acp/registry.ts#L53)).
5. Configure either a Realtime API key or the STT, chat, and TTS settings needed by chained mode.
6. Run the declared `build`, `typecheck`, and `test` scripts as appropriate. The source view did not include the referenced `scripts/` files, so their internal behavior cannot be verified beyond the commands in [package.json](package.json#L317).

## Key files

- [src/extension.ts](src/extension.ts) — activation, commands, cancellation, and top-level workflows.
- [src/interview/orchestrator.ts](src/interview/orchestrator.ts) — central interview state machine and voice-mode selection.
- [src/acp/client.ts](src/acp/client.ts) — ACP child-process transport and session operations.
- [src/acp/context.ts](src/acp/context.ts) — structured repository-context request and parsing.
- [src/acp/registry.ts](src/acp/registry.ts) — agent definitions, discovery, and capability probing.
- [src/realtime/provider.ts](src/realtime/provider.ts) — provider abstraction and event contract.
- [src/realtime/openai.ts](src/realtime/openai.ts) — OpenAI-compatible Realtime protocol implementation.
- [src/ui/highlight.ts](src/ui/highlight.ts) — editor navigation and source-range highlighting.

## Unknowns and limitations

This guide was produced from a curated, read-only subset. No TypeScript configuration, lockfile, test implementations, native-copy script, packaging assets, CI configuration, release automation, or deployment files were available. Consequently, exact installation reproducibility, compiler strictness, supported host platforms in practice, test coverage, native-module packaging, and release procedures cannot be established.

The manifest declares commands that reference files outside the curated view, and audio behavior may depend on OS tools and permissions that source inspection cannot validate. External ACP agents and OpenAI-compatible endpoints were not executed, so interoperability and currently accepted model identifiers remain unverified.
