import * as vscode from 'vscode';
import { DiscoveredAgent } from './registry';
import {
  AgentConfig,
  AgentConfigMap,
  AgentMode,
  AGENT_MODES,
  COMMON_MODELS,
  ReasoningEffort,
  REASONING_EFFORTS,
  SandboxMode,
  SANDBOX_MODES,
} from './agentConfig';
import { logger } from '../logger';

const CONFIG_KEY = 'codeSensei.acp.agentConfigs';
const MEMENTO_KEY = 'codeSensei.agentConfigs';

/**
 * VSCode's configuration writer can reject writes when the setting schema is
 * complex or when a workspace folder isn't open. Fall back to the extension's
 * globalState Memento so agent configs always persist.
 */
let memento: vscode.Memento | null = null;

export function initAgentConfigStorage(m: vscode.Memento): void {
  memento = m;
}

export async function loadAgentConfigs(): Promise<AgentConfigMap> {
  const cfg = vscode.workspace.getConfiguration('codeSensei');
  const fromSettings = (cfg.get<AgentConfigMap>(CONFIG_KEY) ?? {}) || {};
  const fromMemento = memento ? (memento.get<AgentConfigMap>(MEMENTO_KEY) ?? {}) : {};
  // Merge: memento takes precedence (it's the reliable fallback)
  return { ...fromSettings, ...fromMemento };
}

export async function saveAgentConfig(agentId: string, config: AgentConfig): Promise<void> {
  const all = await loadAgentConfigs();
  all[agentId] = config;

  // Try settings first
  let savedToSettings = false;
  try {
    await vscode.workspace
      .getConfiguration('codeSensei')
      .update(CONFIG_KEY, all, vscode.ConfigurationTarget.Global);
    savedToSettings = true;
    logger.log(`Saved agent config for ${agentId} to settings.`);
  } catch (e) {
    logger.error(`Failed to save agent config to settings: ${(e as Error).message}. Using fallback storage.`);
  }

  // Always also persist to memento as a reliable fallback
  if (memento) {
    try {
      // Merge into memento's own copy so we don't lose entries that only exist there
      const mementoAll = memento.get<AgentConfigMap>(MEMENTO_KEY) ?? {};
      mementoAll[agentId] = config;
      await memento.update(MEMENTO_KEY, mementoAll);
      if (!savedToSettings) logger.log(`Saved agent config for ${agentId} to fallback storage.`);
    } catch (e) {
      logger.error(`Failed to save agent config to fallback storage: ${(e as Error).message}`);
    }
  }
}

export async function getAgentConfig(agentId: string): Promise<AgentConfig> {
  const all = await loadAgentConfigs();
  return all[agentId] ?? {};
}

/**
 * Opens a multi-step configuration menu for an ACP agent. Lets the user pick
 * model, reasoning effort, scope/permission (agent mode), sandbox, and select
 * the agent as the active one.
 */
