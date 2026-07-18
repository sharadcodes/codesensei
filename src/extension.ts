import * as vscode from 'vscode';
import * as path from 'path';
import { loadConfig } from './config';
import { HomeViewProvider } from './ui/homeView';
import { InterviewOrchestrator, InterviewEvent } from './interview/orchestrator';
import { gatherCodebaseContext } from './acp/context';
import { DiscoveredAgent } from './acp/registry';
import { CodebaseContext } from './types';
import { MicCapture } from './audio/capture';
import { AudioPlayback } from './audio/playback';
import { logger } from './logger';
import { getAgentConfig, initAgentConfigStorage } from './acp/agentConfigUi';

let orchestrator: InterviewOrchestrator | null = null;
let homeView: HomeViewProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  logger.init();
  logger.log('Interview Lele extension activating.');
  initAgentConfigStorage(context.globalState);

  homeView = new HomeViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HomeViewProvider.viewType, homeView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('interviewLele.refreshAgents', () => homeView?.refresh()),
    vscode.commands.registerCommand('interviewLele.showLogs', () => logger.show()),
    vscode.commands.registerCommand('interviewLele.startInterview', () => startInterview(context)),
    vscode.commands.registerCommand('interviewLele.stopInterview', () => stopInterview()),
    vscode.commands.registerCommand('interviewLele.testMic', () => testMic()),
    vscode.commands.registerCommand('interviewLele.testSpeaker', () => testSpeaker())
  );
}

export function deactivate(): void {
  void orchestrator?.stop();
  logger.dispose();
}

async function startInterview(context: vscode.ExtensionContext): Promise<void> {
  if (orchestrator && orchestrator.currentState !== 'idle' && orchestrator.currentState !== 'ended') {
    vscode.window.showWarningMessage('Interview already in progress.');
    homeView?.show();
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const cfg = loadConfig();
  if (!cfg.realtime.apiKey) {
    const open = await vscode.window.showErrorMessage(
      'No Realtime API key configured. Set interviewLele.realtime.apiKey (or OPENAI_API_KEY env var).',
      'Open Settings'
    );
    if (open) vscode.commands.executeCommand('workbench.action.openSettings', 'interviewLele');
    return;
  }

  // Ensure agents are discovered
  if (homeView) {
    const homeAny = homeView as unknown as { state: { agents: DiscoveredAgent[] } };
    if (homeAny.state?.agents?.length === 0) {
      await homeView.refresh();
    }
  }
  const agent = await pickAgent();
  if (!agent) return;
  if (!agent.available || !agent.resolved) {
    const cont = await vscode.window.showWarningMessage(
      `Agent "${agent.name}" is not launchable.${agent.unavailableReason ? ` ${agent.unavailableReason}` : ''} Continue with a fallback (no ACP context)?`,
      'Continue without agent',
      'Cancel'
    );
    if (cont !== 'Continue without agent') return;
  }

  homeView?.show();
  homeView?.setInterviewState('connecting');
  homeView?.postStatus(`Gathering codebase context with "${agent.name}"...`);

  const onEvent = (e: InterviewEvent) => {
    homeView?.postEvent(e);
    if (e.kind === 'state' && e.state) {
      homeView?.setInterviewState(e.state);
      logger.log(`State -> ${e.state}`);
    }
    if (e.kind === 'question_count') homeView?.setQuestionCount(Number(e.text ?? 0));
    if (e.kind === 'file_opened' && e.filePath) {
      homeView?.setLastFile(e.filePath);
      logger.log(`Opened file ${e.filePath}:${e.lineStart}-${e.lineEnd}`);
    }
    if (e.kind === 'agent_message' && e.text) logger.log(`Interviewer: ${e.text}`);
    if (e.kind === 'error' && e.text) logger.error(e.text);
    if (e.kind === 'log' && e.text) logger.log(e.text);
  };

  let codebaseContext: CodebaseContext;
  const tokenSrc = new vscode.CancellationTokenSource();
  let agentConfig: Awaited<ReturnType<typeof getAgentConfig>> | undefined;
  try {
    if (agent.resolved) {
      agentConfig = await getAgentConfig(agent.id);
      logger.log(`Using agent config for ${agent.id}: ${JSON.stringify(agentConfig)}`);
      codebaseContext = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Interview Lele: ${agent.name} is analyzing the codebase`,
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ increment: 0, message: 'Starting ACP agent...' });
          return gatherCodebaseContext({
            cwd: workspaceRoot,
            agent,
            agentConfig,
            contextPrompt: cfg.acp.contextPrompt,
            onProgress: (msg) => {
              progress.report({ message: msg });
              homeView?.postStatus(msg);
              logger.log(msg);
            },
            onAgentMessage: () => {
              /* streamed; not posted to keep UI clean during analysis */
            },
            token,
          });
        }
      );
    } else {
      codebaseContext = await fallbackContext(workspaceRoot);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to gather context: ${(e as Error).message}. Falling back to workspace scan.`);
    codebaseContext = await fallbackContext(workspaceRoot);
  }

  homeView?.postStatus(`Context ready. ${codebaseContext.topics.length} topics, ${codebaseContext.files.length} files. Connecting voice...`);

  orchestrator = new InterviewOrchestrator();
  if (homeView) orchestrator.setHomeView(homeView);
  await orchestrator.start({
    config: cfg,
    context: codebaseContext,
    workspaceRoot,
    onEvent,
    token: tokenSrc.token,
    agent,
    agentConfig,
  });
}

async function stopInterview(): Promise<void> {
  if (!orchestrator) return;
  await orchestrator.stop((e) => homeView?.postEvent(e));
  homeView?.postStatus('Interview stopped.');
  homeView?.setInterviewState('ended');
}

async function pickAgent(): Promise<DiscoveredAgent | null> {
  // Read from homeView's discovered agents
  const agents: DiscoveredAgent[] = (homeView as any)?.['state']?.agents ?? [];
  if (agents.length === 0) {
    vscode.window.showErrorMessage('No ACP agents discovered. Install codex or devin and refresh.');
    return null;
  }
  const cfg = loadConfig();
  if (cfg.acp.selectedAgentId) {
    const found = agents.find((a) => a.id === cfg.acp.selectedAgentId);
    if (found) return found;
  }
  const firstAvailable = agents.find((a) => a.available);
  if (firstAvailable) return firstAvailable;
  return agents[0];
}

async function fallbackContext(workspaceRoot: string): Promise<CodebaseContext> {
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.cs', '.cpp', '.c', '.m', '.swift', '.php']);
  const files: { path: string; role: string }[] = [];
  const topics: { title: string; filePath: string; lineStart: number; lineEnd: number; rationale: string }[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || files.length > 40) return;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build' || name === 'target' || name === '.git') continue;
        await walk(path.join(dir, name), depth + 1);
      } else if (type === vscode.FileType.File) {
        const ext = path.extname(name);
        if (!exts.has(ext)) continue;
        const full = path.join(dir, name);
        const rel = path.relative(workspaceRoot, full).replace(/\\/g, '/');
        files.push({ path: rel, role: 'source file' });
        if (topics.length < 8) {
          topics.push({ title: `Walk through ${rel}`, filePath: rel, lineStart: 1, lineEnd: 30, rationale: 'General walkthrough of a key source file.' });
        }
      }
    }
  }

  await walk(workspaceRoot, 0);
  return {
    summary: `Workspace at ${workspaceRoot}. No ACP agent was used; the interviewer will work from a shallow file scan of ${files.length} source files.`,
    files,
    topics,
  };
}

