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
import { loadSession, saveSession, clearSession, StoredSession } from './interview/sessionStore';
import { findRecentCodexSessions, extractRelevantText } from './acp/codexHistory';
import { ChainedTurn } from './realtime/chained';
import { execSync } from 'child_process';
import { ExplanationMode, generateTutorGuide } from './tutor/generator';
import { BuildAccess } from './tutor/sourcePolicy';

let orchestrator: InterviewOrchestrator | null = null;
let homeView: HomeViewProvider | null = null;
let activeOperation: { kind: 'interview' | 'guide'; source: vscode.CancellationTokenSource; stopping: boolean } | null = null;

export function activate(context: vscode.ExtensionContext): void {
  logger.init();
  logger.log('Codebase Tutor extension activating.');
  initAgentConfigStorage(context.globalState);

  homeView = new HomeViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HomeViewProvider.viewType, homeView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('interviewLele.refreshAgents', () => homeView?.refresh()),
    vscode.commands.registerCommand('interviewLele.showLogs', () => showLogs(true)),
    vscode.commands.registerCommand('interviewLele.startInterview', () => runInterview(context)),
    vscode.commands.registerCommand('interviewLele.stopInterview', () => stopActiveOperation()),
    vscode.commands.registerCommand('interviewLele.testMic', () => testMic()),
    vscode.commands.registerCommand('interviewLele.testSpeaker', () => testSpeaker()),
    vscode.commands.registerCommand('interviewLele.clearSession', () => clearCachedSession(context)),
    vscode.commands.registerCommand('codebaseTutor.generateGuide', () => createTutorGuide())
  );
}

export function deactivate(): void {
  activeOperation?.source.cancel();
  activeOperation?.source.dispose();
  void orchestrator?.stop();
  logger.dispose();
}

async function runInterview(context: vscode.ExtensionContext): Promise<void> {
  const operation = beginOperation('interview', 'Preparing Ask Me Anything…');
  if (!operation) return;
  try {
    await startInterview(context, operation.source.token);
  } catch (error) {
    if (!(error instanceof vscode.CancellationError)) throw error;
    homeView?.postStatus('Ask Me Anything cancelled.');
    homeView?.setInterviewState('ended');
  } finally {
    finishOperation(operation);
  }
}