export async function configureAgentMenu(
  agent: DiscoveredAgent,
  onSelect: (agent: DiscoveredAgent) => void
): Promise<void> {
  const config = await getAgentConfig(agent.id);

  const actions: Array<{ label: string; description?: string; detail?: string; action: string }> = [
    {
      label: '$(check) Select this agent',
      description: 'use for codebase learning and knowledge checks',
      action: 'select',
    },
    {
      label: `$(symbol-class) Model: ${config.model || 'agent default'}`,
      description: 'which LLM the agent uses',
      detail: 'e.g. gpt-5, gpt-5-codex, o4-mini',
      action: 'model',
    },
    {
      label: `$(sparkle) Reasoning effort: ${config.reasoningEffort || 'agent default'}`,
      description: 'how hard the agent thinks',
      detail: REASONING_EFFORTS.join(', '),
      action: 'reasoning',
    },
    {
      label: `$(shield) Scope / permission: ${config.agentMode || 'agent default'}`,
      description: 'what the agent is allowed to do',
      detail: 'read-only, agent, agent-full-access',
      action: 'agentMode',
    },
    {
      label: `$(lock) Sandbox mode: ${config.sandboxMode || 'agent default'}`,
      description: 'filesystem access level',
      detail: SANDBOX_MODES.join(', '),
      action: 'sandbox',
    },
    {
      label: `$(server) Model provider: ${config.modelProvider || 'agent default'}`,
      description: 'optional provider override',
      action: 'modelProvider',
    },
    {
      label: '$(info) View probed capabilities',
      description: 'what this agent advertised via initialize',
      detail: agent.probed ? 'MCP, prompt, session, auth methods' : 'not probed yet',
      action: 'capabilities',
    },
    {
      label: '$(trash) Reset to defaults',
      description: 'clear this agent\'s config',
      action: 'reset',
    },
    {
      label: '$(terminal) View launch command',
      description: 'show how this agent will be started',
      action: 'viewCmd',
    },
  ];

  const picked = await vscode.window.showQuickPick(actions, {
    placeHolder: `${agent.name} — configure`,
    title: 'AI CodeSensei: ACP Agent Configuration',
  });
  if (!picked) return;

  switch (picked.action) {
    case 'select':
      onSelect(agent);
      vscode.window.showInformationMessage(`AI CodeSensei: selected agent "${agent.name}".`);
      return;

    case 'model': {
      const items = COMMON_MODELS.map((m) => ({
        label: m || 'agent default',
        description: m ? '' : 'use whatever the agent picks',
        model: m,
        picked: m === (config.model ?? ''),
      }));
      const extra = await vscode.window.showInputBox({
        prompt: 'Or type a custom model id (leave empty to use the picker)',
        placeHolder: 'custom-model-id',
        value: config.model && !COMMON_MODELS.includes(config.model) ? config.model : '',
      });
      let chosen: string | undefined;
      if (extra !== undefined && extra.trim()) {
        chosen = extra.trim();
      } else {
        const pick = await vscode.window.showQuickPick(items, {
          placeHolder: 'Choose model',
          title: 'AI CodeSensei: Agent Model',
        });
        chosen = pick?.model;
      }
      if (chosen !== undefined) {
        await saveAgentConfig(agent.id, { ...config, model: chosen || undefined });
        vscode.window.showInformationMessage(`Model set to "${chosen || 'agent default'}".`);
      }
      return;
    }

    case 'reasoning': {
      const items = REASONING_EFFORTS.map((r) => ({
        label: r,
        description: r === config.reasoningEffort ? 'current' : '',
        value: r,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose reasoning effort',
        title: 'AI CodeSensei: Reasoning Effort',
      });
      if (pick) {
        await saveAgentConfig(agent.id, { ...config, reasoningEffort: pick.value as ReasoningEffort });
        vscode.window.showInformationMessage(`Reasoning effort set to "${pick.value}".`);
      }
      return;
    }

    case 'agentMode': {
      const items = AGENT_MODES.map((m) => ({
        label: m,
        description: m === config.agentMode ? 'current' : '',
        detail:
          m === 'read-only'
            ? 'agent can only read files, no writes/commands'
            : m === 'agent'
            ? 'agent can write files and run commands with approval'
            : 'agent has full access, no approval prompts',
        value: m,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose scope / permission level',
        title: 'AI CodeSensei: Agent Scope',
      });
      if (pick) {
        await saveAgentConfig(agent.id, { ...config, agentMode: pick.value as AgentMode });
        vscode.window.showInformationMessage(`Scope set to "${pick.value}".`);
      }
      return;
    }

    case 'sandbox': {
      const items = SANDBOX_MODES.map((s) => ({
        label: s,
        description: s === config.sandboxMode ? 'current' : '',
        detail:
          s === 'workspace-write'
            ? 'agent can write inside the workspace'
            : s === 'read-only'
            ? 'no filesystem writes'
            : 'full filesystem access (dangerous)',
        value: s,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose sandbox mode',
        title: 'AI CodeSensei: Sandbox Mode',
      });
      if (pick) {
        await saveAgentConfig(agent.id, { ...config, sandboxMode: pick.value as SandboxMode });
        vscode.window.showInformationMessage(`Sandbox set to "${pick.value}".`);
      }
      return;
    }

    case 'modelProvider': {
      const val = await vscode.window.showInputBox({
        prompt: 'Model provider name (passed as MODEL_PROVIDER)',
        placeHolder: 'e.g. openai, anthropic',
        value: config.modelProvider ?? '',
      });
      if (val !== undefined) {
        await saveAgentConfig(agent.id, { ...config, modelProvider: val.trim() || undefined });
        vscode.window.showInformationMessage(`Model provider set to "${val.trim() || 'agent default'}".`);
      }
      return;
    }

    case 'capabilities': {
      const out = vscode.window.createOutputChannel('AI CodeSensei: Agent Capabilities');
      out.show();
      out.appendLine(`Agent: ${agent.name} (${agent.id})`);
      out.appendLine(`Available: ${agent.available}`);
      if (agent.unavailableReason) out.appendLine(`Unavailable reason: ${agent.unavailableReason}`);
      out.appendLine(`Probed: ${agent.probed}`);
      out.appendLine('');
      if (!agent.capabilities) {
        out.appendLine('No capabilities probed. Click the refresh icon on the ACP Agents view to probe.');
      } else {
        out.appendLine('initialize response:');
        out.appendLine(JSON.stringify(agent.capabilities, null, 2));
      }
      return;
    }

    case 'reset': {
      await saveAgentConfig(agent.id, {});
      vscode.window.showInformationMessage(`Config reset for "${agent.name}".`);
      return;
    }

    case 'viewCmd': {
      if (!agent.resolved) {
        vscode.window.showInformationMessage('This agent is not resolvable on the current platform.');
        return;
      }
      const r = agent.resolved;
      const cmd = `${r.cmd} ${r.args.join(' ')}`;
      const env = buildEnvPreview(config);
      const out = vscode.window.createOutputChannel('AI CodeSensei: Agent Command');
      out.show();
      out.appendLine(`Agent: ${agent.name} (${agent.id})`);
      out.appendLine(`Distribution: ${r.distributionType}`);
      out.appendLine(`Available: ${agent.available ? 'yes' : 'no'}`);
      if (agent.unavailableReason) out.appendLine(`Unavailable reason: ${agent.unavailableReason}`);
      out.appendLine('');
      out.appendLine('Spawn cwd: ' + (r.cwd ?? '(workspace root)'));
      out.appendLine('Shell: ' + (r.shell ? 'true' : 'false'));
      out.appendLine('');
      out.appendLine('Environment overrides:');
      out.appendLine(env || '(none)');
      out.appendLine('');
      out.appendLine('Command:');
      out.appendLine(cmd);
      out.appendLine('');
      out.appendLine('Resolved agent config:');
      out.appendLine(JSON.stringify(config, null, 2));
      return;
    }
  }
}

function buildEnvPreview(config: AgentConfig): string {
  const lines: string[] = [];
  if (config.agentMode) lines.push(`INITIAL_AGENT_MODE=${config.agentMode}`);
  if (config.modelProvider) lines.push(`MODEL_PROVIDER=${config.modelProvider}`);
  const codex: Record<string, unknown> = {};
  if (config.model) codex.model = config.model;
  if (config.reasoningEffort) codex.model_reasoning_effort = config.reasoningEffort;
  if (config.sandboxMode) codex.sandbox_mode = config.sandboxMode;
  if (Object.keys(codex).length) lines.push(`CODEX_CONFIG=${JSON.stringify(codex)}`);
  return lines.join('\n');
}
