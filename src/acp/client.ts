import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { ResolvedAgentCommand } from '../types';
import { AgentConfig } from './agentConfig';
import { logger } from '../logger';

export type SessionUpdateKind =
  | 'agent_message_chunk'
  | 'user_message_chunk'
  | 'plan'
  | 'tool_call'
  | 'tool_call_update'
  | 'usage_update';

export interface SessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate: SessionUpdateKind;
    content?: { type: string; text?: string; [k: string]: unknown };
    messageId?: string;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    entries?: unknown[];
    used?: number;
    size?: number;
    cost?: { amount: number; currency: string };
    [k: string]: unknown;
  };
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  description: string;
  options: Array<{ id: string; title: string; outcome?: string }>;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  authMethods?: unknown[];
}

export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private closed = false;
  private initialized = false;
  private disposeReason: Error | null = null;

  constructor(
    private readonly command: ResolvedAgentCommand,
    private cwd: string,
    private readonly agentConfig?: AgentConfig
  ) {
    super();
  }

  async start(): Promise<void> {
    const cmd = this.command.cmd;
    const args = this.command.args ?? [];
    const env = { ...process.env, ...(this.command.env ?? {}), ...this.buildAgentEnv() };
    // Binary distributions with an archive URL extract to a cache dir and
    // spawn from there (so relative cmds like ./opencode resolve). For
    // npx/uvx/PATH binaries, cwd is the workspace root.
    const spawnCwd = this.command.cwd ?? this.cwd;
    const shell = this.command.shell ?? false;
    logger.log(`Starting ACP agent: ${cmd} ${args.join(' ')} (cwd: ${spawnCwd}, shell: ${shell})`);
    this.proc = spawn(cmd, args, {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell,
    });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stderr?.setEncoding('utf8');

    this.proc.stdout?.on('data', (d: string | Buffer) => this.onStdout(d));
    this.proc.stderr?.on('data', (d: string | Buffer) => {
      const s = d.toString();
      this.emit('log', s);
      logger.log(`[agent stderr] ${s.trim()}`);
    });
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      logger.log(`ACP agent exited code=${code} signal=${signal}`);
      this.emit('exit', { code, signal });
      for (const p of this.pending.values()) {
        p.reject(new Error(`ACP agent exited with code ${code} signal ${signal}`));
      }
      this.pending.clear();
    });
    this.proc.on('error', (err) => {
      this.closed = true;
      logger.error(`ACP agent error: ${err.message}`);
      this.emit('error', err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  /**
   * Translate the agent config into env vars understood by codex-acp and
   * similar ACP agents. For codex-acp specifically:
   *   - INITIAL_AGENT_MODE controls scope/permission
   *   - CODEX_CONFIG is a JSON blob merged into the Codex session config and
   *     carries model, model_reasoning_effort, sandbox_mode
   *   - MODEL_PROVIDER overrides the provider
   */
  private buildAgentEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const cfg = this.agentConfig;
    if (!cfg) return env;

    if (cfg.agentMode) env['INITIAL_AGENT_MODE'] = cfg.agentMode;
    if (cfg.modelProvider) env['MODEL_PROVIDER'] = cfg.modelProvider;

    const codexConfig: Record<string, unknown> = {};
    if (cfg.model) codexConfig['model'] = cfg.model;
    if (cfg.reasoningEffort) codexConfig['model_reasoning_effort'] = cfg.reasoningEffort;
    if (cfg.sandboxMode) codexConfig['sandbox_mode'] = cfg.sandboxMode;
    if (cfg.extraSessionConfig) Object.assign(codexConfig, cfg.extraSessionConfig);
    if (Object.keys(codexConfig).length) env['CODEX_CONFIG'] = JSON.stringify(codexConfig);

    if (cfg.extraEnv) Object.assign(env, cfg.extraEnv);
    return env;
  }

  private onStdout(d: string | Buffer) {
    this.buffer += d.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.emit('log', `Failed to parse ACP line: ${line}`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: any) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      const summary = msg.error
        ? `error: ${msg.error.message ?? 'ACP error'} (code: ${msg.error.code ?? 'n/a'}${msg.error.data ? `, data: ${JSON.stringify(msg.error.data).slice(0, 300)}` : ''})`
        : `result: ${JSON.stringify(msg.result).slice(0, 200)}`;
      logger.log(`← ACP #${msg.id} ${summary}`);
      if (msg.error) {
        const detail = msg.error.data ? ` — ${JSON.stringify(msg.error.data).slice(0, 500)}` : '';
        waiter.reject(new Error(`${msg.error.message || 'ACP error'} (code ${msg.error.code ?? 'n/a'})${detail}`));
      }
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method) {
      logger.log(`← ACP ${msg.method}`);
      // Notification or server-initiated request
      if (msg.method === 'session/update') {
        this.emit('update', msg.params as SessionUpdate);
      } else if (msg.method === 'session/request_permission') {
        // Server-initiated request expects a response
        this.emit('permission', msg.params as PermissionRequest);
        // Repository analysis must remain read-only. Agents can read through their
        // own sandbox, but unexpected write/command permission requests are rejected.
        this.respond(msg.id, { outcome: { outcome: 'rejected' } });
      } else if (msg.method === 'session/cancel') {
        this.emit('cancel', msg.params);
      } else {
        this.emit('notification', msg);
      }
    }
  }

  private send(msg: any) {
    if (!this.proc || this.closed) throw new Error('ACP agent not running');
    const line = JSON.stringify(msg);
    logger.log(`→ ACP ${msg.method ?? 'response'}: ${line.length > 300 ? line.slice(0, 300) + '…' : line}`);
    this.proc.stdin?.write(line + '\n');
  }

  private request(method: string, params: any): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} timed out after 120s`));
        }
      }, 120_000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private respond(id: number | string, result: any) {
    this.send({ jsonrpc: '2.0', id, result });
  }

  async initialize(): Promise<InitializeResult> {
    const res = (await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    })) as InitializeResult;
    this.initialized = true;
    return res;
  }

  async authenticate(methodId: string, metadata?: Record<string, unknown>): Promise<unknown> {
    return this.request('authenticate', { methodId, metadata: metadata ?? {} });
  }

  async newSession(
    cwd: string,
    mcpServers: unknown[] = [],
    configuration?: Record<string, unknown>
  ): Promise<string> {
    const params: Record<string, unknown> = { cwd, mcpServers };
    if (configuration && Object.keys(configuration).length) {
      params.configuration = configuration;
    }
    const res = (await this.request('session/new', params)) as { sessionId: string };
    return res.sessionId;
  }

  /**
   * Load an existing session, replaying the full conversation history via
   * `session/update` notifications before this resolves. Only call this if
   * the agent advertised `agentCapabilities.loadSession === true` on
   * `initialize` — the protocol says Clients MUST NOT call it otherwise.
   */
  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<void> {
    await this.request('session/load', { sessionId, cwd, mcpServers });
  }

  /**
   * Resume an existing session without replaying prior messages (lighter
   * weight than `session/load`). Only call this if the agent advertised
   * `agentCapabilities.sessionCapabilities.resume` on `initialize`.
   */
  async resumeSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<unknown> {
    return this.request('session/resume', { sessionId, cwd, mcpServers });
  }

  async prompt(sessionId: string, prompt: Array<Record<string, unknown>>): Promise<{ stopReason: string }> {
    return (await this.request('session/prompt', { sessionId, prompt })) as { stopReason: string };
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.proc || this.closed) return;
    this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.request('session/close', { sessionId });
    } catch {
      /* ignore */
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async dispose(reason: Error = new Error('ACP client disposed')): Promise<void> {
    this.disposeReason = reason;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    try {
      if (this.proc && !this.closed) {
        this.proc.stdin?.end();
        this.proc.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.closed = true;
  }
}
