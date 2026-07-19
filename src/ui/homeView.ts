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
  operation: { kind: 'interview' | 'guide'; phase: string; statusText: string } | null;
  audio: {
    devices: Array<{ id: number; name: string; maxInputChannels: number }>;
    defaultId: number;
    selectedId: number;
    deviceStatus: 'loading' | 'ready' | 'empty' | 'failed';
    micTest: { status: string; message: string };
    speakerTest: { status: string; message: string };
  };
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
    operation: null,
    audio: {
      devices: [], defaultId: -1, selectedId: -1, deviceStatus: 'loading',
      micTest: { status: 'untested', message: 'Not tested' },
      speakerTest: { status: 'untested', message: 'Not tested' },
    },
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

  get selectedAgent(): DiscoveredAgent | undefined {
    return this.state.agents.find((agent) => agent.id === this.state.selectedId);
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

  setOperation(kind: 'interview' | 'guide', phase: string, statusText: string): void {
    this.state.operation = { kind, phase, statusText };
    this.state.statusText = statusText;
    this.postState();
  }

  clearOperation(): void {
    this.state.operation = null;
    this.postState();
  }

  setAudioTest(kind: 'micTest' | 'speakerTest', status: string, message: string): void {
    this.state.audio[kind] = { status, message };
    this.postState();
  }

  async refreshAudioDevices(): Promise<void> {
    this.state.audio.deviceStatus = 'loading';
    this.postState();
    try {
      const { PortAudioMicCapture } = await import('../audio/portAudioMic');
      const result = PortAudioMicCapture.getInputDevicesResult();
      if (result.error) throw new Error(result.error);
      const devices = result.devices;
      const cfg = loadConfig();
      this.state.audio.devices = devices;
      this.state.audio.defaultId = PortAudioMicCapture.getDefaultInputDeviceId();
      this.state.audio.selectedId = cfg.audio.inputDeviceId;
      this.state.audio.deviceStatus = devices.length ? 'ready' : 'empty';
    } catch (error) {
      this.state.audio.deviceStatus = 'failed';
      this.state.audio.devices = [];
      this.state.audio.micTest = { status: 'failure', message: (error as Error).message };
    }
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
      case 'generateTutor':
        vscode.commands.executeCommand('codebaseTutor.generateGuide');
        break;
      case 'stop':
        vscode.commands.executeCommand('interviewLele.stopInterview');
        break;
      case 'testMic':
        vscode.commands.executeCommand('interviewLele.testMic');
        break;
      case 'refreshAudioDevices':
        await this.refreshAudioDevices();
        break;
      case 'selectMic':
        if (Number.isInteger(Number(m.deviceId))) {
          const id = Number(m.deviceId);
          await vscode.workspace.getConfiguration('interviewLele').update('audio.inputDeviceId', id, vscode.ConfigurationTarget.Global);
          this.state.audio.selectedId = id;
          this.state.audio.micTest = { status: 'untested', message: 'Not tested' };
          this.postState();
        }
        break;
      case 'testSpeaker':
        vscode.commands.executeCommand('interviewLele.testSpeaker');
        break;
      case 'showLogs':
        vscode.commands.executeCommand('interviewLele.showLogs');
        break;
      case 'openNativeSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'interviewLele');
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
        const raw = vscode.workspace.getConfiguration('interviewLele');
        // Never expose API keys inherited from the extension-host environment.
        cfg.realtime.apiKey = raw.get<string>('realtime.apiKey', '');
        cfg.stt.apiKey = raw.get<string>('stt.apiKey', '');
        cfg.tts.apiKey = raw.get<string>('tts.apiKey', 'not-needed');
        cfg.chat.apiKey = raw.get<string>('chat.apiKey', '');
        this.view?.webview.postMessage({ channel: 'settingsData', settings: cfg });
        break;
      }
      case 'saveSettings': {
        try {
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
            if (s.audio.inputDevice !== undefined) await ws.update('audio.inputDevice', s.audio.inputDevice, target);
            if (s.audio.inputDeviceId !== undefined) await ws.update('audio.inputDeviceId', s.audio.inputDeviceId, target);
            if (s.audio.silenceSeconds !== undefined) await ws.update('audio.silenceSeconds', s.audio.silenceSeconds, target);
            if (s.audio.beepEnabled !== undefined) await ws.update('audio.beepEnabled', s.audio.beepEnabled, target);
          }
          if (s.realtime) {
            for (const key of ['baseUrl','model','apiKey','voice','instructions','inputFormat','outputFormat','sampleRate','turnDetection']) {
              if (s.realtime[key] !== undefined) await ws.update(`realtime.${key}`, s.realtime[key], target);
            }
          }
          if (s.acp?.contextPrompt !== undefined) await ws.update('acp.contextPrompt', s.acp.contextPrompt, target);
          if (s.tutor?.explanationMode !== undefined) await ws.update('tutor.explanationMode', s.tutor.explanationMode, target);
          if (s.interview) {
            if (s.interview.maxQuestions !== undefined) await ws.update('interview.maxQuestions', s.interview.maxQuestions, target);
            if (s.interview.difficulty !== undefined) await ws.update('interview.difficulty', s.interview.difficulty, target);
          }
          if (s.voiceMode !== undefined) await ws.update('voiceMode', s.voiceMode, target);
          this.postStatus('Settings saved.');
          }
          this.view?.webview.postMessage({ channel: 'settingsSaved' });
        } catch (error) {
          const message = `Could not save settings: ${(error as Error).message}`;
          logger.error(message);
          this.view?.webview.postMessage({ channel: 'settingsError', message });
        }
        break;
      }
    }
  }

  private showCapabilities(agentId: string): void {
    const agent = this.state.agents.find((item) => item.id === agentId);
    if (!agent) return;
    const output = vscode.window.createOutputChannel('Codebase Tutor: Agent Capabilities');
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
<title>Codebase Tutor</title>
<style>
  :root { color-scheme: light dark; --brand: #7c5cff; --brand-2: #36c5f0; --success: #3fb950; --danger: #f85149; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground, #f5f5f5); background: var(--vscode-sideBar-background, #111318); margin: 0; font-size: 13px; min-height: 100vh; }
  button { border: 0; border-radius: 8px; padding: 8px 12px; font: inherit; font-weight: 600; cursor: pointer; background: var(--vscode-button-background, var(--brand)); color: var(--vscode-button-foreground, #fff); transition: transform .15s ease, background .15s ease, opacity .15s ease; }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #6d4df0); transform: translateY(-1px); }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--vscode-focusBorder, var(--brand-2)); outline-offset: 2px; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.secondary { background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.08)); color: var(--vscode-button-secondaryForeground, inherit); }
  button.ghost { background: transparent; color: var(--vscode-descriptionForeground, #aaa); padding: 6px 8px; }
  button.danger { background: var(--danger); }
  .app-header { padding: 18px 16px 14px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,.08)); }
  .brand-mark { width: 34px; height: 34px; border-radius: 11px; display: grid; place-items: center; color: #fff; font-weight: 800; background: linear-gradient(135deg, var(--brand), var(--brand-2)); box-shadow: 0 8px 24px rgba(91,76,255,.25); }
  .brand-copy { min-width: 0; flex: 1; }
  .brand-copy h1 { font-size: 15px; margin: 0 0 2px; letter-spacing: -.2px; }
  .brand-copy p { margin: 0; color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
  .state-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 9px; padding: 4px 7px; border-radius: 999px; background: var(--vscode-badge-background, rgba(255,255,255,.1)); text-transform: uppercase; letter-spacing: .6px; }
  .state-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #8b949e; }
  .state-badge[data-state="listening"]::before { background: var(--success); box-shadow: 0 0 0 4px rgba(63,185,80,.14); }
  .state-badge[data-state="speaking"]::before { background: var(--brand-2); }
  .state-badge[data-state="thinking"]::before, .state-badge[data-state="connecting"]::before { background: #d29922; }
  .state-badge[data-state="ended"]::before { background: var(--danger); }
  main { padding: 14px 12px 20px; }
  .eyebrow { margin: 0 0 8px 2px; color: var(--vscode-descriptionForeground, #999); font-size: 10px; font-weight: 700; letter-spacing: .9px; text-transform: uppercase; }
  .mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 9px; }
  .mode-card { position: relative; min-height: 156px; padding: 14px; border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.1)); border-radius: 14px; background: var(--vscode-editor-background, #181b21); overflow: hidden; display: flex; flex-direction: column; }
  .mode-card::after { content: ''; position: absolute; width: 90px; height: 90px; right: -35px; top: -35px; border-radius: 50%; background: rgba(124,92,255,.12); }
  .mode-card.tutor::after { background: rgba(54,197,240,.12); }
  .mode-icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 10px; margin-bottom: 10px; font-size: 17px; background: rgba(124,92,255,.14); }
  .tutor .mode-icon { background: rgba(54,197,240,.14); }
  .mode-card h2 { font-size: 14px; margin: 0 0 5px; }
  .mode-card p { margin: 0 0 12px; color: var(--vscode-descriptionForeground, #aaa); font-size: 11px; line-height: 1.45; flex: 1; }
  .mode-card button { width: 100%; }
  .mode-card .tutor-action { background: #168aad; color: #fff; }
  .mode-card .coming-soon { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; opacity: .7; }
  .readiness { margin: 12px 0; padding: 10px 11px; border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.08)); border-radius: 10px; display: flex; gap: 9px; align-items: flex-start; background: color-mix(in srgb, var(--vscode-editor-background, #181b21) 88%, transparent); }
  .readiness-dot { width: 8px; height: 8px; border-radius: 50%; background: #d29922; margin-top: 4px; flex: 0 0 auto; }
  .readiness.ready .readiness-dot { background: var(--success); }
  .status { font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground, #aaa); min-width: 0; overflow-wrap: anywhere; }
  .utility-row { display: flex; align-items: center; gap: 3px; margin-bottom: 12px; }
  .utility-row .spacer { flex: 1; }
  .section { border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,.08)); padding-top: 12px; margin-top: 10px; }
  .section-heading { display: flex; align-items: center; margin-bottom: 9px; }
  .section-heading h3 { margin: 0; font-size: 12px; flex: 1; }
  .section-heading span { font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
  #agents { display: flex; flex-direction: column; gap: 7px; }
  .agent-card { border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.09)); border-radius: 11px; padding: 10px; cursor: pointer; transition: border-color .15s, background .15s; background: var(--vscode-editor-background, #181b21); }
  .agent-card.selected { border-color: var(--vscode-focusBorder, var(--brand)); background: rgba(124,92,255,.07); }
  .agent-card.unavailable { opacity: 0.6; }
  .agent-card-head { display: flex; align-items: center; gap: 8px; }
  .agent-card-head .name { font-weight: 600; flex: 1; }
  .agent-card-head .dot { width: 8px; height: 8px; border-radius: 50%; }
  .agent-card-head .dot.ok { background: var(--success); }
  .agent-card-head .dot.no { background: var(--danger); }
  .agent-card .desc { font-size: 10px; color: var(--vscode-descriptionForeground, #aaa); margin: 5px 0 0 16px; line-height: 1.35; }
  .agent-card .caps { font-size: 10px; margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
  .cap { background: var(--vscode-badge-background, rgba(255,255,255,.08)); color: var(--vscode-badge-foreground, inherit); padding: 2px 6px; border-radius: 6px; font-size: 9px; }
  .agent-card .actions { display: flex; gap: 6px; margin-top: 8px; }
  .agent-card .actions button { font-size: 10px; padding: 5px 8px; }
  .options-grid { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .opt-row { display: flex; align-items: center; gap: 6px; }
  .opt-row label { font-size: 10px; color: var(--vscode-descriptionForeground, #888); min-width: 70px; text-transform: uppercase; letter-spacing: 0.3px; }
  select { flex: 1; background: var(--vscode-dropdown-background, #292d35); color: var(--vscode-dropdown-foreground, inherit); border: 1px solid var(--vscode-dropdown-border, rgba(255,255,255,.12)); padding: 5px 7px; border-radius: 7px; font-size: 10px; }
  .session-meta { display: flex; gap: 14px; margin-bottom: 8px; font-size: 10px; color: var(--vscode-descriptionForeground, #aaa); }
  .session-meta b { color: var(--vscode-foreground, inherit); }
  #transcript { max-height: 280px; overflow-y: auto; min-height: 64px; }
  .empty-transcript { color: var(--vscode-descriptionForeground, #888); font-size: 11px; text-align: center; padding: 20px 8px; }
  .msg { margin: 6px 0; padding: 8px 9px; border-radius: 9px; font-size: 11px; line-height: 1.45; }
  .msg.agent { background: rgba(25,118,210,0.15); border-left: 3px solid #1976d2; }
  .msg.user { background: rgba(46,125,50,0.15); border-left: 3px solid #2e7d32; }
  .msg.system { background: rgba(102,102,102,0.15); border-left: 3px solid #888; font-size: 11px; }
  .msg.error { background: rgba(198,40,40,0.15); border-left: 3px solid #c62828; }
  .msg.file { background: rgba(255,152,0,0.15); border-left: 3px solid #ef6c00; font-family: monospace; font-size: 11px; }
  .msg .who { font-size: 9px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 100; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, #444); border-radius: 14px; padding: 18px; width: 92%; max-width: 560px; max-height: 88vh; overflow-y: auto; box-shadow: 0 18px 60px rgba(0,0,0,.48); }
  .modal h2 { font-size: 14px; margin: 0 0 12px; }
  .modal-section { margin-bottom: 14px; }
  .modal-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground, #888); margin-bottom: 6px; padding-bottom: 3px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
  .modal-section-title { cursor: pointer; display: flex; justify-content: space-between; padding: 7px 2px; }
  .modal-section-title::after { content: '⌄'; }
  .modal-section.collapsed > :not(.modal-section-title) { display: none; }
  .modal-section.collapsed .modal-section-title::after { content: '›'; }
  .modal-field { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
  .modal-field label { font-size: 10px; color: var(--vscode-descriptionForeground, #888); text-transform: uppercase; letter-spacing: 0.3px; }
  .modal-field input, .modal-field select, .modal-field textarea { background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #fff); border: 1px solid var(--vscode-input-border, #555); padding: 7px 9px; border-radius: 7px; font-size: 12px; font-family: var(--vscode-font-family, monospace); }
  .modal-field input:focus, .modal-field select:focus { outline: 1px solid var(--vscode-focusBorder, #0e639c); }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, #333); }
  .modal-hint { font-size: 10px; color: var(--vscode-descriptionForeground, #888); margin-top: 2px; }
  .audio-setup { display: grid; gap: 10px; }
  .audio-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 7px; align-items: end; }
  .audio-row label { display: block; font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .audio-row select { width: 100%; min-width: 0; font-size: 11px; }
  .test-status { display: inline-flex; gap: 5px; align-items: center; min-height: 18px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .test-status[data-status="success"] { color: var(--vscode-testing-iconPassed, var(--success)); }
  .test-status[data-status="failure"] { color: var(--vscode-testing-iconFailed, var(--danger)); }
  .test-status[data-status="testing"]::before { content: '◌'; }
  .test-status[data-status="success"]::before { content: '✓'; font-weight: 800; }
  .test-status[data-status="failure"]::before { content: '⚠'; }
  .test-status[data-status="untested"]::before { content: '○'; }
  @media (max-width: 280px) { .mode-grid { grid-template-columns: 1fr; } .brand-copy p { display: none; } }
</style>
</head>
<body>
  <header class="app-header">
    <div class="brand-mark">CT</div>
    <div class="brand-copy"><h1>Codebase Tutor</h1><p>Understand it. Then prove it.</p></div>
    <span id="state-badge" class="state-badge" data-state="idle">idle</span>
  </header>
  <main>
    <p class="eyebrow">Choose your path</p>
    <div class="mode-grid">
      <section class="mode-card tutor">
        <div class="mode-icon">⌘</div><h2>Code Tutor</h2>
        <p>Turn this repository into a clear, practical onboarding guide.</p>
        <button id="btn-tutor" class="tutor-action" disabled>Generate guide</button>
      </section>
      <section class="mode-card">
        <div class="mode-icon">?</div><h2>Ask Me Anything</h2>
        <p>Test your understanding with adaptive, code-aware questions.</p>
        <button id="btn-start">Start session</button>
      </section>
    </div>
    <div id="readiness" class="readiness"><span class="readiness-dot"></span><div id="status" class="status">Finding an available AI agent…</div></div>
    <div class="utility-row">
      <button id="btn-stop" class="danger" disabled>Stop session</button>
      <span class="spacer"></span>
      <button id="btn-refresh" class="ghost" title="Refresh agents">↻ Agents</button>
      <button id="btn-settings" class="ghost" title="Settings">⚙ Settings</button>
      <button id="btn-logs" class="ghost" title="Show logs">Logs</button>
    </div>
    <section class="section">
      <div class="section-heading"><h3>AI agent</h3><span>Reads your workspace</span></div>
      <div id="agents"></div>
    </section>
    <section class="section">
      <div class="section-heading"><h3>Session</h3><button id="btn-clear" class="ghost">Clear</button></div>
      <div class="session-meta"><span>Questions <b id="qcount">0</b></span><span>File <b id="lastfile">—</b></span></div>
      <div id="transcript"><div id="transcript-empty" class="empty-transcript">Your conversation will appear here.</div></div>
    </section>
    <section class="section audio-setup" aria-labelledby="audio-heading">
      <div class="section-heading"><h3 id="audio-heading">Audio setup</h3><button id="btn-audio-refresh" class="ghost" title="Refresh microphone list">↻ Refresh</button></div>
      <div class="audio-row">
        <div><label for="mic-device">Microphone</label><select id="mic-device" aria-describedby="mic-status"><option value="-1">System default</option></select></div>
        <button id="btn-mic" class="secondary">Test</button>
      </div>
      <div id="mic-status" class="test-status" data-status="untested" role="status" aria-live="polite">Not tested</div>
      <div class="audio-row">
        <div><label>Speaker</label><div class="status">System default output</div></div>
        <button id="btn-spk" class="secondary">Test</button>
      </div>
      <div id="speaker-status" class="test-status" data-status="untested" role="status" aria-live="polite">Not tested</div>
    </section>
  </main>

  <!-- Settings Modal -->
  <div class="modal-overlay" id="settings-modal">
    <div class="modal">
      <h2>Settings</h2>

      <div class="modal-section">
        <div class="modal-section-title">Session</div>
        <div class="modal-field"><label>Voice Mode</label><select id="voiceMode"><option value="auto">Auto</option><option value="chained">Chained</option><option value="realtime">Realtime</option></select></div>
        <div class="modal-field"><label>Max Questions (0 = unlimited)</label><input id="interview-maxQuestions" type="number" min="0" /></div>
        <div class="modal-field"><label>Difficulty</label><select id="interview-difficulty"><option value="adaptive">Adaptive</option><option value="junior">Junior</option><option value="mid">Mid</option><option value="senior">Senior</option><option value="staff">Staff</option></select></div>
        <div class="modal-field"><label>Default Guide Depth</label><select id="tutor-explanationMode"><option value="quick">Quick Overview</option><option value="guided">Guided Walkthrough</option><option value="deep">Deep Dive</option></select></div>
      </div>

      <div class="modal-section collapsed">
        <div class="modal-section-title">Realtime voice</div>
        <div class="modal-field"><label>Base URL</label><input id="realtime-baseUrl" type="text" /></div>
        <div class="modal-field"><label>Model</label><input id="realtime-model" type="text" /></div>
        <div class="modal-field"><label>API Key</label><input id="realtime-apiKey" type="password" autocomplete="off" /></div>
        <div class="modal-field"><label>Voice</label><input id="realtime-voice" type="text" /></div>
        <div class="modal-field"><label>Input Format</label><select id="realtime-inputFormat"><option>pcm16</option><option>g711_ulaw</option><option>g711_alaw</option><option>opus</option></select></div>
        <div class="modal-field"><label>Output Format</label><select id="realtime-outputFormat"><option>pcm16</option><option>g711_ulaw</option><option>g711_alaw</option><option>opus</option></select></div>
        <div class="modal-field"><label>Sample Rate</label><input id="realtime-sampleRate" type="number" min="8000" /></div>
        <div class="modal-field"><label>Turn Detection</label><select id="realtime-turnDetection"><option value="server_vad">Server VAD</option><option value="none">None</option></select></div>
        <div class="modal-field"><label>Instructions</label><textarea id="realtime-instructions" rows="5"></textarea></div>
      </div>

      <div class="modal-section collapsed">
        <div class="modal-section-title">STT (Speech-to-Text)</div>
        <div class="modal-field"><label>Base URL</label><input id="stt-baseUrl" type="text" /></div>
        <div class="modal-field"><label>Model</label><input id="stt-model" type="text" /></div>
        <div class="modal-field"><label>API Key</label><input id="stt-apiKey" type="password" /><div class="modal-hint">OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.</div></div>
        <div class="modal-field"><label>Path</label><input id="stt-path" type="text" /></div>
        <div class="modal-field"><label>Language</label><input id="stt-language" type="text" /></div>
      </div>

      <div class="modal-section collapsed">
        <div class="modal-section-title">TTS (Text-to-Speech)</div>
        <div class="modal-field"><label>Base URL</label><input id="tts-baseUrl" type="text" /></div>
        <div class="modal-field"><label>Model</label><input id="tts-model" type="text" /></div>
        <div class="modal-field"><label>API Key</label><input id="tts-apiKey" type="password" /><div class="modal-hint">Use "not-needed" for local Kokoro.</div></div>
        <div class="modal-field"><label>Voice</label><input id="tts-voice" type="text" /></div>
        <div class="modal-field"><label>Path</label><input id="tts-path" type="text" /></div>
      </div>

      <div class="modal-section collapsed">
        <div class="modal-section-title">Chat (Knowledge Evaluator)</div>
        <div class="modal-field"><label>Base URL</label><input id="chat-baseUrl" type="text" /></div>
        <div class="modal-field"><label>Model</label><input id="chat-model" type="text" /></div>
        <div class="modal-field"><label>API Key</label><input id="chat-apiKey" type="password" /><div class="modal-hint">OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.</div></div>
        <div class="modal-field"><label>Path</label><input id="chat-path" type="text" /></div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">Audio</div>
        <div class="modal-field"><label>FFmpeg/FFplay Path</label><input id="audio-ffmpegPath" type="text" /></div>
        <div class="modal-field"><label>Legacy FFmpeg Input Device</label><input id="audio-inputDevice" type="text" /><div class="modal-hint">Advanced: used by realtime FFmpeg capture. PortAudio selection is on the home screen.</div></div>
        <div class="modal-field"><label>Silence Seconds</label><input id="audio-silenceSeconds" type="number" step="0.1" min="0.3" /></div>
        <div class="modal-field"><label>Beep Enabled</label><select id="audio-beepEnabled"><option value="true">true</option><option value="false">false</option></select></div>
      </div>

      <div class="modal-section collapsed">
        <div class="modal-section-title">Advanced agent settings</div>
        <div class="modal-field"><label>Context Prompt</label><textarea id="acp-contextPrompt" rows="6"></textarea></div>
        <div class="modal-hint">Custom agents and structured agent configuration remain available in VS Code Settings.</div>
        <button id="btn-native-settings" class="secondary">Open VS Code Settings</button>
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
    const operationState = s.operation?.phase || s.interviewState;
    $('state-badge').textContent = s.operation ? (s.operation.kind === 'guide' ? 'guide' : operationState) : operationState;
    $('state-badge').dataset.state = operationState;
    $('qcount').textContent = s.questionCount;
    $('lastfile').textContent = s.lastFile || '-';
    $('status').textContent = s.statusText || '';
    const running = Boolean(s.operation) || ['listening','speaking','thinking','connecting'].includes(s.interviewState);
    const hasReadyAgent = Array.isArray(s.agents) && s.agents.some((agent) => agent.available);
    $('readiness').classList.toggle('ready', hasReadyAgent);
    $('btn-start').disabled = running || !hasReadyAgent;
    $('btn-tutor').disabled = running || !hasReadyAgent;
    $('btn-stop').disabled = !running;
    $('btn-stop').textContent = s.operation?.phase === 'cancelling' ? 'Stopping…' : s.operation?.kind === 'guide' ? 'Stop generation' : 'Stop session';
    renderAudio(s.audio);
    // Only re-render agents if the agent list actually changed (preserves dropdown selections)
    if (!sameAgents) renderAgents(s.agents, s.selectedId);
  }

  function renderAudio(audio) {
    if (!audio) return;
    const select = $('mic-device');
    const prior = String(audio.selectedId ?? -1);
    const items = [{ id: -1, name: 'System default', maxInputChannels: 1 }, ...(audio.devices || [])];
    const signature = JSON.stringify(items.map((d) => [d.id, d.name, d.id === audio.defaultId]));
    if (select.dataset.signature !== signature) {
      select.replaceChildren();
      for (const device of items) {
        const option = document.createElement('option');
        option.value = String(device.id);
        option.textContent = device.id === -1 ? 'System default' : device.name + (device.id === audio.defaultId ? ' (default)' : '');
        select.appendChild(option);
      }
      select.dataset.signature = signature;
    }
    const exists = items.some((d) => String(d.id) === prior);
    select.value = exists ? prior : '-1';
    select.disabled = audio.deviceStatus === 'loading' || audio.deviceStatus === 'failed';
    for (const [id, state] of [['mic-status', audio.micTest], ['speaker-status', audio.speakerTest]]) {
      const element = $(id);
      element.dataset.status = state?.status || 'untested';
      element.textContent = state?.message || 'Not tested';
    }
    $('btn-mic').disabled = audio.micTest?.status === 'testing' || audio.deviceStatus === 'failed';
    $('btn-spk').disabled = audio.speakerTest?.status === 'testing';
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
      const optionsHtml = optRows.length && a.id === selectedId
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
          <button data-act="select" data-id="\${a.id}" \${a.id === selectedId ? 'disabled' : ''}>\${a.id === selectedId ? 'Selected' : 'Use agent'}</button>
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
    $('transcript-empty')?.remove();
    const div = document.createElement('div');
    div.className = 'msg ' + entry.kind;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = { agent: 'Codebase Tutor', user: 'You', file: 'file', system: 'system', error: 'error' }[entry.kind] || entry.kind;
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
    else if (msg.channel === 'clearTranscript') $('transcript').innerHTML = '<div id="transcript-empty" class="empty-transcript">Your conversation will appear here.</div>';
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
      $('tutor-explanationMode').value = s.tutor?.explanationMode ?? 'guided';
      $('realtime-baseUrl').value = s.realtime?.baseUrl ?? '';
      $('realtime-model').value = s.realtime?.model ?? '';
      $('realtime-apiKey').value = s.realtime?.apiKey ?? '';
      $('realtime-voice').value = s.realtime?.voice ?? '';
      $('realtime-instructions').value = s.realtime?.instructions ?? '';
      $('realtime-inputFormat').value = s.realtime?.inputFormat ?? 'pcm16';
      $('realtime-outputFormat').value = s.realtime?.outputFormat ?? 'pcm16';
      $('realtime-sampleRate').value = s.realtime?.sampleRate ?? 24000;
      $('realtime-turnDetection').value = s.realtime?.turnDetection ?? 'server_vad';
      $('audio-inputDevice').value = s.audio?.inputDevice ?? '';
      $('acp-contextPrompt').value = s.acp?.contextPrompt ?? '';
      $('settings-modal').classList.add('open');
    }
    else if (msg.channel === 'settingsSaved') {
      $('btn-settings-save').disabled = false;
      $('btn-settings-save').textContent = 'Save';
      $('settings-modal').classList.remove('open');
    }
    else if (msg.channel === 'settingsError') {
      $('btn-settings-save').disabled = false;
      $('btn-settings-save').textContent = 'Retry save';
      $('status').textContent = msg.message;
    }
  });

  $('btn-start').addEventListener('click', () => vscode.postMessage({ command: 'start' }));
  $('btn-tutor').addEventListener('click', () => vscode.postMessage({ command: 'generateTutor' }));
  $('btn-stop').addEventListener('click', () => vscode.postMessage({ command: 'stop' }));
  $('btn-refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  $('btn-mic').addEventListener('click', () => vscode.postMessage({ command: 'testMic' }));
  $('btn-spk').addEventListener('click', () => vscode.postMessage({ command: 'testSpeaker' }));
  $('btn-audio-refresh').addEventListener('click', () => vscode.postMessage({ command: 'refreshAudioDevices' }));
  $('mic-device').addEventListener('change', (event) => vscode.postMessage({ command: 'selectMic', deviceId: Number(event.target.value) }));
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
  for (const title of document.querySelectorAll('.modal-section-title')) {
    title.setAttribute('role', 'button'); title.tabIndex = 0;
    const toggle = () => title.parentElement.classList.toggle('collapsed');
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
  }
  $('btn-native-settings').addEventListener('click', () => vscode.postMessage({ command: 'openNativeSettings' }));
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
        inputDevice: $('audio-inputDevice').value,
        inputDeviceId: Number($('mic-device').value),
        silenceSeconds: parseFloat($('audio-silenceSeconds').value) || 2.0,
        beepEnabled: $('audio-beepEnabled').value === 'true',
      },
      interview: {
        maxQuestions: parseInt($('interview-maxQuestions').value) || 0,
        difficulty: $('interview-difficulty').value,
      },
      voiceMode: $('voiceMode').value,
      realtime: {
        baseUrl: $('realtime-baseUrl').value, model: $('realtime-model').value,
        apiKey: $('realtime-apiKey').value, voice: $('realtime-voice').value,
        instructions: $('realtime-instructions').value,
        inputFormat: $('realtime-inputFormat').value, outputFormat: $('realtime-outputFormat').value,
        sampleRate: Number($('realtime-sampleRate').value) || 24000,
        turnDetection: $('realtime-turnDetection').value,
      },
      acp: { contextPrompt: $('acp-contextPrompt').value },
      tutor: { explanationMode: $('tutor-explanationMode').value },
    };
    $('btn-settings-save').disabled = true;
    $('btn-settings-save').textContent = 'Saving…';
    vscode.postMessage({ command: 'saveSettings', settings });
  });

  // Request current configs so dropdowns show saved values
  vscode.postMessage({ command: 'refresh' });
  vscode.postMessage({ command: 'refreshAudioDevices' });
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
