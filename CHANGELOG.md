# Changelog

All notable changes to AI CodeSensei will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-07-20

### Fixed

- Code Tutor guide generation no longer fails with `EBUSY` on Windows when the ACP agent's temp analysis directory is cleaned up. The ACP client now waits for the agent subprocess to exit before cleanup, and the cleanup retries on `EBUSY`/`EPERM`/`ENOTEMPTY`.

## [0.2.1] - 2026-07-20

### Added

- GitHub Actions workflow to build per-platform VSIX artifacts on demand
- `scripts/verify-native-arch.mjs` to verify bundled native addon architecture before packaging
- `build:darwin-arm64` and `build:darwin-x64` npm scripts for from-source native rebuilds
- `package:darwin-arm64` and `package:darwin-x64` npm scripts for targeted VSIX packaging

### Fixed

- Microphone addon load error now reports the expected `platform-arch` and instructs users to reinstall the matching build instead of failing with a cryptic native error

## [0.2.0] - 2026-07-19

### Added

- CodeSensei rebrand: new name, logo, marketplace icon, and publisher identity
- Webview-based TTS/beep playback via AudioContext (replaces ffplay/ffmpeg dependency)
- Settings modal in the home view with toolkit.min.js and icons
- `tts.responseFormat` setting (wav/flac/ogg/mp3/opus) honored by the chained voice provider
- Per-size PNG logo assets, ICO, and simplified 16x16 activity bar icon
- Poppins and Space Mono fonts wired into the webview UI
- Credits row with GitHub profile links and external link handler

### Changed

- Renamed command IDs from `interviewLele.*` to `codeSensei.*`
- Renamed config namespace from `interviewLele` to `codeSensei`
- Updated README, LICENSE, and CHANGELOG to reflect the new product name

### Removed

- Realtime WebSocket mode (`src/realtime/openai.ts`, `src/realtime/provider.ts`, `src/audio/playback.ts`)
- ffmpeg/ffplay dependency for TTS playback

## [0.1.0] - 2026-07-19

### Added

- Voice-driven Knowledge Check session with real-time STT, LLM chat, and TTS
- Code Tutor guide generation (`CODESENSEI.md`) with three depth levels (Quick, Guided, Deep Dive)
- ACP agent discovery from the Agent Client Protocol registry
- PortAudio-based microphone capture with Voice Activity Detection (VAD)
- Automatic file opening and line-range highlighting during interviews
- Session caching and resume — re-analyze only when the codebase changes
- Codex CLI history enrichment for deeper codebase context
- Configurable STT, TTS, chat, audio, and ACP agent settings
- Microphone and speaker test commands
- Built-in settings panel with collapsible sections
- Custom fonts (Poppins + Space Mono) for a polished UI
- Light/dark theme adaptive logo and interface
