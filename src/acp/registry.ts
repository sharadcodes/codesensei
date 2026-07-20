import { spawn } from 'child_process';
import * as path from 'path';
import { RegistryAgent, ResolvedAgentCommand } from '../types';
import { logger } from '../logger';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Hardcoded list of ACP agents we support. We do NOT auto-install anything;
 * each entry must already be reachable on the user's system (PATH binary or
 * npx package). Capabilities are probed live by calling `initialize` on the
 * agent's ACP stdio interface.
 *
 * To add a new agent later, append an entry here.
 */
export interface BuiltinAgentSpec {
  id: string;
  name: string;
  description: string;
  /** How to launch the ACP stdio server. */
  launch: { cmd: string; args: string[] };
  /** Where to look for the binary on PATH (used for availability check). */
  pathProbe: string;
  /** Optional homepage / docs. */
  website?: string;
  /**
   * Agent-specific configuration options. These are NOT discoverable via the
   * ACP initialize handshake (the protocol only exposes auth/prompt/mcp/
   * session capabilities). They come from each CLI's documented flags and
   * env vars. Sourced from:
   *   - codex: https://github.com/agentclientprotocol/codex-acp (env vars)
   *           + https://developers.openai.com/codex/config-reference
   *   - devin: https://docs.devin.ai/cli/reference/commands
   *           + https://docs.devin.ai/cli/models
   */
  options?: AgentOptionSpec;
}

export interface AgentOptionSpec {
  /** Model ids the agent accepts. First entry is the default. */
  models?: string[];
  /** Reasoning effort levels (codex only). */
  reasoningEfforts?: string[];
  /** Permission / scope modes. Maps to INITIAL_AGENT_MODE (codex) or
   *  DEVIN_PERMISSION_MODE (devin). */
  permissionModes?: string[];
  /** Sandbox modes (codex only). */
  sandboxModes?: string[];
  /** Model provider ids (codex only, optional). */
  modelProviders?: string[];
}

export const BUILTIN_AGENTS: BuiltinAgentSpec[] = [
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex CLI via the @agentclientprotocol/codex-acp adapter.',
    launch: {
      cmd: IS_WINDOWS ? 'npx.cmd' : 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp'],
    },
    pathProbe: IS_WINDOWS ? 'npx.cmd' : 'npx',
    website: 'https://github.com/openai/codex',
    options: {
      // From https://developers.openai.com/codex/models — current recommended.
      // gpt-5.2 / gpt-5.3-codex are deprecated; list the live ones.
      models: ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini', 'o3', 'o4-mini'],
      // From codex config-reference: model_reasoning_effort
      reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      // codex-acp INITIAL_AGENT_MODE env var
      permissionModes: ['read-only', 'agent', 'agent-full-access'],
      // codex -s / --sandbox flag
      sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
      // codex-acp MODEL_PROVIDER env var
      modelProviders: ['openai', 'oss'],
    },
  },
  {
    id: 'devin',
    name: 'Devin',
    description: 'Cognition Devin CLI running its native `acp` subcommand.',
    launch: {
      cmd: IS_WINDOWS ? 'devin.exe' : 'devin',
      args: ['acp'],
    },
    pathProbe: IS_WINDOWS ? 'devin.exe' : 'devin',
    website: 'https://docs.devin.ai/desktop/acp',
    options: {
      // From https://docs.devin.ai/cli/models — short names resolve to latest.
      models: ['swe', 'swe-1-6-fast', 'opus', 'sonnet', 'gpt', 'codex', 'gemini', 'kimi', 'glm'],
      // From https://docs.devin.ai/cli/essential-commands — permission modes.
      // 'autonomous' requires --sandbox; listed for completeness.
      permissionModes: ['normal', 'accept-edits', 'bypass', 'autonomous'],
    },
  },
];

/** Capabilities reported by the agent's `initialize` response. */
export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean };
  sessionCapabilities?: {
    resume?: unknown;
    list?: unknown;
    close?: unknown;
    delete?: unknown;
    additionalDirectories?: unknown;
  };
  auth?: { logout?: unknown };
  providers?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface AgentInfo {
  name: string;
  title?: string;
  version: string;
}

