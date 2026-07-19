# CodeSensei landing page

An independent Next.js landing page for the CodeSensei VS Code extension. It uses the cream-paper engineering-notebook direction in the repository's `DESIGN.md`, Astryx core components and neutral theme, and verified product behavior from the extension's current development history.

## Local development

Requirements: Node.js 20.9 or newer and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Production verification:

```bash
npm run typecheck
npm run lint
npm run build
npm run start
```

## Vercel

Import the existing repository and use these settings:

- Framework preset: Next.js
- Root directory: `codesensei-landing-page`
- Install command: `npm install` (or leave the Vercel default)
- Build command: `npm run build`
- Output directory: leave blank; Next.js manages it
- Node.js: 20.x or newer

The site is statically rendered and needs no environment variables, backend, database, analytics, or external assets.

## Content maintenance

Setup-guide content lives in `content/setup.ts`. The public installation link and detailed provider walkthrough remain deliberately incomplete until verified targets and final instructions are supplied. No public repository URL is linked because none is declared in the extension's root `package.json`.
