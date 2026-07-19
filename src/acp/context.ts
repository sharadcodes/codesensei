import * as vscode from 'vscode';
import { AcpClient } from './client';
import { DiscoveredAgent } from './registry';
import { CodebaseContext, InterviewFile, InterviewTopic } from '../types';
import { AgentConfig } from './agentConfig';

export interface GatherOptions {
  cwd: string;
  agent: DiscoveredAgent;
  contextPrompt: string;
  agentConfig?: AgentConfig;
  onProgress?: (msg: string) => void;
  onAgentMessage?: (text: string) => void;
  token?: vscode.CancellationToken;
}

/**
 * Spins up the ACP agent, asks it to produce a structured interview-relevant
 * summary of the codebase, and parses the JSON result.
 */
export async function gatherCodebaseContext(opts: GatherOptions): Promise<CodebaseContext> {
  if (!opts.agent.resolved) {
    throw new Error(`Agent "${opts.agent.name}" has no resolvable launch command on this platform.`);
  }
  const client = new AcpClient(opts.agent.resolved, opts.cwd, opts.agentConfig);
  let collected = '';
  client.on('log', (l) => {
    const s = typeof l === 'string' ? l.trim() : String(l);
    if (s) opts.onProgress?.(`[agent log] ${s}`);
  });
  client.on('update', (u) => {
    if (u.update?.sessionUpdate === 'agent_message_chunk' && u.update.content?.text) {
      collected += u.update.content.text;
      opts.onAgentMessage?.(u.update.content.text);
    } else if (u.update?.sessionUpdate === 'tool_call') {
      opts.onProgress?.(`[tool] ${u.update.title ?? u.update.kind ?? 'running'}`);
    } else if (u.update?.sessionUpdate === 'plan') {
      opts.onProgress?.('[plan] agent is planning...');
    }
  });

  await client.start();
  try {
    let sessionId: string;
    try {
      await client.initialize();
    } catch (e) {
      throw new Error(`ACP initialize failed: ${(e as Error).message}`);
    }
    try {
      sessionId = await client.newSession(opts.cwd, []);
    } catch (e) {
      throw new Error(`ACP session/new failed: ${(e as Error).message}`);
    }
    const prompt = [
      { type: 'text', text: opts.contextPrompt },
      {
        type: 'text',
        text: 'Return ONLY valid minified JSON (no prose, no markdown fences) with the schema described above. Use repo-relative file paths.',
      },
    ];
    try {
      await client.prompt(sessionId, prompt);
    } catch (e) {
      throw new Error(`ACP session/prompt failed: ${(e as Error).message}`);
    }
    await client.closeSession(sessionId);
  } finally {
    await client.dispose();
  }

  return parseContext(collected, opts.cwd);
}

export function parseContext(raw: string, cwd: string): CodebaseContext {
  const json = extractJson(raw);
  if (json) {
    try {
      const parsed = JSON.parse(json) as Partial<CodebaseContext>;
      return {
        summary: parsed.summary ?? raw.slice(0, 500),
        files: (parsed.files ?? []).map(normalizeFile),
        topics: (parsed.topics ?? []).map(normalizeTopic),
      };
    } catch {
      /* fall through */
    }
  }
  return {
    summary: raw.slice(0, 2000) || 'No structured summary returned.',
    files: [],
    topics: [],
  };
}

function normalizeFile(f: Partial<InterviewFile>): InterviewFile {
  return { path: String(f.path ?? ''), role: String(f.role ?? '') };
}

function normalizeTopic(t: Partial<InterviewTopic>): InterviewTopic {
  return {
    title: String(t.title ?? 'Untitled topic'),
    filePath: String(t.filePath ?? (t as { path?: unknown }).path ?? ''),
    lineStart: Number(t.lineStart ?? 1),
    lineEnd: Number(t.lineEnd ?? t.lineStart ?? 1),
    rationale: String(t.rationale ?? ''),
  };
}

function extractJson(text: string): string | null {
  if (!text) return null;
  // Strip markdown fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  // Find first { ... last }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return null;
}
