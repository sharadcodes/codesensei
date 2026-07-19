import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger';

/**
 * Best-effort read-only enrichment from the user's own Codex CLI history.
 *
 * IMPORTANT: per the ACP spec's own guidance, we never attempt to protocol-
 * resume (`session/load` / `session/resume`) a session that wasn't started by
 * our own `AcpClient` — doing so with a third-party session (like the raw
 * Codex CLI rollout files below) would mislead the agent about available
 * tools/capabilities. We only ever read these files as plain inert text.
 */

export interface CodexSessionRef {
  path: string;
  lastActive: Date;
}

function codexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/** Recursively find rollout-*.jsonl files under ~/.codex/sessions (bounded depth). */
function findJsonlFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findJsonlFiles(full, depth + 1, out);
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Read the first line of a rollout file to find its recorded `cwd`, if present. */
function readCwdFromFirstLine(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, bytesRead).toString('utf8');
    const firstLine = chunk.split('\n')[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return parsed?.cwd ?? parsed?.payload?.cwd ?? null;
  } catch {
    return null;
  }
}

/**
 * Find recent Codex CLI sessions whose recorded cwd matches (or is an
 * ancestor/descendant of) the given workspace root. Never throws; returns
 * an empty array if ~/.codex doesn't exist or nothing matches.
 */
export function findRecentCodexSessions(workspaceRoot: string, limit = 3): CodexSessionRef[] {
  const dir = codexSessionsDir();
  if (!fs.existsSync(dir)) return [];

  try {
    const files = findJsonlFiles(dir);
    const normalizedRoot = path.resolve(workspaceRoot);

    const matches: CodexSessionRef[] = [];
    for (const file of files) {
      const cwd = readCwdFromFirstLine(file);
      if (!cwd) continue;
      const normalizedCwd = path.resolve(cwd);
      if (normalizedCwd !== normalizedRoot) continue;
      try {
        const stat = fs.statSync(file);
        matches.push({ path: file, lastActive: stat.mtime });
      } catch {
        /* skip unreadable file */
      }
    }

    matches.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
    return matches.slice(0, limit);
  } catch (e) {
    logger.log(`[codexHistory] scan failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Extract a bounded amount of readable text (user + agent messages) from a
 * rollout JSONL file, for use as plain context enrichment. Never throws.
 */
export function extractRelevantText(sessionPath: string, maxChars = 4000): string {
  try {
    const raw = fs.readFileSync(sessionPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const parts: string[] = [];

    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      // Rollout entries commonly look like { type: 'event_msg', payload: { type: 'user_message'|'agent_message', message } }
      const payload = entry?.payload ?? entry;
      const kind = payload?.type;
      const text: string | undefined = payload?.message ?? payload?.text;
      if (!text) continue;
      if (kind === 'user_message' || kind === 'agent_message' || kind === 'assistant_message') {
        parts.push(`[${kind}] ${text}`);
      }
    }

    const joined = parts.join('\n');
    return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  } catch (e) {
    logger.log(`[codexHistory] extract failed for ${sessionPath}: ${(e as Error).message}`);
    return '';
  }
}
