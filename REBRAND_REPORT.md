# CodeSensei Rebrand Report

> **Date:** 2026-07-19  
> **Rebrand:** `Codebase Tutor` / `interview-lele` → `CodeSensei` / `codesensei`  
> **Repo:** https://github.com/sharadcodes/codesensei  
> **Authors:** Sharad Maurya, Savitha Gollamudi, Nabina Poudel

---

## 1. Overview

This document records every change made during the full rebrand of the VS Code extension from **"Codebase Tutor"** (internal codename `interview-lele`) to **"CodeSensei"** (package name `codesensei`), plus the logo processing, UI refinements, and marketplace readiness work.

---

## 2. Identity Renaming

### 2.1 Package & Publisher

| Field | Before | After |
| --- | --- | --- |
| `name` | `codebase-tutor` | `codesensei` |
| `displayName` | `Codebase Tutor` | `CodeSensei` |
| `publisher` | `codebase-tutor` | `sharadcodes` |
| `description` | "Learn a codebase with AI, then use Knowledge Check..." | "Learn any codebase with AI, then test your understanding through a live, voice-driven Knowledge Check session." |

### 2.2 Command IDs

| Before | After |
| --- | --- |
| `interviewLele.startInterview` | `codeSensei.startInterview` |
| `interviewLele.stopInterview` | `codeSensei.stopInterview` |
| `interviewLele.showLogs` | `codeSensei.showLogs` |
| `interviewLele.refreshAgents` | `codeSensei.refreshAgents` |
| `interviewLele.testMic` | `codeSensei.testMic` |
| `interviewLele.testSpeaker` | `codeSensei.testSpeaker` |
| `interviewLele.clearSession` | `codeSensei.clearSession` |
| `codebaseTutor.generateGuide` | `codeSensei.generateGuide` |

All command titles updated from `Codebase Tutor: ...` → `CodeSensei: ...`.

### 2.3 Configuration Namespace

All settings keys renamed from `interviewLele.*` → `codeSensei.*`:

- `codeSensei.stt.*` (baseUrl, model, apiKey, path, language)
- `codeSensei.tts.*` (baseUrl, model, apiKey, voice, path, responseFormat)
- `codeSensei.chat.*` (baseUrl, model, apiKey, path)
- `codeSensei.audio.*` (inputDeviceId, silenceSeconds, beepEnabled)
- `codeSensei.acp.*` (selectedAgentId, agentConfigs, contextPrompt, customAgents)
- `codeSensei.interview.*` (maxQuestions, difficulty)
- `codeSensei.tutor.explanationMode`

### 2.4 View & Activity Bar IDs

| Before | After |
| --- | --- |
| View container ID: `interviewLele` | `codeSensei` |
| View ID: `interviewLele.home` | `codeSensei.home` |
| Activity bar title: `Codebase Tutor` | `CodeSensei` |
| Activity bar icon: `media/icon.svg` (mic) | `media/codesensei-logo.svg` (speech bubble + ?) |

### 2.5 Other Internal IDs

| Before | After |
| --- | --- |
| ACP clientInfo name: `codebase-tutor` | `codesensei` |
| ACP clientInfo title: `Codebase Tutor` | `CodeSensei` |
| Memento key: `interviewLele.agentConfigs` | `codeSensei.agentConfigs` |
| Config key: `interviewLele.acp.agentConfigs` | `codeSensei.acp.agentConfigs` |
| Output channel: `Codebase Tutor` | `CodeSensei` |
| Guide filename: `CODEBASE_TUTOR.md` | `CODESENSEI.md` |
| Guide prompt title: `Codebase Tutor Guide` | `CodeSensei Guide` |
| Temp dir prefix: `codebase-tutor-analysis-` | `codesensei-analysis-` |
| Test temp prefix: `codebase-tutor-policy-test-` | `codesensei-policy-test-` |
| Test bundle prefix: `codebase-tutor-source-policy-` | `codesensei-source-policy-` |

### 2.6 Landing Page (`site/`)

| Before | After |
| --- | --- |
| Package name: `codebase-tutor-landing-page` | `codesensei-landing-page` |
| Setup guide label: `codebase-tutor/setup` | `codesensei/setup` |
| Vercel root dir: `codebase-tutor-landing-page` | `codesensei-landing-page` |

---

## 3. Files Modified

### Source files (renamed identifiers + display text)

