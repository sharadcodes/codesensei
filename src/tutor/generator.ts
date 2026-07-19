import * as vscode from 'vscode';
import { AcpClient } from '../acp/client';
import { AgentConfig } from '../acp/agentConfig';
import { DiscoveredAgent } from '../acp/registry';
import { BuildAccess, createAnalysisWorkspace } from './sourcePolicy';

export type ExplanationMode = 'quick' | 'guided' | 'deep';

export interface TutorGuideOptions {
  cwd: string;
  agent: DiscoveredAgent;
  agentConfig?: AgentConfig;
  mode: ExplanationMode;
  buildAccess: BuildAccess;
  token?: vscode.CancellationToken;
  onProgress?: (message: string) => void;
}

const MODE_GUIDANCE: Record<ExplanationMode, string> = {
  quick: 'Create a focused 700-1100 word overview: purpose, stack, entry points, architecture map, one core flow, essential setup, 5-8 key files, and unknowns.',
  guided: 'Create a 1600-2200 word guided walkthrough: major modules, responsibilities, data/control flow, setup, conventions, one representative workflow, key files, safe first changes, and unknowns.',
  deep: 'Create a selective 2800-4000 word deep dive: architecture and module interactions, important abstractions, rich workflow tracing, configuration implications, testing approach, conventions, risks, key files, and safe first changes.',
};

function buildPrompt(mode: ExplanationMode, buildAccess: BuildAccess, projectType: string, files: string[]): string {
  return `You are a senior engineer onboarding someone to this repository. Create a trustworthy Markdown guide titled "CodeSensei Guide".

DEPTH: ${MODE_GUIDANCE[mode]}
PROJECT TYPE: ${projectType}
ACCESS: ${buildAccess === 'source-only' ? 'Source code only. Do not infer build, deployment, or infrastructure details. Explicitly note limitations where those files were withheld.' : 'Source plus approved build/configuration files.'}

The host created a curated, read-only analysis view containing only these permitted files:
${files.map((file) => `- ${file}`).join('\n')}

Rules:
- Inspect only files in this curated working directory. Never search parent or absolute paths.
- Ground every technical claim in inspected files. Never invent commands, environment variables, services, or architecture.
- Focus on representative entry points and core application flow, not exhaustive file listings.
- Link references using original repo-relative Markdown paths and add line numbers only when verified.
- Do not expose secrets or reproduce large source passages.
- Include an "Unknowns and limitations" section.
- Return only the complete Markdown document without a fenced code block.`;
}

export async function generateTutorGuide(opts: TutorGuideOptions): Promise<string> {
  if (!opts.agent.resolved) throw new Error(`Agent "${opts.agent.name}" has no launch command on this platform.`);
  if (opts.token?.isCancellationRequested) throw new vscode.CancellationError();

  opts.onProgress?.('Selecting relevant source files…');
  const analysis = await createAnalysisWorkspace(opts.cwd, opts.buildAccess);
  if (!analysis.files.length) {
    await analysis.cleanup();
    throw new Error('No eligible source files were found for analysis.');
  }

  const readOnlyConfig: AgentConfig = { ...opts.agentConfig };
  if (opts.agent.id === 'codex') {
    readOnlyConfig.agentMode = 'read-only';
    readOnlyConfig.sandboxMode = 'read-only';
  }
  const client = new AcpClient(opts.agent.resolved, analysis.cwd, readOnlyConfig);
  let markdown = '';
  let sessionId: string | undefined;
  let cancelled = false;
  const cancellation = opts.token?.onCancellationRequested(() => {
    cancelled = true;
    if (sessionId) void client.cancel(sessionId);
    setTimeout(() => { if (cancelled) void client.dispose(new vscode.CancellationError()); }, 1500);
  });
  client.on('log', (entry) => {
    const message = typeof entry === 'string' ? entry.trim() : String(entry);
    if (message) opts.onProgress?.(message);
  });
  client.on('update', (update) => {
    if (update.update?.sessionUpdate === 'agent_message_chunk' && update.update.content?.text) markdown += update.update.content.text;
    else if (update.update?.sessionUpdate === 'tool_call') opts.onProgress?.(update.update.title ?? 'Inspecting repository…');
    else if (update.update?.sessionUpdate === 'plan') opts.onProgress?.('Mapping the codebase…');
  });

  try {
    await client.start();
    await client.initialize();
    if (cancelled) throw new vscode.CancellationError();
    sessionId = await client.newSession(analysis.cwd, []);
    await client.prompt(sessionId, [{ type: 'text', text: buildPrompt(opts.mode, opts.buildAccess, analysis.projectType, analysis.files) }]);
    if (cancelled) throw new vscode.CancellationError();
    await client.closeSession(sessionId);
  } finally {
    cancellation?.dispose();
    await client.dispose(cancelled ? new vscode.CancellationError() : undefined);
    await analysis.cleanup();
  }

  const cleaned = stripMarkdownFence(markdown).trim();
  if (!cleaned || cleaned.length < 200) throw new Error('The agent did not return a complete codebase guide. Try another agent or refresh and retry.');
  return cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`;
}

function stripMarkdownFence(value: string): string {
  const fenced = value.match(/^```(?:markdown|md)?\s*([\s\S]*?)```\s*$/i);
  return fenced ? fenced[1] : value;
}