export interface ProbedCapabilities {
  protocolVersion: number;
  agentInfo?: AgentInfo;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  _meta?: Record<string, unknown>;
  /** From session/new — live config options (model, reasoning, mode, etc.) */
  configOptions?: AcpConfigOption[];
  /** From session/new — available agent modes */
  modes?: { currentModeId?: string; availableModes?: AcpMode[] };
}

/** A config option advertised by the agent via session/new. */
export interface AcpConfigOption {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type: 'select' | 'boolean' | string;
  currentValue?: string | boolean;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

export interface AcpMode {
  id: string;
  name?: string;
  description?: string;
}

export interface DiscoveredAgent {
  id: string;
  name: string;
  description: string;
  website?: string;
  available: boolean;
  unavailableReason?: string;
  resolved?: ResolvedAgentCommand;
  /** Live capabilities from `initialize`. Present only after a successful probe. */
  capabilities?: ProbedCapabilities;
  /** Whether the probe has run. */
  probed: boolean;
  /** Agent-specific config options (models, reasoning, modes, sandbox). */
  options?: AgentOptionSpec;
}

/**
 * Discover the hardcoded agents. For each one:
 *   1. Check the launch binary is on PATH.
 *   2. If yes, spawn the ACP server, call `initialize`, capture capabilities.
 *   3. Tear down the process.
 *
 * No installation, no remote registry fetch.
 */
export async function discoverAgents(): Promise<DiscoveredAgent[]> {
  const out: DiscoveredAgent[] = [];
  for (const spec of BUILTIN_AGENTS) {
    out.push(await probeOne(spec));
  }
  return out;
}

/**
 * Discover built-in agents plus any user-defined custom agents from settings.
 * Custom agents are validated with initialize+session/new just like built-ins.
 */
export async function discoverAgentsWithCustom(custom: Array<{ id: string; name: string; command: string; args: string[] }>): Promise<DiscoveredAgent[]> {
  const out = await discoverAgents();
  for (const c of custom) {
    // Skip if id collides with a built-in
    if (out.some((a) => a.id === c.id)) continue;
    const spec: BuiltinAgentSpec = {
      id: c.id,
      name: c.name,
      description: `Custom ACP agent (${c.command})`,
      launch: { cmd: c.command, args: c.args ?? [] },
      pathProbe: c.command,
    };
    out.push(await probeOne(spec));
  }
  return out;
}

async function probeOne(spec: BuiltinAgentSpec): Promise<DiscoveredAgent> {
  const onPath = await isCommandOnPath(spec.pathProbe);
  if (!onPath) {
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      website: spec.website,
      options: spec.options,
      available: false,
      unavailableReason: `"${spec.pathProbe}" not found on PATH. Install ${spec.name} first (e.g. npm i -g @openai/codex or the Devin CLI).`,
      probed: false,
    };
  }

  const shell = IS_WINDOWS && /\.cmd$/i.test(spec.launch.cmd);
  const resolved: ResolvedAgentCommand = {
    cmd: spec.launch.cmd,
    args: spec.launch.args,
    shell,
    distributionType: 'binary',
  };

  // Probe capabilities via initialize + session/new
  let capabilities: ProbedCapabilities | undefined;
  try {
    capabilities = await probeInitializeAndSession(resolved);
    logger.log(`Probed ${spec.id}: agentInfo=${capabilities?.agentInfo?.title ?? capabilities?.agentInfo?.name ?? spec.name} v${capabilities?.agentInfo?.version ?? '?'}`);
    if (capabilities.configOptions?.length) {
      logger.log(`  ${spec.id} configOptions: ${capabilities.configOptions.map((o) => o.id).join(', ')}`);
    }
    if (capabilities.modes?.availableModes?.length) {
      logger.log(`  ${spec.id} modes: ${capabilities.modes.availableModes.map((m) => m.id).join(', ')}`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(`Probe failed for ${spec.id}: ${msg}`);
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      website: spec.website,
      options: spec.options,
      available: false,
      unavailableReason: `Found on PATH but initialize failed: ${msg}`,
      resolved,
      probed: false,
    };
  }

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    website: spec.website,
    options: spec.options,
    available: true,
    resolved,
    capabilities,
    probed: true,
  };
}