| File | Changes |
| --- | --- |
| `package.json` | name, publisher, displayName, description, repository, homepage, bugs, keywords, icon, galleryBanner, badges, all command IDs/titles, view container/view IDs, all config keys, package script |
| `package-lock.json` | name field |
| `src/extension.ts` | all command registrations, config getConfiguration calls, display strings, guide filename, output channel references |
| `src/ui/homeView.ts` | viewType, all config getConfiguration calls, command executeCommand calls, display strings, output channel name, logo inlining, credits row, link handler |
| `src/config.ts` | all getConfiguration calls (`interviewLele` → `codeSensei`) |
| `src/interview/orchestrator.ts` | config getConfiguration call, error messages |
| `src/acp/agentConfigUi.ts` | CONFIG_KEY, MEMENTO_KEY, all getConfiguration calls, all display strings |
| `src/acp/registry.ts` | ACP clientInfo name + title |
| `src/logger.ts` | output channel name + doc comment |
| `src/tutor/sourcePolicy.ts` | temp dir prefix |
| `src/tutor/generator.ts` | guide prompt title |
| `scripts/source-policy.test.mjs` | temp dir + bundle prefixes |

### Documentation & metadata

| File | Changes |
| --- | --- |
| `README.md` | Full rewrite: marketplace-ready with features, config tables matching actual settings, commands table, architecture section, credits |
| `LICENSE` | Copyright holder → "Sharad Maurya, Savitha Gollamudi, and Nabina Poudel" |
| `CHANGELOG.md` | New file — Keep a Changelog format, v0.1.0 entry |
| `.vscodeignore` | Excluded `site/**`, debug files, unused logo sizes, source PNG, CHANGELOG |

### Landing page

| File | Changes |
| --- | --- |
| `site/package.json` | name → `codesensei-landing-page` |
| `site/package-lock.json` | name → `codesensei-landing-page` |
| `site/app/components/SetupGuide.tsx` | label → `codesensei/setup` |
| `site/README.md` | Vercel root dir → `codesensei-landing-page` |

---

## 4. Logo Processing

### 4.1 Source

Original: `ChatGPT Image Jul 19, 2026, 09_06_14 PM.png` (1254×1254, B/W speech bubble with question mark cutout)

### 4.2 Processing (`scripts/process_logo.py`)

1. **White background removal** — threshold at gray < 128, morphological open/close cleanup
2. **Anti-aliasing halo fix** — distance-transform alpha re-anti-aliasing with pure black RGB (no gray fringe)
3. **Question mark preservation** — `cv2.findContours` with `RETR_CCOMP` (captures holes) + SVG `fill-rule="evenodd"`
4. **SVG tracing** — `cv2.approxPolyDP` contour simplification, all subpaths combined into single `<path>` with evenodd fill

### 4.3 Generated files

| File | Purpose |
| --- | --- |
| `media/codesensei-logo.svg` | Full-res vector (1254×1254 viewBox, currentColor, evenodd) — used in webview header (inlined for theme adaptation) and activity bar icon |
| `media/codesensei-logo.png` | Full-res transparent PNG (1254×1254) |
| `media/codesensei-logo-{16,32,48,64,128,256,512,1024}.png` | Resized PNGs for various use cases |
| `media/codesensei-logo.ico` | Multi-size ICO (16–256) for Windows app icon |
| `logo.png` | Copy at repo root for VSIX `icon` field |
| `media/icon.svg` | Simplified 16×16 hand-crafted icon (kept as fallback, not used) |

### 4.4 UI integration

- **Activity bar:** `package.json` → `"icon": "media/codesensei-logo.svg"`
- **Webview header:** SVG file read at runtime and inlined into HTML so `fill="currentColor"` inherits the theme's foreground color (white in dark theme, black in light theme)
- **No background/gradient** on the logo — renders as-is

---

## 5. UI Additions

### 5.1 Credits row

Added below the header in the webview:

```
Built with ❤ by sharadcodes · g-savitha · iamnabina
```

- GitHub profile links open in system browser via `vscode.env.openExternal`
- Single delegated click handler with `e.stopPropagation()` to prevent double-firing
- Emoji font fallback chain: `Segoe UI Emoji`, `Apple Color Emoji`, `Noto Color Emoji`

### 5.2 External link handler

- `onMessage` case `openExternal` → `vscode.env.openExternal(vscode.Uri.parse(m.url))`
- CSP unchanged (no `img-src` needed since SVG is inlined, not loaded as `<img>`)

---

## 6. Marketplace Readiness

### 6.1 `package.json` best practices added