async function testMic(): Promise<void> {
  logger.show();
  logger.log('Testing microphone via PortAudio (naudiodon2)...');
  try {
    const { PortAudioMicCapture } = await import('./audio/portAudioMic');
    let captured = 0;
    const mic = new PortAudioMicCapture({
      sampleRate: 16000, channels: 1, deviceId: -1,
      rmsStart: 0.006, rmsStop: 0.004, silenceMs: 2000, minSpeechMs: 200, preRollMs: 500,
    });
    mic.on('recording', (wav: Buffer) => {
      captured += wav.length;
      logger.log(`Captured ${wav.length} bytes WAV (${(wav.length / 16000 / 2).toFixed(2)}s)`);
    });
    mic.on('speech_start', () => logger.log('Speech detected...'));
    mic.on('speech_end', () => logger.log('Speech ended.'));
    mic.on('error', (e) => logger.error(`Mic error: ${e.message}`));
    mic.on('log', (l) => logger.log(`[paMic] ${l}`));
    mic.start();
    logger.log('Listening for 5 seconds. Speak into the microphone...');
    await new Promise((r) => setTimeout(r, 5000));
    await mic.stop();
    logger.log(captured > 0 ? `Microphone OK. Captured ${captured} bytes total.` : 'No speech detected. Try selecting a different mic device in settings.');
  } catch (e) {
    logger.error(`PortAudio mic test failed: ${(e as Error).message}`);
  }
}

async function testSpeaker(): Promise<void> {
  const cfg = loadConfig();
  logger.show();
  // Try Kokoro TTS first — say a short phrase
  logger.log(`Testing TTS via ${cfg.tts.baseUrl}${cfg.tts.path} (voice=${cfg.tts.voice})...`);
  try {
    const { ChainedVoiceProvider } = await import('./realtime/chained');
    const chained = new ChainedVoiceProvider(cfg);
    const mp3 = await chained.synthesize('Hello, this is a test of the text to speech system.');
    logger.log(`TTS returned ${mp3.length} bytes. Playing via ffplay...`);
    const { spawn } = require('child_process');
    const ffplay = cfg.audio.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffplay$1');
    await new Promise<void>((resolve) => {
      const p = spawn(ffplay, ['-nodisp', '-autoexit', '-nostats', '-loglevel', 'quiet', '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      p.on('error', () => resolve());
      p.on('exit', () => resolve());
      p.stdin?.write(mp3);
      p.stdin?.end();
    });
    logger.log('TTS test complete. If you heard speech, Kokoro TTS works.');
  } catch (e) {
    logger.error(`TTS test failed: ${(e as Error).message}`);
    logger.log('Falling back to tone test...');
    const pb = new AudioPlayback({ sampleRate: cfg.realtime.sampleRate, channels: 1, ffmpegPath: cfg.audio.ffmpegPath });
    pb.start();
    const sr = cfg.realtime.sampleRate;
    const buf = Buffer.alloc(sr * 2);
    for (let i = 0; i < sr; i++) {
      const v = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.2 * 32767;
      buf.writeInt16LE(Math.round(v), i * 2);
    }
    pb.feed(buf);
    await pb.flush();
    logger.log('Tone test done.');
  }
}
