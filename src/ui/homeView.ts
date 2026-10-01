import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
  public static readonly viewType = 'codeSensei.home';
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
  private playbackCallbacks = new Map<number, () => void>();
  private playbackIdCounter = 0;

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



  /** Play an audio blob (MP3/WAV) in the webview. Resolves when playback completes. */
  playAudioBlob(base64: string, mimeType: string): Promise<void> {
    if (!this.view) return Promise.resolve();
    const id = ++this.playbackIdCounter;
    return new Promise<void>((resolve) => {
      this.playbackCallbacks.set(id, resolve);
      this.view!.webview.postMessage({ channel: 'playBlob', base64, mimeType, playbackId: id });
    });
  }

  /** Play a beep WAV in the webview. Fire and forget. */
  playBeepWav(base64: string): void {
    this.view?.webview.postMessage({ channel: 'playBeep', base64 });
  }

  /**
   * Immediately stop any TTS/beep audio currently playing in the webview.
   * Call this as soon as "Stop" is pressed — otherwise the in-progress
   * `playAudioBlob()` await only resolves when the audio finishes naturally,
   * so the assistant keeps talking until its current line is done.
   */
  stopAudio(): void {
    this.view?.webview.postMessage({ channel: 'stopAudio' });
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
          this.postState();
          try {
            await vscode.workspace.getConfiguration('codeSensei').update('acp.selectedAgentId', m.agentId, vscode.ConfigurationTarget.Global);
          } catch (e) {
            logger.error(`Failed to persist selected agent: ${(e as Error).message}`);
          }
        }
        break;
      case 'start':
        vscode.commands.executeCommand('codeSensei.startInterview');
        break;
      case 'generateTutor':
        vscode.commands.executeCommand('codeSensei.generateGuide');
        break;
      case 'stop':
        vscode.commands.executeCommand('codeSensei.stopInterview');
        break;
      case 'testMic':
        vscode.commands.executeCommand('codeSensei.testMic');
        break;
      case 'refreshAudioDevices':
        await this.refreshAudioDevices();
        break;
      case 'selectMic':
        if (Number.isInteger(Number(m.deviceId))) {
          const id = Number(m.deviceId);
          await vscode.workspace.getConfiguration('codeSensei').update('audio.inputDeviceId', id, vscode.ConfigurationTarget.Global);
          this.state.audio.selectedId = id;
          this.state.audio.micTest = { status: 'untested', message: 'Not tested' };
          this.postState();
        }
        break;
      case 'testSpeaker':
        vscode.commands.executeCommand('codeSensei.testSpeaker');
        break;
      case 'showLogs':
        vscode.commands.executeCommand('codeSensei.showLogs');
        break;
      case 'openNativeSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'codeSensei');
        break;
      case 'openExternal':
        if (m.url) vscode.env.openExternal(vscode.Uri.parse(m.url));
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
      case 'playbackDone': {
        if (m.playbackId && this.playbackCallbacks.has(m.playbackId)) {
          const cb = this.playbackCallbacks.get(m.playbackId)!;
          this.playbackCallbacks.delete(m.playbackId);
          cb();
        }
        break;
      }
      case 'setOption': {
        if (m.agentId && m.option && m.value !== undefined) {
          const config = await getAgentConfig(m.agentId);
          const updated = { ...config } as Record<string, unknown>;
          if (m.value === '') delete updated[m.option];
          else updated[m.option] = m.value;
          await saveAgentConfig(m.agentId, updated);
          this.view?.webview.postMessage({ channel: 'configUpdated', agentId: m.agentId, config: updated });
        }
        break;
      }
      case 'getSettings': {
        const cfg = loadConfig();
        const raw = vscode.workspace.getConfiguration('codeSensei');
        // Never expose API keys inherited from the extension-host environment.
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
          const ws = vscode.workspace.getConfiguration('codeSensei');
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
            if (s.tts.responseFormat !== undefined) await ws.update('tts.responseFormat', s.tts.responseFormat, target);
          }
          if (s.chat) {
            if (s.chat.baseUrl !== undefined) await ws.update('chat.baseUrl', s.chat.baseUrl, target);
            if (s.chat.model !== undefined) await ws.update('chat.model', s.chat.model, target);
            if (s.chat.apiKey !== undefined) await ws.update('chat.apiKey', s.chat.apiKey, target);
            if (s.chat.path !== undefined) await ws.update('chat.path', s.chat.path, target);
          }
          if (s.audio) {
            if (s.audio.inputDeviceId !== undefined) await ws.update('audio.inputDeviceId', s.audio.inputDeviceId, target);
            if (s.audio.silenceSeconds !== undefined) await ws.update('audio.silenceSeconds', s.audio.silenceSeconds, target);
            if (s.audio.beepEnabled !== undefined) await ws.update('audio.beepEnabled', s.audio.beepEnabled, target);
          }
          if (s.acp?.contextPrompt !== undefined) await ws.update('acp.contextPrompt', s.acp.contextPrompt, target);
          if (s.tutor?.explanationMode !== undefined) await ws.update('tutor.explanationMode', s.tutor.explanationMode, target);
          if (s.interview) {
            if (s.interview.maxQuestions !== undefined) await ws.update('interview.maxQuestions', s.interview.maxQuestions, target);
            if (s.interview.difficulty !== undefined) await ws.update('interview.difficulty', s.interview.difficulty, target);
          }
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
    const output = vscode.window.createOutputChannel('AI CodeSensei: Agent Capabilities');
    output.show();
    output.appendLine(JSON.stringify(agent.capabilities ?? { message: 'No capabilities probed. Click Refresh.' }, null, 2));
  }


  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const fontUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'fonts', file)).toString();
    // Read the logo SVG at runtime so we can inline it — inline SVGs inherit
    // `currentColor` from CSS, so the logo automatically adapts to light/dark theme.
    let logoSvg = '';
    try {
      logoSvg = fs.readFileSync(
        path.join(this.extensionUri.fsPath, 'media', 'codesensei-logo.svg'),
        'utf8'
      );
    } catch { /* fallback: no logo */ }
    return (
      /*html*/
      `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; media-src blob: data:; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AI CodeSensei</title>
<style>
  @font-face { font-family: 'Poppins'; font-style: normal; font-weight: 400; src: url('${fontUri('poppins-400.ttf')}') format('truetype'); }
  @font-face { font-family: 'Poppins'; font-style: normal; font-weight: 500; src: url('${fontUri('poppins-500.ttf')}') format('truetype'); }
  @font-face { font-family: 'Poppins'; font-style: normal; font-weight: 600; src: url('${fontUri('poppins-600.ttf')}') format('truetype'); }
  @font-face { font-family: 'Poppins'; font-style: normal; font-weight: 700; src: url('${fontUri('poppins-700.ttf')}') format('truetype'); }
  @font-face { font-family: 'Space Mono'; font-style: normal; font-weight: 400; src: url('${fontUri('spacemono-400.ttf')}') format('truetype'); }
  @font-face { font-family: 'Space Mono'; font-style: normal; font-weight: 700; src: url('${fontUri('spacemono-700.ttf')}') format('truetype'); }
  :root {
    color-scheme: light dark;
    --brand: #7c5cff;
    --brand-glow: rgba(124, 92, 255, 0.25);
    --brand-2: #36c5f0;
    --brand-2-glow: rgba(54, 197, 240, 0.2);
    --success: #3fb950;
    --danger: #f85149;
    --border-light: rgba(255, 255, 255, 0.08);
    --text-muted: var(--vscode-descriptionForeground, #8e9cae);
    --font-ui: 'Poppins', var(--vscode-font-family, system-ui, sans-serif);
    --font-mono: 'Space Mono', var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  body { font-family: var(--font-ui); color: var(--vscode-foreground, #f5f5f5); background: var(--vscode-sideBar-background, #111318); margin: 0; font-size: 12.5px; min-height: 100vh; line-height: 1.3; }
  button { border: 0; border-radius: 8px; padding: 8px 12px; font: inherit; font-weight: 600; cursor: pointer; background: var(--vscode-button-background, var(--brand)); color: var(--vscode-button-foreground, #fff); transition: transform .15s ease, background .15s ease, opacity .15s ease; }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #6d4df0); transform: translateY(-1px); }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--vscode-focusBorder, var(--brand-2)); outline-offset: 2px; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.secondary { background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.08)); color: var(--vscode-button-secondaryForeground, inherit); }
  button.ghost { background: transparent; color: var(--vscode-descriptionForeground, #aaa); padding: 6px 8px; }
  button.danger { background: var(--danger); }
  .app-header { padding: 10px 12px 9px; display: flex; align-items: center; gap: 9px; border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,.08)); }
  .credits { padding: 4px 12px 6px; font-size: 10px; color: var(--vscode-descriptionForeground, #8e9cae); border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,.08)); font-family: 'Poppins', 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif; }
  .credits a { color: var(--vscode-textLink-foreground, var(--brand-2)); text-decoration: none; }
  .credits a:hover { text-decoration: underline; }
  .brand-mark { width: 26px; height: 26px; display: grid; place-items: center; flex: 0 0 auto; color: var(--vscode-foreground, #f5f5f5); }
  .brand-mark svg { width: 22px; height: 22px; display: block; }
  .brand-copy { min-width: 0; flex: 1; }
  .brand-copy h1 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: -.2px; }
  .state-badge { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: 8.5px; padding: 3px 6px; border-radius: 999px; background: var(--vscode-badge-background, rgba(255,255,255,.1)); text-transform: uppercase; letter-spacing: .4px; flex: 0 0 auto; }
  .state-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #8b949e; }
  .state-badge[data-state="listening"]::before { background: var(--success); box-shadow: 0 0 0 4px rgba(63,185,80,.14); }
  .state-badge[data-state="speaking"]::before { background: var(--brand-2); }
  .state-badge[data-state="thinking"]::before, .state-badge[data-state="connecting"]::before { background: #d29922; }
  .state-badge[data-state="ended"]::before { background: var(--danger); }
  .state-badge[data-state="cancelling"]::before { background: var(--danger); animation: ct-pulse 1s ease-in-out infinite; }
  .state-badge[data-state="cancelling"]::after { content: ''; animation: ct-dots 1.4s steps(4, end) infinite; margin-left: 1px; }
  @keyframes ct-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.7); } }
  @keyframes ct-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } 100% { content: ''; } }
  main { padding: 9px 12px 14px; }
  .mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 7px; }
  .mode-card { position: relative; min-height: 88px; padding: 10px; border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.1)); border-radius: 12px; background: var(--vscode-editor-background, #181b21); overflow: hidden; display: flex; flex-direction: column; }
  .mode-card::after { content: ''; position: absolute; width: 70px; height: 70px; right: -30px; top: -30px; border-radius: 50%; background: rgba(124,92,255,.12); }
  .mode-card.tutor::after { background: rgba(54,197,240,.12); }
  .mode-icon { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 8px; margin-bottom: 6px; font-size: 13px; background: rgba(124,92,255,.14); }
  .tutor .mode-icon { background: rgba(54,197,240,.14); }
  .mode-card h2 { font-size: 12.5px; font-weight: 600; margin: 0 0 3px; flex: 1; }
  .mode-card button { width: 100%; padding: 6px 10px; font-size: 11px; }
  .mode-card .tutor-action { background: #168aad; color: #fff; }
  .readiness { margin: 7px 0; padding: 7px 9px; border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.08)); border-radius: 9px; display: flex; gap: 8px; align-items: flex-start; background: color-mix(in srgb, var(--vscode-editor-background, #181b21) 88%, transparent); }
  .readiness-dot { width: 7px; height: 7px; border-radius: 50%; background: #d29922; margin-top: 3px; flex: 0 0 auto; }
  .readiness.ready .readiness-dot { background: var(--success); }
  .status { font-size: 10.5px; line-height: 1.35; color: var(--vscode-descriptionForeground, #aaa); min-width: 0; overflow-wrap: anywhere; }
  .utility-row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .utility-row .spacer { flex: 1; }
  .utility-row button.ghost { padding: 5px 9px; font-size: 10.5px; }
  .utility-row button.danger { padding: 6px 12px; font-size: 10.5px; }
  .waveform-wrap { margin: 6px 0 3px; height: 42px; display: none; border-radius: 9px; overflow: hidden; background: color-mix(in srgb, var(--vscode-editor-background, #181b21) 92%, transparent); border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.06)); }
  .waveform-wrap.active { display: block; }
  .waveform-wrap canvas { width: 100%; height: 100%; display: block; }
  .section { border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,.08)); padding-top: 8px; margin-top: 6px; }
  .section-heading { display: flex; align-items: center; margin-bottom: 6px; }
  .section-heading h3 { margin: 0; font-size: 11px; font-weight: 600; flex: 1; }
  #agents { display: flex; flex-direction: column; gap: 5px; }
  .agent-card { border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.09)); border-radius: 10px; padding: 8px; cursor: pointer; transition: border-color .15s, background .15s; background: var(--vscode-editor-background, #181b21); }
  .agent-card.selected { border-color: var(--vscode-focusBorder, var(--brand)); background: rgba(124,92,255,.07); }
  .agent-card.unavailable { opacity: 0.6; }
  .agent-card-head { display: flex; align-items: center; gap: 7px; }
  .agent-card-head .name { font-weight: 600; flex: 1; font-size: 11.5px; }
  .agent-card-head .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
  .agent-card-head .dot.ok { background: var(--success); }
  .agent-card-head .dot.no { background: var(--danger); }
  .agent-card-head .status-tag { font-family: var(--font-mono); font-size: 9px; opacity: 0.7; }
  .agent-card .desc { font-size: 10px; color: var(--vscode-descriptionForeground, #aaa); margin: 5px 0 0 14px; line-height: 1.3; }
  .agent-card .actions { display: flex; gap: 6px; margin-top: 6px; }
  .agent-card .actions button { font-size: 10px; padding: 4px 8px; }
  .options-grid { display: flex; flex-direction: column; gap: 4px; margin-top: 5px; }
  .opt-row { display: flex; align-items: center; gap: 6px; }
  .opt-row label { font-size: 9.5px; color: var(--vscode-descriptionForeground, #888); min-width: 62px; text-transform: uppercase; letter-spacing: 0.3px; }
  select { flex: 1; background: var(--vscode-dropdown-background, #292d35); color: var(--vscode-dropdown-foreground, inherit); border: 1px solid var(--vscode-dropdown-border, rgba(255,255,255,.12)); padding: 4px 6px; border-radius: 6px; font-size: 10px; }
  .session-meta { display: flex; gap: 12px; margin-bottom: 6px; font-size: 10px; color: var(--vscode-descriptionForeground, #aaa); }
  .session-meta b { font-family: var(--font-mono); color: var(--vscode-foreground, inherit); }
  #transcript { max-height: 260px; overflow-y: auto; min-height: 56px; }
  .empty-transcript { color: var(--vscode-descriptionForeground, #888); font-size: 10.5px; text-align: center; padding: 14px 8px; }
  .msg { margin: 5px 0; padding: 7px 8px; border-radius: 8px; font-size: 10.5px; line-height: 1.4; }
  .msg.agent { background: rgba(25,118,210,0.15); border-left: 3px solid #1976d2; }
  .msg.user { background: rgba(46,125,50,0.15); border-left: 3px solid #2e7d32; }
  .msg.system { background: rgba(102,102,102,0.15); border-left: 3px solid #888; font-size: 11px; }
  .msg.error { background: rgba(198,40,40,0.15); border-left: 3px solid #c62828; }
  .msg.file { background: rgba(255,152,0,0.15); border-left: 3px solid #ef6c00; font-family: var(--font-mono); font-size: 10px; }
  .msg .who { font-size: 8.5px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  /* Modal Overlay - Slide-in Side Panel */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: var(--vscode-sideBar-background, #111318);
    transform: translateX(100%);
    visibility: hidden;
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.3s;
    z-index: 100;
    display: flex;
    flex-direction: column;
  }
  .modal-overlay.open {
    transform: translateX(0);
    visibility: visible;
  }
  .modal {
    width: 100%;
    height: 100%;
    max-height: 100vh;
    padding: 16px;
    display: flex;
    flex-direction: column;
    background: transparent;
    border: none;
    box-shadow: none;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
  }
  .modal-body {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    padding-right: 4px;
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .modal-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-light);
  }
  .btn-back {
    background: transparent;
    padding: 6px 10px 6px 6px;
    color: var(--text-muted);
    font-size: 16px;
    line-height: 1;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    cursor: pointer;
  }
  .btn-back:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--vscode-foreground);
    transform: none;
  }
  .modal-header h2 {
    font-size: 15px;
    margin: 0;
    font-weight: 700;
    letter-spacing: -0.2px;
  }
  .modal-section {
    border: 1px solid var(--border-light);
    border-radius: 10px;
    margin-bottom: 10px;
    background: rgba(255, 255, 255, 0.01);
    overflow: visible;
    transition: background 0.2s ease, border-color 0.2s ease;
    flex: 0 0 auto;
  }
  .modal-section.collapsed {
    overflow: hidden;
  }
  .modal-section:hover {
    background: rgba(255, 255, 255, 0.03);
    border-color: rgba(255, 255, 255, 0.12);
  }
  .modal-section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px;
    user-select: none;
    transition: color 0.2s ease;
  }
  .modal-section-title:hover {
    color: var(--vscode-foreground);
  }
  .modal-section-title::after {
    content: '⌄';
    font-size: 14px;
    opacity: 0.6;
    transition: transform 0.2s ease;
  }
  .modal-section.collapsed .modal-section-title::after {
    content: '›';
  }
  .modal-section-body {
    padding: 0 14px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 1000px;
    transition: max-height 0.3s cubic-bezier(0, 1, 0, 1), opacity 0.2s ease;
    opacity: 1;
  }
  .modal-section.collapsed .modal-section-body {
    max-height: 0;
    padding-bottom: 0;
    opacity: 0;
    pointer-events: none;
  }
  .modal-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .modal-field label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .modal-field input, .modal-field select, .modal-field textarea {
    background: var(--vscode-input-background, rgba(0, 0, 0, 0.2));
    color: var(--vscode-input-foreground, #fff);
    border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.1));
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 12px;
    font-family: inherit;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    width: 100%;
  }
  .modal-field select {
    position: relative;
    z-index: 20;
    appearance: auto;
  }
  .modal-field input:focus, .modal-field select:focus, .modal-field textarea:focus {
    border-color: var(--vscode-focusBorder, var(--brand-2));
    box-shadow: 0 0 0 3px var(--brand-2-glow);
    outline: none;
  }
  .modal-footer {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 14px;
    border-top: 1px solid var(--border-light);
    background: var(--vscode-sideBar-background, #111318);
    position: sticky;
    bottom: 0;
    z-index: 10;
  }
  .modal-footer button {
    flex: 1;
  }
  .modal-hint {
    font-size: 10px;
    color: var(--text-muted);
    opacity: 0.8;
    margin-top: 2px;
    line-height: 1.3;
  }
  .audio-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .audio-row label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .audio-row-inner {
    display: flex;
    gap: 8px;
    width: 100%;
    align-items: center;
  }
  .audio-row-inner select {
    flex: 1;
    min-width: 0;
  }
  .audio-row-inner button {
    flex-shrink: 0;
  }
  .test-status {
    font-size: 10px;
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border-light);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 10px 0;
    width: max-content;
  }
  .test-status[data-status="success"] {
    background: rgba(63, 185, 80, 0.1);
    border-color: rgba(63, 185, 80, 0.25);
    color: var(--vscode-testing-iconPassed, var(--success));
  }
  .test-status[data-status="failure"] {
    background: rgba(248, 81, 73, 0.1);
    border-color: rgba(248, 81, 73, 0.25);
    color: var(--vscode-testing-iconFailed, var(--danger));
  }
  .test-status[data-status="testing"] {
    background: rgba(210, 153, 34, 0.1);
    border-color: rgba(210, 153, 34, 0.25);
    color: #d29922;
  }
  .test-status[data-status="testing"]::before { content: '◌'; }
  .test-status[data-status="success"]::before { content: '✓'; font-weight: 800; }
  .test-status[data-status="failure"]::before { content: '⚠'; }
  .test-status[data-status="untested"]::before { content: '○'; }
  @media (max-width: 280px) { .mode-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <header class="app-header">
    <div class="brand-mark">${logoSvg}</div>
    <div class="brand-copy"><h1>AI CodeSensei</h1></div>
    <span id="state-badge" class="state-badge" data-state="idle">idle</span>
  </header>
  <div class="credits">Built with ❤ by <a href="https://github.com/sharadcodes" target="_blank" rel="noopener">sharadcodes</a> · <a href="https://github.com/g-savitha" target="_blank" rel="noopener">g-savitha</a> · <a href="https://github.com/iamnabina" target="_blank" rel="noopener">iamnabina</a></div>
  <main>
    <div class="mode-grid">
      <section class="mode-card">
        <div class="mode-icon">?</div><h2>Knowledge Check</h2>
        <button id="btn-start">Start session</button>
      </section>
      <section class="mode-card tutor">
        <div class="mode-icon">⌘</div><h2>Code Tutor</h2>
        <button id="btn-tutor" class="tutor-action" disabled>Generate guide</button>
      </section>
    </div>
    <div id="readiness" class="readiness"><span class="readiness-dot"></span><div id="status" class="status">Finding an available AI agent…</div></div>
    <div id="waveform-wrap" class="waveform-wrap"><canvas id="waveform-canvas"></canvas></div>
    <div class="utility-row">
      <button id="btn-stop" class="danger" disabled>Stop session</button>
      <span class="spacer"></span>
      <button id="btn-refresh" class="ghost" title="Refresh agents">↻ Agents</button>
      <button id="btn-settings" class="ghost" title="Settings">⚙ Settings</button>
      <button id="btn-logs" class="ghost" title="Show logs">Logs</button>
    </div>
    <section class="section">
      <div class="section-heading"><h3>AI agent</h3></div>
      <div id="agents"></div>
    </section>
    <section class="section">
      <div class="section-heading"><h3>Session</h3><button id="btn-clear" class="ghost">Clear</button></div>
      <div class="session-meta"><span>Questions <b id="qcount">0</b></span><span>File <b id="lastfile">—</b></span></div>
      <div id="transcript"><div id="transcript-empty" class="empty-transcript">Your conversation will appear here.</div></div>
    </section>
  </main>

  <!-- Settings Modal -->
  <div class="modal-overlay" id="settings-modal">
    <div class="modal">
      <div class="modal-header">
        <button class="btn-back" id="btn-settings-back" title="Go back">←</button>
        <h2>Settings</h2>
      </div>

      <div class="modal-body">

        <div class="modal-section collapsed">
          <div class="modal-section-title">Session</div>
          <div class="modal-section-body">
            <div class="modal-field">
              <label>Max Questions (0 = unlimited)</label>
              <input id="interview-maxQuestions" type="number" min="0" />
            </div>
            <div class="modal-field">
              <label>Difficulty</label>
              <select id="interview-difficulty">
                <option value="adaptive">Adaptive</option>
                <option value="junior">Junior</option>
                <option value="mid">Mid</option>
                <option value="senior">Senior</option>
                <option value="staff">Staff</option>
              </select>
            </div>
            <div class="modal-field">
              <label>Default Guide Depth</label>
              <select id="tutor-explanationMode">
                <option value="quick">Quick Overview</option>
                <option value="guided">Guided Walkthrough</option>
                <option value="deep">Deep Dive</option>
              </select>
            </div>
          </div>
        </div>

        <div class="modal-section collapsed">
          <div class="modal-section-title">STT (Speech-to-Text)</div>
          <div class="modal-section-body">
            <div class="modal-field">
              <label>Base URL</label>
              <input id="stt-baseUrl" type="text" />
            </div>
            <div class="modal-field">
              <label>Model</label>
              <input id="stt-model" type="text" />
            </div>
            <div class="modal-field">
              <label>API Key</label>
              <input id="stt-apiKey" type="password" />
              <div class="modal-hint">OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.</div>
            </div>
            <div class="modal-field">
              <label>Path</label>
              <input id="stt-path" type="text" />
            </div>
            <div class="modal-field">
              <label>Language</label>
              <input id="stt-language" type="text" />
            </div>
          </div>
        </div>

        <div class="modal-section collapsed">
          <div class="modal-section-title">TTS (Text-to-Speech)</div>
          <div class="modal-section-body">
            <div class="modal-field">
              <label>Base URL</label>
              <input id="tts-baseUrl" type="text" />
            </div>
            <div class="modal-field">
              <label>Model</label>
              <input id="tts-model" type="text" />
            </div>
            <div class="modal-field">
              <label>API Key</label>
              <input id="tts-apiKey" type="password" />
              <div class="modal-hint">Use "not-needed" for local Kokoro.</div>
            </div>
            <div class="modal-field">
              <label>Voice</label>
              <input id="tts-voice" type="text" />
            </div>
            <div class="modal-field">
              <label>Path</label>
              <input id="tts-path" type="text" />
            </div>
            <div class="modal-field">
              <label>Response Format</label>
              <select id="tts-responseFormat">
                <option value="wav">wav</option>
                <option value="flac">flac</option>
                <option value="ogg">ogg</option>
                <option value="mp3">mp3</option>
                <option value="opus">opus</option>
              </select>
              <div class="modal-hint">Kokoro supports wav/flac/ogg. OpenAI TTS supports mp3/opus.</div>
            </div>
          </div>
        </div>

        <div class="modal-section collapsed">
          <div class="modal-section-title">Chat (Knowledge Evaluator)</div>
          <div class="modal-section-body">
            <div class="modal-field">
              <label>Base URL</label>
              <input id="chat-baseUrl" type="text" />
            </div>
            <div class="modal-field">
              <label>Model</label>
              <input id="chat-model" type="text" />
            </div>
            <div class="modal-field">
              <label>API Key</label>
              <input id="chat-apiKey" type="password" />
              <div class="modal-hint">OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.</div>
            </div>
            <div class="modal-field">
              <label>Path</label>
              <input id="chat-path" type="text" />
            </div>
          </div>
        </div>

        <div class="modal-section collapsed">
          <div class="modal-section-title">Audio</div>
          <div class="modal-section-body">
            <div class="audio-row">
              <label for="mic-device">Microphone</label>
              <div class="audio-row-inner">
                <select id="mic-device" aria-describedby="mic-status">
                  <option value="-1">System default</option>
                </select>
                <button id="btn-audio-refresh" class="secondary" title="Refresh microphone list">↻</button>
              </div>
            </div>
            <div class="audio-row">
              <div class="audio-row-inner" style="margin-top: 4px;">
                <button id="btn-mic" class="secondary" style="flex: 1;">Test mic</button>
                <div id="mic-status" class="test-status" data-status="untested" role="status" aria-live="polite">Not tested</div>
              </div>
            </div>

            <div style="height: 1px; background: var(--border-light); margin: 6px 0;"></div>

            <div class="audio-row">
              <label>Speaker</label>
              <div class="audio-row-inner" style="margin-top: 4px;">
                <div class="status" style="flex: 1; opacity: 0.8; font-size: 11px;">System default output</div>
                <button id="btn-spk" class="secondary">Test speaker</button>
              </div>
              <div id="speaker-status" class="test-status" data-status="untested" role="status" aria-live="polite">Not tested</div>
            </div>

            <div style="height: 1px; background: var(--border-light); margin: 6px 0;"></div>

            <div class="modal-field">
              <label>Silence Seconds</label>
              <input id="audio-silenceSeconds" type="number" step="0.1" min="0.3" />
            </div>
            <div class="modal-field">
              <label>Beep Enabled</label>
              <select id="audio-beepEnabled">
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </div>
          </div>
        </div>

        <div class="modal-section collapsed">
          <div class="modal-section-title">Advanced agent settings</div>
          <div class="modal-section-body">
            <div class="modal-field">
              <label>Context Prompt</label>
              <textarea id="acp-contextPrompt" rows="6"></textarea>
            </div>
            <div class="modal-hint" style="margin-bottom: 6px;">Custom agents and structured agent configuration remain available in VS Code Settings.</div>
            <button id="btn-native-settings" class="secondary" style="width: 100%;">Open VS Code Settings</button>
          </div>
        </div>

      </div>

      <div class="modal-footer">
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
    const prev = window.__lastState;
    const sameAgents = JSON.stringify(prev?.agents) === JSON.stringify(s.agents);
    const selectionChanged = prev?.selectedId !== s.selectedId;
    window.__lastState = s;
    // 'operation' stays non-null for the entire interview (set → cleared only
    // when it fully ends), but its 'phase' is only ever updated during the
    // pre-conversation setup steps ('preparing'/'analyzing'). Once the live
    // voice loop starts, only 'interviewState' keeps advancing
    // (listening/thinking/speaking) — prefer it once we're actually there,
    // or the badge and waveform get stuck showing "analyzing" forever.
    const liveInterviewState = ['listening', 'speaking', 'thinking'].includes(s.interviewState) ? s.interviewState : null;
    const operationState = liveInterviewState || s.operation?.phase || s.interviewState;
    const cancelling = s.operation?.phase === 'cancelling';
    $('state-badge').textContent = cancelling ? 'Stopping' : (s.operation ? (s.operation.kind === 'guide' ? 'guide' : operationState) : operationState);
    $('state-badge').dataset.state = cancelling ? 'cancelling' : operationState;
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
    updateWaveformVisibility(cancelling ? 'cancelling' : operationState);
    // Re-render agents when the list or the selected agent changes (preserves dropdown selections otherwise)
    if (!sameAgents || selectionChanged) renderAgents(s.agents, s.selectedId);
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
      // Full description + capability JSON are already one click away via the
      // "Capabilities" button — don't repeat them inline on every card. Only
      // surface the unavailable reason, since that's actionable info.
      const descHtml = !a.available && a.unavailableReason ? '<div class="desc">' + a.unavailableReason + '</div>' : '';
      card.innerHTML = \`
        <div class="agent-card-head">
          <span class="dot \${a.available ? 'ok' : 'no'}"></span>
          <span class="name">\${a.name}</span>
          <span class="status-tag">\${a.available ? 'ready' : 'unavailable'}</span>
        </div>
        \${descHtml}
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

  // ─── Audio playback via Web Audio API ───────────────────────────
  let audioCtx = null;
  let pcmStartTime = 0;

  function ensureAudioCtx(sampleRate) {
    if (!audioCtx || (sampleRate && audioCtx.sampleRate !== sampleRate)) {
      if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
      try { audioCtx = new AudioContext(sampleRate ? { sampleRate } : undefined); } catch (e) { audioCtx = new AudioContext(); }
    }
    if (audioCtx.state === 'suspended') { audioCtx.resume().catch(() => {}); }
    return audioCtx;
  }

  // Pre-warm AudioContext on any user gesture so autoplay policy is satisfied
  function prewarmAudio() {
    const ctx = ensureAudioCtx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  document.addEventListener('click', prewarmAudio, true);
  document.addEventListener('keydown', prewarmAudio, true);

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ─── Waveform visualization ──────────────────────────────────────
  const wfCanvas = $('waveform-canvas');
  const wfCtx = wfCanvas.getContext('2d');
  let wfAnimId = 0;
  let wfMicData = null;   // { wave: number[], rms, peak } from mic
  let wfSpeaking = false;  // true when AI is speaking
  let wfPhase = 0;         // animation phase for speaking waveform

  function resizeWfCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = wfCanvas.clientWidth || 200;
    const h = wfCanvas.clientHeight || 48;
    wfCanvas.width = w * dpr;
    wfCanvas.height = h * dpr;
    wfCtx.scale(dpr, dpr);
  }

  function drawWaveform() {
    const w = wfCanvas.clientWidth || 200;
    const h = wfCanvas.clientHeight || 48;
    wfCtx.clearRect(0, 0, w, h);

    if (wfSpeaking) {
      // Synthetic animated bars for AI speaking
      const bars = 32;
      const barW = w / bars * 0.6;
      const gap = w / bars * 0.4;
      const cy = h / 2;
      for (let i = 0; i < bars; i++) {
        const phase = wfPhase + i * 0.3;
        const amp = (Math.sin(phase) * 0.4 + Math.sin(phase * 2.3) * 0.3 + 0.5) * (h * 0.35);
        const x = i * (barW + gap) + gap / 2;
        const grad = wfCtx.createLinearGradient(0, cy - amp, 0, cy + amp);
        grad.addColorStop(0, 'rgba(54,197,240,0.8)');
        grad.addColorStop(0.5, 'rgba(124,92,255,0.9)');
        grad.addColorStop(1, 'rgba(54,197,240,0.8)');
        wfCtx.fillStyle = grad;
        wfCtx.fillRect(x, cy - amp, barW, amp * 2);
      }
      wfPhase += 0.08;
    } else if (wfMicData && wfMicData.wave) {
      // Real mic waveform
      const wave = wfMicData.wave;
      const n = wave.length;
      const barW = w / n * 0.7;
      const gap = w / n * 0.3;
      const cy = h / 2;
      for (let i = 0; i < n; i++) {
        const amp = Math.abs(wave[i]) * (h * 0.42);
        const x = i * (barW + gap) + gap / 2;
        wfCtx.fillStyle = wfMicData.recording ? 'rgba(63,185,80,0.85)' : 'rgba(124,92,255,0.7)';
        wfCtx.fillRect(x, cy - amp, barW, amp * 2);
      }
    } else {
      // Idle: flat line
      wfCtx.strokeStyle = 'rgba(255,255,255,0.12)';
      wfCtx.lineWidth = 1.5;
      wfCtx.beginPath();
      wfCtx.moveTo(0, h / 2);
      wfCtx.lineTo(w, h / 2);
      wfCtx.stroke();
    }
    wfAnimId = requestAnimationFrame(drawWaveform);
  }

  function startWaveform() {
    if (!wfAnimId) { resizeWfCanvas(); drawWaveform(); }
  }

  function stopWaveform() {
    if (wfAnimId) { cancelAnimationFrame(wfAnimId); wfAnimId = 0; }
    wfMicData = null;
    wfSpeaking = false;
    const w = wfCanvas.clientWidth || 200;
    const h = wfCanvas.clientHeight || 48;
    wfCtx.clearRect(0, 0, w, h);
  }

  function updateWaveformVisibility(state) {
    const wrap = $('waveform-wrap');
    const active = ['listening','speaking','thinking','connecting'].includes(state);
    if (active) {
      wrap.classList.add('active');
      wfSpeaking = (state === 'speaking');
      if (!wfAnimId) startWaveform();
    } else {
      wrap.classList.remove('active');
      stopWaveform();
    }
  }

  window.addEventListener('resize', () => { if (wfAnimId) resizeWfCanvas(); });

  // Currently-playing audio source nodes (TTS + beeps), so 'stopAudio' can
  // silence them immediately instead of waiting for playback to end naturally.
  const activeAudioSources = [];

  // Play a decoded audio buffer (WAV/MP3) through AudioContext at a scheduled time
  function playDecodedBuffer(ctx, arrayBuffer, onDone) {
    ctx.decodeAudioData(arrayBuffer, (decoded) => {
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      activeAudioSources.push(src);
      src.onended = () => {
        const idx = activeAudioSources.indexOf(src);
        if (idx >= 0) activeAudioSources.splice(idx, 1);
        onDone();
      };
      src.start(0);
    }, (err) => onDone());
  }

  // Stop any audio currently playing (called when the user hits "Stop").
  // Calling .stop() on a BufferSourceNode still fires its 'onended' handler,
  // so the extension-side playAudioBlob() await resolves normally.
  function stopAllAudio() {
    for (const src of activeAudioSources.slice()) {
      try { src.stop(0); } catch (e) { /* already stopped */ }
    }
  }

  function appendTranscript(entry) {
    const el = $('transcript');
    $('transcript-empty')?.remove();
    const div = document.createElement('div');
    div.className = 'msg ' + entry.kind;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = { agent: 'AI CodeSensei', user: 'You', file: 'file', system: 'system', error: 'error' }[entry.kind] || entry.kind;
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
    else if (msg.channel === 'audioLevel') { if (!wfSpeaking) wfMicData = msg.level; }
    else if (msg.channel === 'configUpdated') { if (msg.agentId && msg.config) currentConfigs[msg.agentId] = msg.config; }
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
      $('tts-responseFormat').value = s.tts?.responseFormat ?? 'wav';
      $('chat-baseUrl').value = s.chat?.baseUrl ?? '';
      $('chat-model').value = s.chat?.model ?? '';
      $('chat-apiKey').value = s.chat?.apiKey ?? '';
      $('chat-path').value = s.chat?.path ?? '';
      $('audio-silenceSeconds').value = s.audio?.silenceSeconds ?? 2.0;
      $('audio-beepEnabled').value = String(s.audio?.beepEnabled ?? true);
      $('interview-maxQuestions').value = s.interview?.maxQuestions ?? 0;
      $('interview-difficulty').value = s.interview?.difficulty ?? 'adaptive';
      $('tutor-explanationMode').value = s.tutor?.explanationMode ?? 'guided';
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

    else if (msg.channel === 'playBlob') {
      const ctx = ensureAudioCtx();
      const bytes = base64ToBytes(msg.base64);
      // Use AudioContext.decodeAudioData for reliable playback after pre-warming
      playDecodedBuffer(ctx, bytes.buffer.slice(0), () => {
        vscode.postMessage({ command: 'playbackDone', playbackId: msg.playbackId });
      });
    }
    else if (msg.channel === 'playBeep') {
      const ctx = ensureAudioCtx();
      const bytes = base64ToBytes(msg.base64);
      playDecodedBuffer(ctx, bytes.buffer.slice(0), () => {});
    }
    else if (msg.channel === 'stopAudio') {
      stopAllAudio();
    }
  });

  // Intercept clicks on external links → open in system browser via extension host
  // Single delegated handler on document to avoid duplicate firings.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="https://"]');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ command: 'openExternal', url: a.getAttribute('href') });
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
  $('btn-settings-back').addEventListener('click', () => {
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
        responseFormat: $('tts-responseFormat').value,
      },
      chat: {
        baseUrl: $('chat-baseUrl').value,
        model: $('chat-model').value,
        apiKey: $('chat-apiKey').value,
        path: $('chat-path').value,
      },
      audio: {
        inputDeviceId: Number($('mic-device').value),
        silenceSeconds: parseFloat($('audio-silenceSeconds').value) || 2.0,
        beepEnabled: $('audio-beepEnabled').value === 'true',
      },
      interview: {
        maxQuestions: parseInt($('interview-maxQuestions').value) || 0,
        difficulty: $('interview-difficulty').value,
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
