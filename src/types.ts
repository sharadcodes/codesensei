export interface RegistryAgentDistribution {
  archive?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution?: {
    binary?: Record<string, RegistryAgentDistribution>;
    npx?: { package: string; args?: string[]; cmd?: string };
    uvx?: { package: string; args?: string[]; cmd?: string };
  };
}

export interface Registry {
  version: string;
  agents: RegistryAgent[];
}

export interface InterviewTopic {
  title: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  rationale: string;
}

export interface InterviewFile {
  path: string;
  role: string;
}

export interface CodebaseContext {
  summary: string;
  files: InterviewFile[];
  topics: InterviewTopic[];
}

/**
 * Fully resolved launch spec for an ACP agent. Mirrors the shape that
 * goddard-ai/acp-client's resolveAgentProcessSpec produces:
 *   - `cmd` / `args` are the final spawn command
 *   - `cwd` is the directory the process should start in (extracted archive
 *     root for binary distributions, undefined = inherit caller cwd)
 *   - `shell` is required on Windows for .cmd shims (npx.cmd, etc.)
 *   - `env` is merged on top of process.env
 */
export interface ResolvedAgentCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  shell?: boolean;
  distributionType: 'binary' | 'npx' | 'uvx';
  /** Human-readable note when the agent cannot be launched as-is. */
  unavailableReason?: string;
}