async function startInterview(context: vscode.ExtensionContext, operationToken: vscode.CancellationToken): Promise<void> {
  if (orchestrator && orchestrator.currentState !== 'idle' && orchestrator.currentState !== 'ended') {
    vscode.window.showWarningMessage('Ask Me Anything is already in progress.');
    homeView?.show();
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const cfg = loadConfig();
  if (cfg.voiceMode === 'realtime' && !cfg.realtime.apiKey) {
    const open = await vscode.window.showErrorMessage(
      'No Realtime API key configured. Set interviewLele.realtime.apiKey (or OPENAI_API_KEY env var), or switch voiceMode to auto/chained.',
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

  // ── Check for cached session ──────────────────────────────────────────
  const cached = await loadSession(context, workspaceRoot);
  let priorTranscript: ChainedTurn[] | undefined;
  let codebaseContext: CodebaseContext | undefined;

  if (cached) {
    const ageMs = Date.now() - cached.analyzedAt;
    const ageStr = ageMs < 60000 ? `${Math.round(ageMs / 1000)}s ago`
      : ageMs < 3600000 ? `${Math.round(ageMs / 60000)}m ago`
      : `${Math.round(ageMs / 3600000)}h ago`;

    // Check git HEAD for staleness warning
    let staleWarning = '';
    try {
      const head = execSync('git rev-parse HEAD', { cwd: workspaceRoot, encoding: 'utf8', timeout: 3000 }).trim();
      if (cached.gitHead && cached.gitHead !== head) {
        staleWarning = ' (⚠ codebase changed since last analysis)';
      }
    } catch { /* not a git repo or git unavailable */ }

    const choice = await vscode.window.showQuickPick(
      [
        {
          label: 'Resume previous interview',
          description: `Continue from ${cached.transcript.length} prior turns${staleWarning}`,
          detail: `Analyzed ${ageStr} with "${cached.agentId}" — ${cached.context.topics.length} topics`,
        },
        {
          label: 'Start fresh (reuse analysis)',
          description: 'Same codebase context, new conversation',
          detail: `Skip re-analysis, start Q&A from scratch`,
        },
        {
          label: 'Re-analyze from scratch',
          description: 'Discard cache, run full ACP analysis again',
          detail: 'Slowest option — use if code changed significantly',
        },
      ],
      { placeHolder: `Cached session found (analyzed ${ageStr})${staleWarning}. Choose an option:` }
    );

    if (!choice) return; // user dismissed

    if (choice.label === 'Resume previous interview') {
      codebaseContext = cached.context;
      priorTranscript = cached.transcript;
    } else if (choice.label === 'Start fresh (reuse analysis)') {
      codebaseContext = cached.context;
    }
    // else: Re-analyze — leave codebaseContext undefined, fall through to full analysis
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
    if (e.kind === 'agent_message' && e.text) logger.log(`Knowledge evaluator: ${e.text}`);
    if (e.kind === 'error' && e.text) logger.error(e.text);
    if (e.kind === 'log' && e.text) logger.log(e.text);
  };

  let agentConfig: Awaited<ReturnType<typeof getAgentConfig>> | undefined;

  // ── If no cached context, run full analysis ──────────────────────────
  if (!codebaseContext) {
    homeView?.postStatus(`Gathering codebase context with "${agent.name}"...`);
    try {
      if (agent.resolved) {
        agentConfig = await getAgentConfig(agent.id);
        logger.log(`Using agent config for ${agent.id}: ${JSON.stringify(agentConfig)}`);
        codebaseContext = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Codebase Tutor: ${agent.name} is analyzing the codebase`,
            cancellable: true,
          },
          async (progress, token) => {
            const linked = token.onCancellationRequested(() => activeOperation?.source.cancel());
            progress.report({ increment: 0, message: 'Starting ACP agent...' });
            try {
              return await gatherCodebaseContext({
                cwd: workspaceRoot, agent, agentConfig, contextPrompt: cfg.acp.contextPrompt,
                onProgress: (msg) => {
                  progress.report({ message: msg });
                  homeView?.setOperation('interview', 'analyzing', msg);
                  homeView?.postStatus(msg);
                  logger.log(msg);
                },
                onAgentMessage: () => { /* streamed; not posted to keep UI clean during analysis */ },
                token: operationToken,
              });
            } finally { linked.dispose(); }
          }
        );
      } else {
        codebaseContext = await fallbackContext(workspaceRoot);
      }
    } catch (e) {
      if (e instanceof vscode.CancellationError || operationToken.isCancellationRequested) throw new vscode.CancellationError();
      vscode.window.showErrorMessage(`Failed to gather context: ${(e as Error).message}. Falling back to workspace scan.`);
      codebaseContext = await fallbackContext(workspaceRoot);
    }

    // ── Codex CLI history enrichment (best-effort, never blocks) ────────
    try {
      const codexSessions = findRecentCodexSessions(workspaceRoot, 2);
      if (codexSessions.length > 0) {
        const snippets = codexSessions.map((s) => extractRelevantText(s.path, 2000)).filter((t) => t.length > 0);
        if (snippets.length > 0) {
          const enrichment = snippets.join('\n\n---\n\n');
          codebaseContext = {
            ...codebaseContext,
            summary: `${codebaseContext.summary}\n\nPRIOR CONTEXT FROM CODEX CLI HISTORY:\n${enrichment}`,
          };
          logger.log(`[codexHistory] Enriched analysis with ${snippets.length} Codex CLI session(s)`);
        }
      }
    } catch (e) {
      logger.log(`[codexHistory] Enrichment skipped: ${(e as Error).message}`);
    }

    // ── Save the freshly analyzed context ───────────────────────────────
    let gitHead: string | undefined;
    try {
      gitHead = execSync('git rev-parse HEAD', { cwd: workspaceRoot, encoding: 'utf8', timeout: 3000 }).trim();
    } catch { /* not a git repo */ }

    const session: StoredSession = {
      workspaceRoot,
      analyzedAt: Date.now(),
      context: codebaseContext,
      agentId: agent.id,
      supportsAcpResume: false,
      gitHead,
      transcript: [],
    };
    await saveSession(context, session);
  }

  homeView?.postStatus(`Context ready. ${codebaseContext.topics.length} topics, ${codebaseContext.files.length} files. Connecting voice...`);

  orchestrator = new InterviewOrchestrator();
  if (homeView) orchestrator.setHomeView(homeView);
  await orchestrator.start({
    config: cfg,
    context: codebaseContext,
    workspaceRoot,
    onEvent,
    token: operationToken,
    agent,
    agentConfig,
    priorTranscript,
    extContext: context,
  });
}

async function stopActiveOperation(): Promise<void> {
  const operation = activeOperation;
  if (!operation || operation.stopping) return;
  operation.stopping = true;
  homeView?.setOperation(operation.kind, 'cancelling', operation.kind === 'guide' ? 'Stopping guide generation…' : 'Stopping Ask Me Anything…');
  operation.source.cancel();
  if (operation.kind === 'interview' && orchestrator) {
    await orchestrator.stop((e) => homeView?.postEvent(e));
    homeView?.setInterviewState('ended');
  }
}

async function createTutorGuide(): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before generating a Code Tutor guide.');
    return;
  }

  if (!homeView?.agents.length) await homeView?.refresh();
  const agent = homeView?.selectedAgent ?? homeView?.agents.find((item) => item.available);
  if (!agent?.available || !agent.resolved) {
    vscode.window.showErrorMessage('No available ACP agent. Refresh agents or install a supported agent first.');
    return;
  }

  const preferredMode = loadConfig().tutor.explanationMode;
  const guideChoices = [
    { label: 'Guided Walkthrough', description: 'About 10 minutes · source code only', mode: 'guided' as ExplanationMode, buildAccess: 'source-only' as BuildAccess },
    { label: 'Quick Overview', description: 'About 5 minutes · source code only', mode: 'quick' as ExplanationMode, buildAccess: 'source-only' as BuildAccess },
    { label: 'Deep Dive', description: '15+ minutes · source code only', mode: 'deep' as ExplanationMode, buildAccess: 'source-only' as BuildAccess },
    { label: 'Guided Walkthrough + build/config', description: 'About 10 minutes · include approved build and infrastructure files', mode: 'guided' as ExplanationMode, buildAccess: 'include-build-config' as BuildAccess },
    { label: 'Quick Overview + build/config', description: 'About 5 minutes · include approved build and infrastructure files', mode: 'quick' as ExplanationMode, buildAccess: 'include-build-config' as BuildAccess },
    { label: 'Deep Dive + build/config', description: '15+ minutes · include approved build and infrastructure files', mode: 'deep' as ExplanationMode, buildAccess: 'include-build-config' as BuildAccess },
  ];
  guideChoices.sort((a, b) => Number(b.mode === preferredMode && b.buildAccess === 'source-only') - Number(a.mode === preferredMode && a.buildAccess === 'source-only'));
  const picked = await vscode.window.showQuickPick(guideChoices, { title: 'Codebase Tutor: Guide options', placeHolder: 'Choose explanation depth and repository access' });
  if (!picked) return;
  await vscode.workspace.getConfiguration('interviewLele').update('tutor.explanationMode', picked.mode, vscode.ConfigurationTarget.Global);

  const outputUri = vscode.Uri.joinPath(workspaceRoot, 'CODEBASE_TUTOR.md');
  try {
    await vscode.workspace.fs.stat(outputUri);
    const choice = await vscode.window.showWarningMessage(
      'CODEBASE_TUTOR.md already exists. Replace it with a newly generated guide?',
      { modal: true },
      'Replace guide'
    );
    if (choice !== 'Replace guide') return;
  } catch {
    // The guide does not exist yet.
  }

  homeView?.postStatus(`${agent.name} is reading the repository…`);
  const operation = beginOperation('guide', `${agent.name} is reading relevant source files…`);
  if (!operation) return;
  try {
    const config = await getAgentConfig(agent.id);
    const guide = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Codebase Tutor: ${agent.name} is creating your guide`,
        cancellable: true,
      },
      async (progress, token) => {
        const linked = token.onCancellationRequested(() => operation.source.cancel());
        try {
          return await generateTutorGuide({
            cwd: workspaceRoot.fsPath, agent, agentConfig: config,
            mode: picked.mode, buildAccess: picked.buildAccess, token: operation.source.token,
            onProgress: (message) => {
              progress.report({ message });
              homeView?.setOperation('guide', 'analyzing', message);
            },
          });
        } finally { linked.dispose(); }
      }
    );
    if (operation.source.token.isCancellationRequested) throw new vscode.CancellationError();
    homeView?.setOperation('guide', 'writing', 'Writing CODEBASE_TUTOR.md…');
    await vscode.workspace.fs.writeFile(outputUri, Buffer.from(guide, 'utf8'));
    const document = await vscode.workspace.openTextDocument(outputUri);
    await vscode.window.showTextDocument(document, { preview: false });
    homeView?.postStatus('Code Tutor guide is ready: CODEBASE_TUTOR.md');
    vscode.window.showInformationMessage('Codebase Tutor created CODEBASE_TUTOR.md.');
  } catch (error) {
    if (error instanceof vscode.CancellationError || operation.source.token.isCancellationRequested) {
      homeView?.postStatus('Guide generation cancelled.');
      return;
    }
    const message = `Could not create the Code Tutor guide: ${(error as Error).message}`;
    logger.error(message);
    homeView?.postStatus(message);
    vscode.window.showErrorMessage(message);
  } finally {
    finishOperation(operation);
  }
}

function beginOperation(kind: 'interview' | 'guide', status: string): typeof activeOperation {
  if (activeOperation) {
    void vscode.window.showWarningMessage(`${activeOperation.kind === 'guide' ? 'Guide generation' : 'Ask Me Anything'} is already in progress.`);
    homeView?.show();
    return null;
  }
  activeOperation = { kind, source: new vscode.CancellationTokenSource(), stopping: false };
  homeView?.setOperation(kind, 'preparing', status);
  return activeOperation;
}

function finishOperation(operation: NonNullable<typeof activeOperation>): void {
  if (activeOperation !== operation) return;
  operation.source.dispose();
  activeOperation = null;
  homeView?.clearOperation();
}

function showLogs(notify: boolean): void {
  logger.show();
  if (notify) void vscode.window.showInformationMessage('Check the Codebase Tutor channel in the Output panel for detailed logs.');
}

async function clearCachedSession(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }
  await clearSession(context, workspaceRoot);
  vscode.window.showInformationMessage('Codebase Tutor: Cached session cleared. Next Ask Me Anything will re-analyze from scratch.');
  logger.log('Cached session cleared by user.');
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
    summary: `Workspace at ${workspaceRoot}. No ACP agent was used; Ask Me Anything will work from a shallow file scan of ${files.length} source files.`,
    files,
    topics,
  };
}

async function testMic(): Promise<void> {
  homeView?.setAudioTest('micTest', 'testing', 'Listening for audio…');
  logger.log('Testing microphone via PortAudio (naudiodon2)...');
  try {
    const { PortAudioMicCapture } = await import('./audio/portAudioMic');
    const cfg = loadConfig();
    let captured = 0;
    let frames = 0;
    let failure: Error | null = null;
    const mic = new PortAudioMicCapture({
      sampleRate: 16000, channels: 1, deviceId: cfg.audio.inputDeviceId,
      rmsStart: 0.006, rmsStop: 0.004, silenceMs: 2000, minSpeechMs: 200, preRollMs: 500,
    });
    mic.on('recording', (wav: Buffer) => {
      captured += wav.length;
      logger.log(`Captured ${wav.length} bytes WAV (${(wav.length / 16000 / 2).toFixed(2)}s)`);
    });
    mic.on('speech_start', () => logger.log('Speech detected...'));
    mic.on('speech_end', () => logger.log('Speech ended.'));
    mic.on('level', () => { frames += 1; });
    mic.on('error', (e) => { failure = e; logger.error(`Mic error: ${e.message}`); });
    mic.on('log', (l) => logger.log(`[paMic] ${l}`));
    mic.start();
    logger.log('Listening for 3 seconds...');
    await new Promise((r) => setTimeout(r, 3000));
    await mic.stop();
    if (failure) throw failure;
    if (!frames) throw new Error('The microphone opened but returned no audio frames.');
    const message = captured > 0 ? 'Available · speech detected' : 'Available · audio signal received';
    logger.log(`Microphone OK. ${frames} level frames received.`);
    homeView?.setAudioTest('micTest', 'success', message);
  } catch (e) {
    logger.error(`PortAudio mic test failed: ${(e as Error).message}`);
    homeView?.setAudioTest('micTest', 'failure', (e as Error).message);
  }
}

async function testSpeaker(): Promise<void> {
  const cfg = loadConfig();
  homeView?.setAudioTest('speakerTest', 'testing', 'Playing test audio…');
  // Try Kokoro TTS first — say a short phrase
  logger.log(`Testing TTS via ${cfg.tts.baseUrl}${cfg.tts.path} (voice=${cfg.tts.voice})...`);
  try {
    const { ChainedVoiceProvider } = await import('./realtime/chained');
    const chained = new ChainedVoiceProvider(cfg);
    const mp3 = await chained.synthesize('Hello, this is a test of the text to speech system.');
    logger.log(`TTS returned ${mp3.length} bytes. Playing via ffplay...`);
    const { spawn } = require('child_process');
    const ffplay = cfg.audio.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffplay$1');
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffplay, ['-nodisp', '-autoexit', '-nostats', '-loglevel', 'quiet', '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      p.on('error', reject);
      p.on('exit', (code: number | null) => code === 0 ? resolve() : reject(new Error(`ffplay exited with code ${code}`)));
      p.stdin?.write(mp3);
      p.stdin?.end();
    });
    logger.log('TTS test complete. If you heard speech, Kokoro TTS works.');
    homeView?.setAudioTest('speakerTest', 'success', 'Playback completed');
  } catch (e) {
    logger.error(`TTS test failed: ${(e as Error).message}`);
    logger.log('Falling back to tone test...');
    const pb = new AudioPlayback({ sampleRate: cfg.realtime.sampleRate, channels: 1, ffmpegPath: cfg.audio.ffmpegPath });
    try {
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
      homeView?.setAudioTest('speakerTest', 'success', 'Fallback tone completed');
    } catch (fallbackError) {
      homeView?.setAudioTest('speakerTest', 'failure', (fallbackError as Error).message);
    }
  }
}
