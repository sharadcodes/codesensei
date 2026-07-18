import * as vscode from 'vscode';
import { DiscoveredAgent, discoverAgentsWithCustom } from '../acp/registry';
import { getAgentConfig, saveAgentConfig } from '../acp/agentConfigUi';
import { logger } from '../logger';
import { InterviewEvent, InterviewState } from '../interview/orchestrator';
import { loadConfig } from '../config';

interface AgentState {
  agents: DiscoveredAgent[];
  selectedId: string;
  interviewState: InterviewState;
  questionCount: number;
  lastFile: string;
  statusText: string;
}

export class HomeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'interviewLele.home';
  private view: vscode.WebviewView | null = null;
  private state: AgentState = {
    agents: [],
    selectedId: '',
    interviewState: 'idle',
    questionCount: 0,
    lastFile: '',
    statusText: '',
  };
  /** Called when the webview sends recorded audio (base64). */
  public onAudio: ((base64: string, mimeType: string) => Promise<void>) | null = null;
  /** Called when the webview requests the opening turn. */
  public onRequestOpening: (() => Promise<void>) | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    void this.refresh();
  }

  show(): void {
    vscode.commands.executeCommand(`${HomeViewProvider.viewType}.focus`);
  }

  get agents(): DiscoveredAgent[] {
    return this.state.agents;
  }

  async refresh(): Promise<void> {
    this.postState({ statusText: 'Probing ACP agents...' });
    try {
      const config = loadConfig();
      const agents = await discoverAgentsWithCustom(config.acp.customAgents ?? []);
      this.state.agents = agents;
      if (!this.state.selectedId && agents.length) {
        const firstAvailable = agents.find((a) => a.available);
        if (firstAvailable) this.state.selectedId = firstAvailable.id;
      }
      this.state.statusText = `Discovered ${agents.length} agent(s): ${agents.map((a) => `${a.name}(${a.available ? 'ready' : 'n/a'})`).join(', ')}`;
      logger.log(this.state.statusText);
      const configs: Record<string, any> = {};
      for (const agent of agents) configs[agent.id] = await getAgentConfig(agent.id);
      this.view?.webview.postMessage({ channel: 'configs', configs });
    } catch (e) {
      this.state.statusText = `Discovery failed: ${(e as Error).message}`;
      logger.error(this.state.statusText);
    }
    this.postState();
  }

  setInterviewState(s: InterviewState): void {
    this.state.interviewState = s;
    this.postState();
  }

  setQuestionCount(n: number): void {
    this.state.questionCount = n;
    this.postState();
  }

  setLastFile(f: string): void {
    this.state.lastFile = f;
    this.postState();
  }

  postStatus(text: string): void {
    this.state.statusText = text;
    this.postState();
  }

  /** Send TTS audio (base64 mp3) to the webview for playback via <audio> element. */
  playTtsAudio(base64: string, mimeType: string): void {
    this.view?.webview.postMessage({ channel: 'ttsAudio', base64, mimeType });
  }

  /** Send audio level data to the webview for live waveform visualization. */
  sendAudioLevel(level: { rms: number; peak: number; recording: boolean; wave: number[] }): void {
    this.view?.webview.postMessage({ channel: 'audioLevel', level });
  }

  /** Tell the webview to start listening (mic on). */
  startListening(): void {
    this.view?.webview.postMessage({ channel: 'startListening' });
  }

  /** Tell the webview to stop listening (mic off). */
  stopListening(): void {
    this.view?.webview.postMessage({ channel: 'stopListening' });
  }

  postEvent(e: InterviewEvent): void {
    if (e.kind === 'agent_message' && e.text) this.appendTranscript('agent', e.text);
    else if (e.kind === 'user_transcript' && e.text) this.appendTranscript('user', e.text);
    else if (e.kind === 'file_opened') this.appendTranscript('file', e.text ?? '', e.filePath, e.lineStart, e.lineEnd);
    else if (e.kind === 'log' && e.text) this.appendTranscript('system', e.text);
    else if (e.kind === 'error' && e.text) this.appendTranscript('error', e.text);
  }

  private appendTranscript(kind: string, text: string, filePath?: string, lineStart?: number, lineEnd?: number): void {
    this.view?.webview.postMessage({ channel: 'transcript', entry: { kind, text, filePath, lineStart, lineEnd } });
  }

  private postState(extra?: { statusText?: string }): void {
    if (extra?.statusText) this.state.statusText = extra.statusText;
    this.view?.webview.postMessage({ channel: 'state', state: this.state });
  }

  private async onMessage(m: any): Promise<void> {
    if (!m || !m.command) return;
    switch (m.command) {
      case 'refresh':
        await this.refresh();
        break;
      case 'select':
        if (m.agentId) {
          this.state.selectedId = m.agentId;
          await vscode.workspace.getConfiguration('interviewLele').update('acp.selectedAgentId', m.agentId, vscode.ConfigurationTarget.Global);
          this.postState();
        }
        break;
      case 'start':
        vscode.commands.executeCommand('interviewLele.startInterview');
        break;
      case 'stop':
        vscode.commands.executeCommand('interviewLele.stopInterview');
        break;
      case 'testMic':
        vscode.commands.executeCommand('interviewLele.testMic');
        break;
      case 'testSpeaker':
        vscode.commands.executeCommand('interviewLele.testSpeaker');
        break;
      case 'showLogs':
        logger.show();
        break;
      case 'viewCapabilities':
        if (m.agentId) this.showCapabilities(m.agentId);
        break;
      case 'clearTranscript':
        this.view?.webview.postMessage({ channel: 'clearTranscript' });
        break;
      case 'audio':
        if (m.base64 && m.mimeType && this.onAudio) {
          try { await this.onAudio(m.base64, m.mimeType); }
          catch (e) { this.postStatus(`Audio processing failed: ${(e as Error).message}`); }
        }
        break;
      case 'requestOpening':
        if (this.onRequestOpening) {
          try { await this.onRequestOpening(); }
          catch (e) { this.postStatus(`Opening turn failed: ${(e as Error).message}`); }
        }
        break;
      case 'setOption': {
        if (m.agentId && m.option && m.value !== undefined) {
          const config = await getAgentConfig(m.agentId);
          const updated = { ...config } as Record<string, unknown>;
          if (m.value === '') delete updated[m.option];
          else updated[m.option] = m.value;
          await saveAgentConfig(m.agentId, updated);
        }
        break;
      }
      case 'getSettings': {
        const cfg = loadConfig();
        this.view?.webview.postMessage({ channel: 'settingsData', settings: cfg });
        break;
      }
      case 'saveSettings': {
        if (m.settings) {
          const s = m.settings;
          const ws = vscode.workspace.getConfiguration('interviewLele');
          const target = vscode.ConfigurationTarget.Global;
          if (s.stt) {
            if (s.stt.baseUrl !== undefined) await ws.update('stt.baseUrl', s.stt.baseUrl, target);
            if (s.stt.model !== undefined) await ws.update('stt.model', s.stt.model, target);
            if (s.stt.apiKey !== undefined) await ws.update('stt.apiKey', s.stt.apiKey, target);
            if (s.stt.path !== undefined) await ws.update('stt.path', s.stt.path, target);
            if (s.stt.language !== undefined) await ws.update('stt.language', s.stt.language, target);
          }
          if (s.tts) {
            if (s.tts.baseUrl !== undefined) await ws.update('tts.baseUrl', s.tts.baseUrl, target);
            if (s.tts.model !== undefined) await ws.update('tts.model', s.tts.model, target);
            if (s.tts.apiKey !== undefined) await ws.update('tts.apiKey', s.tts.apiKey, target);
            if (s.tts.voice !== undefined) await ws.update('tts.voice', s.tts.voice, target);
            if (s.tts.path !== undefined) await ws.update('tts.path', s.tts.path, target);
          }
          if (s.chat) {
            if (s.chat.baseUrl !== undefined) await ws.update('chat.baseUrl', s.chat.baseUrl, target);
            if (s.chat.model !== undefined) await ws.update('chat.model', s.chat.model, target);
            if (s.chat.apiKey !== undefined) await ws.update('chat.apiKey', s.chat.apiKey, target);
            if (s.chat.path !== undefined) await ws.update('chat.path', s.chat.path, target);
          }
          if (s.audio) {
            if (s.audio.ffmpegPath !== undefined) await ws.update('audio.ffmpegPath', s.audio.ffmpegPath, target);
            if (s.audio.silenceSeconds !== undefined) await ws.update('audio.silenceSeconds', s.audio.silenceSeconds, target);
            if (s.audio.beepEnabled !== undefined) await ws.update('audio.beepEnabled', s.audio.beepEnabled, target);
          }
          if (s.interview) {
            if (s.interview.maxQuestions !== undefined) await ws.update('interview.maxQuestions', s.interview.maxQuestions, target);
            if (s.interview.difficulty !== undefined) await ws.update('interview.difficulty', s.interview.difficulty, target);
          }
          if (s.voiceMode !== undefined) await ws.update('voiceMode', s.voiceMode, target);
          this.postStatus('Settings saved.');
        }
        break;
      }
    }
  }

  private showCapabilities(agentId: string): void {
    const agent = this.state.agents.find((item) => item.id === agentId);
    if (!agent) return;
    const output = vscode.window.createOutputChannel('Interview Lele: Agent Capabilities');
    output.show();
    output.appendLine(JSON.stringify(agent.capabilities ?? { message: 'No capabilities probed. Click Refresh.' }, null, 2));
  }


  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return (
      /*html*/
      `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Interview Lele</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--vscode-foreground, #fff);
    background: var(--vscode-editor-background, #1e1e1e);
    margin: 0; padding: 0; font-size: 13px;
    display: flex; flex-direction: column; height: 100vh;
  }
  header { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border, #333); display: flex; align-items: center; gap: 8px; }
  header h1 { font-size: 14px; margin: 0; flex: 1; }
  .state-badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #fff); text-transform: uppercase; letter-spacing: 0.5px; }
  .state-badge[data-state="listening"] { background: #2e7d32; }
  .state-badge[data-state="speaking"] { background: #1565c0; }
  .state-badge[data-state="thinking"] { background: #ef6c00; }
  .state-badge[data-state="connecting"] { background: #6a1b9a; }
  .state-badge[data-state="ended"] { background: #c62828; }
  .toolbar { display: flex; gap: 6px; padding: 8px 12px; flex-wrap: wrap; }
  button { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none; padding: 5px 10px; border-radius: 2px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger { background: #c62828; }
  .status { padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground, #aaa); min-height: 18px; }
  .section-title { padding: 8px 12px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground, #888); }
  #agents { padding: 0 12px; display: flex; flex-direction: column; gap: 8px; }
  .agent-card { border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 10px; cursor: pointer; transition: border-color 0.15s; }
  .agent-card.selected { border-color: var(--vscode-focusBorder, #0e639c); background: rgba(14,99,156,0.1); }
  .agent-card.unavailable { opacity: 0.6; }
  .agent-card-head { display: flex; align-items: center; gap: 8px; }
  .agent-card-head .name { font-weight: 600; flex: 1; }
  .agent-card-head .dot { width: 8px; height: 8px; border-radius: 50%; }
  .agent-card-head .dot.ok { background: #4caf50; }
  .agent-card-head .dot.no { background: #c62828; }
  .agent-card .desc { font-size: 11px; color: var(--vscode-descriptionForeground, #aaa); margin-top: 4px; }
  .agent-card .caps { font-size: 10px; margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
  .cap { background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #fff); padding: 1px 6px; border-radius: 8px; font-size: 10px; }
  .agent-card .actions { display: flex; gap: 6px; margin-top: 8px; }
  .agent-card .actions button { font-size: 11px; padding: 3px 8px; }
  .options-grid { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .opt-row { display: flex; align-items: center; gap: 6px; }
  .opt-row label { font-size: 10px; color: var(--vscode-descriptionForeground, #888); min-width: 70px; text-transform: uppercase; letter-spacing: 0.3px; }
  select {
    flex: 1; background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #fff);
    border: 1px solid var(--vscode-dropdown-border, #555); padding: 3px 6px; border-radius: 2px; font-size: 11px;
  }
  select:focus { outline: 1px solid var(--vscode-focusBorder, #0e639c); }
  #transcript-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  #transcript { flex: 1; overflow-y: auto; padding: 8px 12px; border-top: 1px solid var(--vscode-panel-border, #333); }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 4px; font-size: 12px; }
  .msg.agent { background: rgba(25,118,210,0.15); border-left: 3px solid #1976d2; }
  .msg.user { background: rgba(46,125,50,0.15); border-left: 3px solid #2e7d32; }
  .msg.system { background: rgba(102,102,102,0.15); border-left: 3px solid #888; font-size: 11px; }
  .msg.error { background: rgba(198,40,40,0.15); border-left: 3px solid #c62828; }
  .msg.file { background: rgba(255,152,0,0.15); border-left: 3px solid #ef6c00; font-family: monospace; font-size: 11px; }
  .msg .who { font-size: 9px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .meta-row { display: flex; gap: 12px; padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground, #aaa); }
  .meta-row span b { color: var(--vscode-foreground, #fff); }
  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 100; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 16px; width: 90%; max-width: 560px; max-height: 85vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
  .modal h2 { font-size: 14px; margin: 0 0 12px; }
  .modal-section { margin-bottom: 14px; }
  .modal-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground, #888); margin-bottom: 6px; padding-bottom: 3px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
  .modal-field { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
  .modal-field label { font-size: 10px; color: var(--vscode-descriptionForeground, #888); text-transform: uppercase; letter-spacing: 0.3px; }
  .modal-field input, .modal-field select { background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #fff); border: 1px solid var(--vscode-input-border, #555); padding: 4px 8px; border-radius: 2px; font-size: 12px; font-family: var(--vscode-font-family, monospace); }
  .modal-field input:focus, .modal-field select:focus { outline: 1px solid var(--vscode-focusBorder, #0e639c); }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, #333); }
  .modal-hint { font-size: 10px; color: var(--vscode-descriptionForeground, #888); margin-top: 2px; }
</style>
</head>
<body>
  <header>
    <h1>Interview Lele</h1>
    <span id="state-badge" class="state-badge" data-state="idle">idle</span>
  </header>
  <div class="toolbar">
    <button id="btn-start">Start Interview</button>
    <button id="btn-stop" class="danger" disabled>Stop</button>
    <button id="btn-refresh" class="secondary">Refresh Agents</button>
    <button id="btn-settings" class="secondary">Settings</button>
    <button id="btn-mic" class="secondary">Test Mic</button>
    <button id="btn-spk" class="secondary">Test Speaker</button>
    <button id="btn-logs" class="secondary">Logs</button>
    <button id="btn-clear" class="secondary">Clear</button>
  </div>
  <div class="meta-row">
    <span>Questions: <b id="qcount">0</b></span>
    <span>Last file: <b id="lastfile">-</b></span>
  </div>
  <div class="status" id="status">Idle.</div>
  <div class="section-title">ACP Agents <span style="font-size:9px;opacity:0.6;text-transform:none;letter-spacing:0">— Chat: OpenAI-compatible (OpenRouter)</span></div>
  <div id="agents"></div>
  <div class="section-title">Transcript</div>
  <div id="transcript-wrap"><div id="transcript"></div></div>

  <!-- Settings Modal -->
  <div class="modal-overlay" id="settings-modal">
    <div class="modal">
      <h2>Settings</h2>

      <div class="modal-section">
        <div class="modal-section-title">STT (Speech-to-Text)</div>
        <div class="modal-field"><label>Base URL</label><input id="stt-baseUrl" type="text" /></div>
        <div class="modal-field"><label>Model</label><input id="stt-model" type="text" /></div>
        <div class="modal-field"><label>API Key</label><input id="stt-apiKey" type="password" /><div class="modal-hint">OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.</div></div>
        <div class="modal-field"><label>Path</label><input id="stt-path" type="text" /></div>
        <div class="modal-field"><label>Language</label><input id="stt-language" type="text" /></div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">TTS (Text-to-Speech)</div>
        <div class="modal-field"><label>Base URL</label><input id="tts-baseUrl" type="text" /></div>
        <div class="modal-field"><label>Model</label><input id="tts-model" type="text" /></div>
        <div class="modal-field"><label>API Key</label><input id="tts-apiKey" type="password" /><div class="modal-hint">Use "not-needed" for local Kokoro.</div></div>
        <div class="modal-field"><label>Voice</label><input id="tts-voice" type="text" /></div>
        <div class="modal-field"><label>Path</label><input id="tts-path" type="text" /></div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Chat (Interviewer LLM)</div>
        <div class="modal-field"><label>Base URL</label><input id="chat-baseUrl" type="text" /></div>
        <div class="modal-field"><label>Model</label><input id="chat-model" type="text" /></div>
        <div class="modal-field"><label>API Key</label><input id="chat-apiKey" type="password" /><div class="modal-hint">OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.</div></div>
        <div class="modal-field"><label>Path</label><input id="chat-path" type="text" /></div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Audio</div>
        <div class="modal-field"><label>FFmpeg/FFplay Path</label><input id="audio-ffmpegPath" type="text" /></div>
        <div class="modal-field"><label>Silence Seconds</label><input id="audio-silenceSeconds" type="number" step="0.1" min="0.3" /></div>
        <div class="modal-field"><label>Beep Enabled</label><select id="audio-beepEnabled"><option value="true">true</option><option value="false">false</option></select></div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Interview</div>
        <div class="modal-field"><label>Max Questions (0 = unlimited)</label><input id="interview-maxQuestions" type="number" min="0" /></div>
        <div class="modal-field"><label>Difficulty</label><select id="interview-difficulty"><option value="adaptive">adaptive</option><option value="junior">junior</option><option value="mid">mid</option><option value="senior">senior</option><option value="staff">staff</option></select></div>
        <div class="modal-field"><label>Voice Mode</label><select id="voiceMode"><option value="auto">auto</option><option value="chained">chained</option><option value="realtime">realtime</option></select></div>
      </div>

      <div class="modal-actions">
        <button id="btn-settings-cancel" class="secondary">Cancel</button>
        <button id="btn-settings-save">Save</button>
      </div>
    </div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let currentConfigs = {};

  function setState(s) {
    const prevAgents = window.__lastState?.agents;
    const sameAgents = JSON.stringify(prevAgents) === JSON.stringify(s.agents);
    window.__lastState = s;
    $('state-badge').textContent = s.interviewState;
    $('state-badge').dataset.state = s.interviewState;
    $('qcount').textContent = s.questionCount;
    $('lastfile').textContent = s.lastFile || '-';
    $('status').textContent = s.statusText || '';
    const running = ['listening','speaking','thinking','connecting'].includes(s.interviewState);
    $('btn-start').disabled = running;
    $('btn-stop').disabled = !running;
    // Only re-render agents if the agent list actually changed (preserves dropdown selections)
    if (!sameAgents) renderAgents(s.agents, s.selectedId);
  }

  function renderAgents(agents, selectedId) {
    const wrap = $('agents');
    wrap.innerHTML = '';
    if (!agents || !agents.length) {
      wrap.innerHTML = '<div class="status">No agents yet. Click Refresh Agents.</div>';
      return;
    }
    for (const a of agents) {
      const card = document.createElement('div');
      card.className = 'agent-card' + (a.id === selectedId ? ' selected' : '') + (a.available ? '' : ' unavailable');
      const caps = a.capabilities;
      const capBadges = [];
      if (caps) {
        if (caps.agentInfo?.version) capBadges.push('v' + caps.agentInfo.version);
        const c = caps.agentCapabilities;
        if (c?.promptCapabilities?.image) capBadges.push('image');
        if (c?.promptCapabilities?.embeddedContext) capBadges.push('context');
        if (c?.mcpCapabilities?.http) capBadges.push('mcp-http');
        if (c?.mcpCapabilities?.sse) capBadges.push('mcp-sse');
        if (c?.sessionCapabilities?.resume) capBadges.push('resume');
        if (c?.sessionCapabilities?.close) capBadges.push('close');
        if (c?.loadSession) capBadges.push('loadSession');
        if (caps.authMethods?.length) capBadges.push('auth:' + caps.authMethods.length);
      }
      const opts = a.options || {};
      const cfg = currentConfigs[a.id] || {};
      const optRows = [];
      if (opts.models?.length) optRows.push(makeSelect('model', 'Model', opts.models, cfg.model));
      if (opts.reasoningEfforts?.length) optRows.push(makeSelect('reasoningEffort', 'Reasoning', opts.reasoningEfforts, cfg.reasoningEffort));
      if (opts.permissionModes?.length) optRows.push(makeSelect('agentMode', 'Scope', opts.permissionModes, cfg.agentMode));
      if (opts.sandboxModes?.length) optRows.push(makeSelect('sandboxMode', 'Sandbox', opts.sandboxModes, cfg.sandboxMode));
      if (opts.modelProviders?.length) optRows.push(makeSelect('modelProvider', 'Provider', opts.modelProviders, cfg.modelProvider));
      const optionsHtml = optRows.length
        ? '<div class="options-grid">' + optRows.map((r) => r.html).join('') + '</div>'
        : '';
      card.innerHTML = \`
        <div class="agent-card-head">
          <span class="dot \${a.available ? 'ok' : 'no'}"></span>
          <span class="name">\${a.name}</span>
          <span style="font-size:10px;opacity:0.7">\${a.available ? 'ready' : 'unavailable'}</span>
        </div>
        <div class="desc">\${a.description}\${a.unavailableReason ? '<br><i>' + a.unavailableReason + '</i>' : ''}</div>
        <div class="caps">\${capBadges.map((b) => '<span class="cap">' + b + '</span>').join('')}</div>
        \${optionsHtml}
        <div class="actions">
          <button data-act="select" data-id="\${a.id}">Select</button>
          <button data-act="caps" data-id="\${a.id}" class="secondary">Capabilities</button>
        </div>
      \`;
      // Wire select change handlers
      for (const r of optRows) {
        const sel = card.querySelector('#' + r.id);
        if (sel) sel.addEventListener('change', (e) => {
          vscode.postMessage({ command: 'setOption', agentId: a.id, option: r.option, value: e.target.value });
        });
      }
      card.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (btn) {
          const act = btn.dataset.act === 'caps' ? 'viewCapabilities' : btn.dataset.act;
          vscode.postMessage({ command: act, agentId: btn.dataset.id });
        } else if (!e.target.closest('select')) {
          vscode.postMessage({ command: 'select', agentId: a.id });
        }
      });
      wrap.appendChild(card);
    }
  }

  function makeSelect(option, label, values, current) {
    const id = 'sel-' + option + '-' + Math.random().toString(36).slice(2,8);
    const opts = ['<option value="">agent default</option>']
      .concat(values.map((v) => '<option value="' + v + '"' + (v === current ? ' selected' : '') + '>' + v + '</option>'))
      .join('');
    const html = '<div class="opt-row"><label>' + label + '</label><select id="' + id + '">' + opts + '</select></div>';
    return { id, option, html };
  }

  function appendTranscript(entry) {
    const el = $('transcript');
    const div = document.createElement('div');
    div.className = 'msg ' + entry.kind;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = { agent: 'Interviewer', user: 'You', file: 'file', system: 'system', error: 'error' }[entry.kind] || entry.kind;
    div.appendChild(who);
    const body = document.createElement('div');
    body.textContent = entry.text;
    div.appendChild(body);
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg.channel === 'state') setState(msg.state);
    else if (msg.channel === 'configs') { currentConfigs = msg.configs || {}; if (window.__lastState) renderAgents(window.__lastState.agents, window.__lastState.selectedId); }
    else if (msg.channel === 'transcript') appendTranscript(msg.entry);
    else if (msg.channel === 'clearTranscript') $('transcript').innerHTML = '';
    else if (msg.channel === 'settingsData') {
      const s = msg.settings;
      if (!s) return;
      $('stt-baseUrl').value = s.stt?.baseUrl ?? '';
      $('stt-model').value = s.stt?.model ?? '';
      $('stt-apiKey').value = s.stt?.apiKey ?? '';
      $('stt-path').value = s.stt?.path ?? '';
      $('stt-language').value = s.stt?.language ?? '';
      $('tts-baseUrl').value = s.tts?.baseUrl ?? '';
      $('tts-model').value = s.tts?.model ?? '';
      $('tts-apiKey').value = s.tts?.apiKey ?? '';
      $('tts-voice').value = s.tts?.voice ?? '';
      $('tts-path').value = s.tts?.path ?? '';
      $('chat-baseUrl').value = s.chat?.baseUrl ?? '';
      $('chat-model').value = s.chat?.model ?? '';
      $('chat-apiKey').value = s.chat?.apiKey ?? '';
      $('chat-path').value = s.chat?.path ?? '';
      $('audio-ffmpegPath').value = s.audio?.ffmpegPath ?? 'ffmpeg';
      $('audio-silenceSeconds').value = s.audio?.silenceSeconds ?? 2.0;
      $('audio-beepEnabled').value = String(s.audio?.beepEnabled ?? true);
      $('interview-maxQuestions').value = s.interview?.maxQuestions ?? 0;
      $('interview-difficulty').value = s.interview?.difficulty ?? 'adaptive';
      $('voiceMode').value = s.voiceMode ?? 'auto';
      $('settings-modal').classList.add('open');
    }
  });

  $('btn-start').addEventListener('click', () => vscode.postMessage({ command: 'start' }));
  $('btn-stop').addEventListener('click', () => vscode.postMessage({ command: 'stop' }));
  $('btn-refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  $('btn-mic').addEventListener('click', () => vscode.postMessage({ command: 'testMic' }));
  $('btn-spk').addEventListener('click', () => vscode.postMessage({ command: 'testSpeaker' }));
  $('btn-logs').addEventListener('click', () => vscode.postMessage({ command: 'showLogs' }));
  $('btn-clear').addEventListener('click', () => vscode.postMessage({ command: 'clearTranscript' }));

  // Settings modal
  $('btn-settings').addEventListener('click', () => {
    vscode.postMessage({ command: 'getSettings' });
  });
  $('btn-settings-cancel').addEventListener('click', () => {
    $('settings-modal').classList.remove('open');
  });
  $('settings-modal').addEventListener('click', (e) => {
    if (e.target === $('settings-modal')) $('settings-modal').classList.remove('open');
  });
  $('btn-settings-save').addEventListener('click', () => {
    const settings = {
      stt: {
        baseUrl: $('stt-baseUrl').value,
        model: $('stt-model').value,
        apiKey: $('stt-apiKey').value,
        path: $('stt-path').value,
        language: $('stt-language').value,
      },
      tts: {
        baseUrl: $('tts-baseUrl').value,
        model: $('tts-model').value,
        apiKey: $('tts-apiKey').value,
        voice: $('tts-voice').value,
        path: $('tts-path').value,
      },
      chat: {
        baseUrl: $('chat-baseUrl').value,
        model: $('chat-model').value,
        apiKey: $('chat-apiKey').value,
        path: $('chat-path').value,
      },
      audio: {
        ffmpegPath: $('audio-ffmpegPath').value,
        silenceSeconds: parseFloat($('audio-silenceSeconds').value) || 2.0,
        beepEnabled: $('audio-beepEnabled').value === 'true',
      },
      interview: {
        maxQuestions: parseInt($('interview-maxQuestions').value) || 0,
        difficulty: $('interview-difficulty').value,
      },
      voiceMode: $('voiceMode').value,
    };
    vscode.postMessage({ command: 'saveSettings', settings });
    $('settings-modal').classList.remove('open');
  });

  // Request current configs so dropdowns show saved values
  vscode.postMessage({ command: 'refresh' });
</script>
</body>
</html>`
    );
  }

}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