/**
 * Spawn the agent, send `initialize`, capture the response, then kill it.
 * Times out after 20s.
 */
export async function probeInitialize(resolved: ResolvedAgentCommand): Promise<ProbedCapabilities> {
  return new Promise<ProbedCapabilities>((resolve, reject) => {
    const shell = resolved.shell ?? false;
    const proc = spawn(resolved.cmd, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell,
    });
    let buf = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error('initialize timed out after 20s'));
    }, 20000);

    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && (msg.result || msg.error)) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try { proc.stdin.end(); } catch { /* ignore */ }
          try { proc.kill(); } catch { /* ignore */ }
          if (msg.error) reject(new Error(msg.error.message || 'initialize error'));
          else resolve(msg.result as ProbedCapabilities);
        }
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      if (/error|fatal|panic/i.test(s)) logger.log(`[${resolved.cmd} stderr] ${s.trim()}`);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`agent exited (code=${code}) before responding to initialize`));
    });

    try {
      proc.stdin.write(JSON.stringify(initReq) + '\n');
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(e as Error);
    }
  });
}

/**
 * Probe both `initialize` and `session/new` to get configOptions + modes.
 * This mirrors the approach in interview-taker/src/acp/acpAgent.ts.
 * If session/new fails (e.g. auth required), we still return initialize results.
 */
export async function probeInitializeAndSession(resolved: ResolvedAgentCommand): Promise<ProbedCapabilities> {
  return new Promise<ProbedCapabilities>((resolve, reject) => {
    const shell = resolved.shell ?? false;
    const proc = spawn(resolved.cmd, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell,
    });
    let buf = '';
    let settled = false;
    let nextId = 1;
    let initResult: ProbedCapabilities | null = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error('probe timed out after 30s'));
    }, 30000);

    const send = (msg: any) => {
      try { proc.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) {
        if (!settled) { settled = true; clearTimeout(timeout); reject(e as Error); }
      }
    };

    const finish = (result: ProbedCapabilities) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { proc.stdin.end(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      resolve(result);
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }

        // Response to initialize (id=1)
        if (msg.id === 1 && (msg.result || msg.error)) {
          if (msg.error) {
            finish({ protocolVersion: 1, ...msg.error });
            return;
          }
          initResult = msg.result as ProbedCapabilities;
          // Now send session/new (id=2)
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'session/new',
            params: { cwd: process.cwd(), mcpServers: [] },
          });
          return;
        }

        // Response to session/new (id=2)
        if (msg.id === 2 && (msg.result || msg.error)) {
          if (initResult) {
            if (msg.result) {
              initResult.configOptions = msg.result.configOptions;
              initResult.modes = msg.result.modes;
            }
            // session/new error (e.g. auth) — still return init result
            finish(initResult);
          }
          return;
        }

        // Handle server requests (e.g. authenticate, fs/read)
        if (msg.method && msg.id !== undefined) {
          // Auto-respond to permission requests with reject (read-only probe)
          if (msg.method === 'session/request_permission' || msg.method === 'session/requestPermission') {
            send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'rejected' } } });
          } else if (msg.method === 'fs/read_text_file' || msg.method === 'fs/readTextFile') {
            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'read not available during probe' } });
          } else {
            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported during probe' } });
          }
          return;
        }
      }
    });

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      if (/error|fatal|panic/i.test(s)) logger.log(`[${resolved.cmd} stderr] ${s.trim()}`);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // If we got init but session/new never responded, return init
      if (initResult) finish(initResult);
      else reject(new Error(`agent exited (code=${code}) before responding to initialize`));
    });

    // Send initialize
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: 'codesensei', title: 'AI CodeSensei', version: '0.1.0' },
      },
    });
  });
}

export async function isCommandOnPath(cmd: string): Promise<boolean> {
  if (path.isAbsolute(cmd)) {
    try {
      await import('fs/promises').then((fs) => fs.access(cmd));
      return true;
    } catch {
      return false;
    }
  }
  const tool = IS_WINDOWS ? 'where.exe' : 'which';
  return new Promise((resolve) => {
    const p = spawn(tool, [cmd], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

// Re-export for backwards compatibility with existing imports
export { RegistryAgent };