- `repository` (type + URL)
- `homepage`
- `bugs` (URL)
- `keywords` (11 search terms)
- `icon` (logo.png at root)
- `galleryBanner` (dark theme, #1a1a2e)
- `badges` (built-with-love shield)
- Removed `--allow-missing-repository` from package script

### 6.2 `.vscodeignore` optimized

Excluded: `site/**`, source files, debug files, unused logo sizes, sourcemaps, TypeScript files, lock files, CHANGELOG. Final VSIX: **18 files, 890 KB**.

### 6.3 README.md

Full rewrite with:
- Centered header with tagline and credits
- Overview, Features (Code Tutor Guide + Knowledge Check)
- Requirements (VS Code, ACP agent, STT/TTS/chat keys, PortAudio)
- Quick Start (7 steps)
- Configuration tables (6 sections, all matching actual `codeSensei.*` settings)
- Commands table (8 commands)
- Architecture section
- License link

### 6.4 CHANGELOG.md

New file in Keep a Changelog format with v0.1.0 entry listing all added features.

### 6.5 LICENSE

Copyright updated to: `Sharad Maurya, Savitha Gollamudi, and Nabina Poudel`

---

## 7. Verification Results

| Check | Result |
| --- | --- |
| `npm run typecheck` | ✅ Pass (0 errors) |
| `npm run build` | ✅ Pass (162 KB bundle) |
| `npm test` (webview syntax + source policy) | ✅ Pass (3/3 tests) |
| `npm run package` | ✅ Pass (890 KB, 18 files, no warnings) |
| Grep for old names (`interview-lele`, `interviewLele`, `codebase-tutor`, `codebaseTutor`, `Codebase Tutor`, `CODEBASE_TUTOR`) | ✅ Zero matches |
| Git remote | ✅ Points to `https://github.com/sharadcodes/codesensei.git` |

---

## 8. Publishing Steps

### Step 1: Create a VS Code Marketplace Publisher

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with the Microsoft account you want to publish under
3. Click **Create Publisher** if you don't have one
4. Set publisher ID to `sharadcodes` (must match `package.json`)
5. Complete the verification email

### Step 2: Get a Personal Access Token (PAT)

1. Go to https://dev.azure.com
2. Sign in with the same Microsoft account
3. Create an organization if prompted (any name, e.g. `sharadcodes`)
4. Go to **User Settings** (top-right icon) → **Personal access tokens**
5. Click **New Token**
6. Set:
   - **Name:** `vsce-publish`
   - **Organization:** `All accessible organizations`
   - **Expiration:** 1 year (or as needed)
   - **Scopes:** Click "Show all scopes" → find **Marketplace** → check **Acquire** and **Publish**
7. Click **Create** and **copy the token** (shown only once)

### Step 3: Login with vsce

```bash
npx vsce login sharadcodes
```

Paste the PAT when prompted. It is stored locally at `~/.vsce` for future publishes.

### Step 4: Test the VSIX locally

```bash
npm run package
code --install-extension codesensei-0.1.0.vsix --force
```

Reload VS Code and verify the extension works.

### Step 5: Publish to Marketplace

```bash
npx vsce publish
```

Or with the same flags used for packaging:

```bash
npx vsce publish --no-yarn --no-dependencies
```

### Step 6: Verify on Marketplace

- Extension page: `https://marketplace.visualstudio.com/items?itemName=sharadcodes.codesensei`
- Install via CLI: `code --install-extension sharadcodes.codesensei`
- First submission is reviewed by Microsoft (typically 1–2 business days)

### Step 7: Future updates

1. Bump `version` in `package.json` (follow semver)
2. Add a new entry to `CHANGELOG.md`
3. Commit and push to `https://github.com/sharadcodes/codesensei`
4. Run `npx vsce publish`
5. The update appears on the Marketplace within minutes (no review for updates)

---

## 9. Git Remote

```
origin  https://github.com/sharadcodes/codesensei.git (fetch)
        https://github.com/sharadcodes/codesensei.git (push)
```

Updated via `git remote set-url origin https://github.com/sharadcodes/codesensei.git`

---

## 10. Summary

The rebrand touched **22 files** across the codebase, landing page, and documentation. Every identifier — package name, publisher, command IDs, config namespace, view IDs, ACP client info, memento keys, output channels, guide filename, temp dir prefixes, and all user-facing display strings — was renamed from the old `Codebase Tutor` / `interview-lele` identity to `CodeSensei` / `codesensei`. The logo was processed from the source PNG into SVG + multi-size PNGs + ICO, with the question mark cutout preserved via evenodd fill rule. The extension is now marketplace-ready with proper metadata, README, CHANGELOG, and optimized VSIX packaging.
