export type AgentMode = 'read-only' | 'agent' | 'agent-full-access';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
export type SandboxMode = 'workspace-write' | 'read-only' | 'danger-full-access';

export interface AgentConfig {
  /** Model id the agent should use (e.g. gpt-5, gpt-5-codex, o4-mini). Empty = agent default. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Scope/permission level the agent runs with. */
  agentMode?: AgentMode;
  sandboxMode?: SandboxMode;
  /** Provider name passed to agents that support MODEL_PROVIDER. */
  modelProvider?: string;
  /** Extra env vars merged into the spawned agent process. */
  extraEnv?: Record<string, string>;
  /** Extra JSON merged into the agent's session config (CODEX_CONFIG for codex-acp). */
  extraSessionConfig?: Record<string, unknown>;
}

export interface AgentConfigMap {
  [agentId: string]: AgentConfig;
}

export const REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
export const AGENT_MODES: AgentMode[] = ['read-only', 'agent', 'agent-full-access'];
export const SANDBOX_MODES: SandboxMode[] = ['workspace-write', 'read-only', 'danger-full-access'];

/** Common model choices for codex-acp / OpenAI-compatible agents. */
export const COMMON_MODELS = [
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-mini',
  'gpt-5-nano',
  'o4-mini',
  'gpt-4.1',
  'gpt-4o',
  '',
];
