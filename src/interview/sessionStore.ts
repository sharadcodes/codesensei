import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { CodebaseContext } from '../types';
import { ChainedTurn } from '../realtime/chained';
import { logger } from '../logger';

/** Persisted per-workspace interview session: codebase analysis + transcript so far. */
export interface StoredSession {
  workspaceRoot: string;
  analyzedAt: number;
  context: CodebaseContext;
  agentId: string;
  /** ACP sessionId from the analysis call, if any. Only meaningful if supportsAcpResume. */
  acpSessionId?: string;
  /** Whether the agent that produced acpSessionId advertised sessionCapabilities.resume. */
  supportsAcpResume: boolean;
  /** Git HEAD commit hash at analysis time, if available, for staleness detection. */
  gitHead?: string;
  transcript: ChainedTurn[];
}

function keyFor(workspaceRoot: string): string {
  return crypto.createHash('sha1').update(workspaceRoot).digest('hex');
}

function filePathFor(context: vscode.ExtensionContext, workspaceRoot: string): string {
  return path.join(context.globalStorageUri.fsPath, `session-${keyFor(workspaceRoot)}.json`);
}

export async function loadSession(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<StoredSession | null> {
  const fp = filePathFor(context, workspaceRoot);
  try {
    const uri = vscode.Uri.file(fp);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredSession;
    if (parsed.workspaceRoot !== workspaceRoot) return null;
    logger.log(`[sessionStore] Loaded cached session from ${fp}`);
    return parsed;
  } catch {
    logger.log(`[sessionStore] No cached session found at ${fp}`);
    return null;
  }
}

export async function saveSession(
  context: vscode.ExtensionContext,
  session: StoredSession
): Promise<void> {
  const fp = filePathFor(context, session.workspaceRoot);
  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const uri = vscode.Uri.file(fp);
    const bytes = Buffer.from(JSON.stringify(session, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(uri, bytes);
    logger.log(`[sessionStore] Saved session to ${fp}`);
  } catch (e) {
    logger.error(`[sessionStore] Failed to save session to ${fp}: ${(e as Error).message}`);
  }
}

export async function clearSession(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePathFor(context, workspaceRoot));
    await vscode.workspace.fs.delete(uri);
  } catch {
    /* ignore — nothing to clear */
  }
}
