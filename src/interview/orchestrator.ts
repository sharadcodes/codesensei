import * as vscode from 'vscode';
import { FullConfig, VoiceMode } from '../config';
import { CodebaseContext } from '../types';
import { MicCapture } from '../audio/capture';
import { AudioPlayback } from '../audio/playback';
import { PortAudioMicCapture } from '../audio/portAudioMic';
import { playListeningBeep } from '../audio/beep';
import { AcpClient } from '../acp/client';
import { DiscoveredAgent } from '../acp/registry';
import { AgentConfig } from '../acp/agentConfig';
import { OpenAIRealtimeProvider } from '../realtime/openai';
import { ChainedVoiceProvider } from '../realtime/chained';
import { RealtimeTool } from '../realtime/provider';
import { openAndHighlight, clearHighlights } from '../ui/highlight';
import { logger } from '../logger';
import { HomeViewProvider } from '../ui/homeView';

export interface InterviewEvent {
  kind:
    | 'state'
    | 'agent_message'
    | 'user_transcript'
    | 'file_opened'
    | 'error'
    | 'log'
    | 'question_count';
  text?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  state?: InterviewState;
}

export type InterviewState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'thinking'
  | 'ended';

export interface InterviewStartOptions {
  config: FullConfig;
  context: CodebaseContext;
  workspaceRoot: string;
  onEvent: (e: InterviewEvent) => void;
  token?: vscode.CancellationToken;
  agent?: DiscoveredAgent;
  agentConfig?: AgentConfig;
}

const OPEN_FILE_TOOL: RealtimeTool = {
  type: 'function',
  name: 'open_file',
  description:
    'Open a source file in the editor and highlight a specific line range so the user can see the code you are about to ask about. Call this BEFORE you ask the question whenever you focus on a concrete piece of code.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Repo-relative file path.' },
      lineStart: { type: 'integer', description: '1-based start line (inclusive).' },
      lineEnd: { type: 'integer', description: '1-based end line (inclusive).' },
    },
    required: ['filePath', 'lineStart', 'lineEnd'],
  },
};

const END_INTERVIEW_TOOL: RealtimeTool = {
  type: 'function',
  name: 'end_interview',
  description:
    'Call this when you have tested enough of the user\'s understanding and want to wrap up Ask Me Anything with a brief assessment and goodbye.',
  parameters: { type: 'object', properties: {} },
};

export class InterviewOrchestrator {
  private provider: OpenAIRealtimeProvider | null = null;
  private chained: ChainedVoiceProvider | null = null;
  private mic: MicCapture | null = null;
  private paMic: PortAudioMicCapture | null = null;
  private playback: AudioPlayback | null = null;
  private acpClient: AcpClient | null = null;
  private state: InterviewState = 'idle';
  private questionCount = 0;
  private cancelled = false;
  private homeView: HomeViewProvider | null = null;
  private workspaceRoot = '';

  /** Set the homeView reference for webview-driven audio I/O (chained mode). */
  setHomeView(hv: HomeViewProvider): void {
    this.homeView = hv;
  }

  get currentState(): InterviewState {
    return this.state;
  }

  get questionCountValue(): number {
    return this.questionCount;
  }

  async start(opts: InterviewStartOptions): Promise<void> {
    const { config, context, workspaceRoot, onEvent } = opts;
    this.cancelled = false;
    this.questionCount = 0;

    // Decide mode: auto → chained if realtime key missing, else realtime
    const mode = this.resolveMode(config);
    if (mode === 'chained') {
      await this.startChained(opts);
    } else {
      await this.startRealtime(opts);
    }
  }

  private resolveMode(config: FullConfig): 'realtime' | 'chained' {
    if (config.voiceMode === 'chained') return 'chained';
    if (config.voiceMode === 'realtime') return 'realtime';
    // auto: use chained if no realtime API key, else realtime
    if (!config.realtime.apiKey) return 'chained';
    return 'realtime';
  }

  // ─── Realtime mode (WebSocket STT+TTS) ────────────────────────────────

  private async startRealtime(opts: InterviewStartOptions): Promise<void> {
    const { config, context, workspaceRoot, onEvent } = opts;
    const apiKey = config.realtime.apiKey;
    if (!apiKey) {
      onEvent({ kind: 'error', text: 'No API key configured. Set interviewLele.realtime.apiKey or OPENAI_API_KEY, or switch voiceMode to chained.' });
      return;
    }

    this.setState('connecting', onEvent);

    const topicsBrief = context.topics
      .slice(0, 20)
      .map((t, i) => `${i + 1}. ${t.title} — ${t.filePath}:${t.lineStart}-${t.lineEnd}\n   why: ${t.rationale}`)
      .join('\n');

    const filesBrief = context.files
      .slice(0, 30)
      .map((f) => `- ${f.path} — ${f.role}`)
      .join('\n');

    const instructions = `${config.realtime.instructions}

You are testing the user's understanding of THIS codebase in Ask Me Anything:

PROJECT SUMMARY:
${context.summary}

KEY FILES:
${filesBrief}

SUGGESTED KNOWLEDGE-CHECK TOPICS (use open_file before asking about each):
${topicsBrief}

KNOWLEDGE EVALUATOR — behave like a curious, supportive technical peer:
- Speak naturally and concisely, as if on a phone/video call. No bullet points, no lectures, no markdown.
- One question at a time. Listen actively. React like a human: "Good point", "Hmm, not quite", "Can you elaborate?"
- NEVER teach or explain the correct answer. Your job is to assess, not tutor. If they get it wrong, note it and move on.
- Probe deeper when answers are vague: "Why that approach?", "What are the trade-offs?", "What breaks at scale?"
- If they say "I don't know" or give a weak answer, acknowledge briefly ("No worries, let's try another area") and move on. Never explain what they missed.

SCORING — rate every answer internally (Strong/Adequate/Weak). At the end, give a final summary with per-topic scores (1-5) and overall recommendation.

RULES:
- Always call open_file with the exact filePath/lineStart/lineEnd before asking about specific code.
- Ask ONE question at a time. Wait for the answer. Do not stack questions.
- Do NOT explain concepts. Do NOT give the answer. Assess only.
- When you have covered enough, call end_interview.
- Keep spoken turns SHORT — 2-3 sentences max. This is a live voice conversation.`;

    const provider = new OpenAIRealtimeProvider({
      baseUrl: config.realtime.baseUrl,
      model: config.realtime.model,
      apiKey,
      voice: config.realtime.voice,
      instructions,
      inputFormat: config.realtime.inputFormat,
      outputFormat: config.realtime.outputFormat,
      sampleRate: config.realtime.sampleRate,
      turnDetection: config.realtime.turnDetection,
      tools: [OPEN_FILE_TOOL, END_INTERVIEW_TOOL],
    });
    this.provider = provider;

    provider.on('log', (m) => {
      onEvent({ kind: 'log', text: m });
      logger.log(`[realtime] ${m}`);
    });
    provider.on('error', (err) => {
      onEvent({ kind: 'error', text: err.message });
      logger.error(`[realtime] ${err.message}`);
    });

    provider.on('speech_started', () => {
      this.playback?.stop();
      this.setState('listening', onEvent);
    });
    provider.on('speech_stopped', () => {
      this.setState('thinking', onEvent);
    });

    provider.on('audio_delta', (chunk: Buffer) => {
      this.setState('speaking', onEvent);
      this.playback?.feed(chunk);
    });
    provider.on('audio_done', () => {
      this.playback?.flush();
    });

    provider.on('transcript_delta', (t) => {
      onEvent({ kind: 'agent_message', text: t });
    });
    provider.on('transcript_done', (t) => {
      if (t) onEvent({ kind: 'agent_message', text: t });
    });
    provider.on('text_delta', (t) => {
      onEvent({ kind: 'agent_message', text: t });
    });
    provider.on('text_done', (t) => {
      if (t) onEvent({ kind: 'agent_message', text: t });
    });

    provider.on('function_call', async (call) => {
      if (call.name === 'open_file') {
        try {
          const args = JSON.parse(call.arguments || '{}');
          const filePath = String(args.filePath ?? '');
          const lineStart = Number(args.lineStart ?? 1);
          const lineEnd = Number(args.lineEnd ?? lineStart);
          if (!filePath) {
            provider.submitToolResult(call.callId, { ok: false, error: 'filePath required' });
            return;
          }
          const ed = await openAndHighlight({ filePath, lineStart, lineEnd }, workspaceRoot);
          onEvent({
            kind: 'file_opened',
            filePath,
            lineStart,
            lineEnd,
            text: ed ? `Opened ${filePath}:${lineStart}-${lineEnd}` : `Could not open ${filePath}`,
          });
          this.questionCount += 1;
          onEvent({ kind: 'question_count', text: String(this.questionCount) });
          if (config.interview.maxQuestions > 0 && this.questionCount >= config.interview.maxQuestions) {
            provider.submitToolResult(call.callId, {
              ok: !!ed,
              note: 'Maximum question count reached. Please wrap up with end_interview.',
            });
          } else {
            provider.submitToolResult(call.callId, { ok: !!ed });
          }
        } catch (e) {
          provider.submitToolResult(call.callId, { ok: false, error: (e as Error).message });
        }
      } else if (call.name === 'end_interview') {
        provider.submitToolResult(call.callId, { ok: true });
        onEvent({ kind: 'log', text: 'Interview ending per agent request.' });
        this.setState('ended', onEvent);
        this.cancelled = true;
      } else {
        provider.submitToolResult(call.callId, { ok: false, error: `Unknown tool: ${call.name}` });
      }
    });

    try {
      await provider.connect();
    } catch (e) {
      onEvent({ kind: 'error', text: `Failed to connect to Realtime API: ${(e as Error).message}` });
      this.setState('idle', onEvent);
      return;
    }

    this.playback = new AudioPlayback({
      sampleRate: config.realtime.sampleRate,
      channels: 1,
      ffmpegPath: config.audio.ffmpegPath,
    });
    this.playback.start();

    this.mic = new MicCapture({
      ffmpegPath: config.audio.ffmpegPath,
      sampleRate: config.realtime.sampleRate,
      channels: 1,
      inputDevice: config.audio.inputDevice || undefined,
    });
    this.mic.on('error', (err) => {
      onEvent({ kind: 'error', text: `Mic error: ${err.message}` });
      logger.error(`[mic] ${err.message}`);
    });
    this.mic.on('log', (l) => logger.log(`[mic] ${l}`));
    this.mic.on('data', (chunk: Buffer) => {
      if (!this.cancelled) provider.sendAudio(chunk);
    });
    this.mic.start();

    this.setState('listening', onEvent);
    onEvent({ kind: 'log', text: 'Ask Me Anything is live (realtime mode). Speak naturally — say "stop" or use the Stop command to end.' });

    provider.sendText(
      `Begin Ask Me Anything now. Greet the user briefly, then call open_file for the first topic and ask your first knowledge-check question.`
    );

    await this.waitCancelled(opts);
    await this.stop(onEvent);
  }

  // ─── Chained mode (PortAudio mic → STT → chat → TTS → webview playback) ─

  private async startChained(opts: InterviewStartOptions): Promise<void> {
    const { config, context, workspaceRoot, onEvent, agent, agentConfig } = opts;
    this.workspaceRoot = workspaceRoot;

    // Validate STT key (still needed for transcription)
    if (!config.stt.apiKey) {
      onEvent({ kind: 'error', text: 'No STT API key. Set interviewLele.stt.apiKey or OPENROUTER_API_KEY.' });
      return;
    }

    this.setState('connecting', onEvent);

    const chained = new ChainedVoiceProvider(config);
    chained.setContext(context);
    chained.setMaxQuestions(config.interview.maxQuestions);
    this.chained = chained;

    // Chat uses OpenAI-compatible endpoint (OpenRouter /chat/completions)
    // The ACP agent is NOT used for chat — it doesn't follow the <open_file> tag
    // convention needed for file highlighting during the interview.
    if (!config.chat.apiKey) {
      onEvent({ kind: 'error', text: 'No chat API key. Set interviewLele.chat.apiKey or OPENROUTER_API_KEY.' });
      return;
    }

    if (!this.homeView) {
      onEvent({ kind: 'error', text: 'Home view not available for TTS playback.' });
      return;
    }

    // PortAudio mic capture with VAD — always use system default device
    const silenceMs = Math.round(config.audio.silenceSeconds * 1000);

    this.paMic = new PortAudioMicCapture({
      sampleRate: 16000,
      channels: 1,
      deviceId: -1, // -1 = system default
      silenceMs,
      minSpeechMs: 200,
      maxSpeechMs: 60000,
      rmsStart: 0.006,
      rmsStop: 0.004,
      preRollMs: 500,
    });

    this.paMic.on('error', (err) => {
      onEvent({ kind: 'error', text: `Mic error: ${err.message}` });
      logger.error(`[paMic] ${err.message}`);
    });
    this.paMic.on('log', (l) => logger.log(`[paMic] ${l}`));
    this.paMic.on('level', (lvl: { rms: number; peak: number; recording: boolean; wave: number[] }) => {
      this.homeView?.sendAudioLevel(lvl);
    });
    this.paMic.on('speech_start', () => {
      this.setState('listening', onEvent);
    });
    this.paMic.on('speech_end', () => {
      this.setState('thinking', onEvent);
    });
    this.paMic.on('recording', async (wav: Buffer) => {
      if (this.cancelled || !this.chained) return;
      await this.processCandidateWav(wav, onEvent);
    });

    this.setState('listening', onEvent);
    onEvent({ kind: 'log', text: `Ask Me Anything is live (chained: PortAudio mic → Voxtral STT → OpenAI-compatible chat → Kokoro TTS). Speak naturally.` });

    // Start mic
    this.paMic.start();

    // Opening turn
    await this.doOpeningTurn(onEvent);

    await this.waitCancelled(opts);
    await this.stop(onEvent);
  }

  /** Generate and speak the opening turn. */
  private async doOpeningTurn(onEvent: (e: InterviewEvent) => void): Promise<void> {
    if (!this.chained) return;
    this.setState('thinking', onEvent);
    try {
      const opening = await this.chained.opening();
      if (opening.openFile) {
        const ed = await openAndHighlight(opening.openFile, this.workspaceRoot);
        onEvent({
          kind: 'file_opened',
          filePath: opening.openFile.filePath,
          lineStart: opening.openFile.lineStart,
          lineEnd: opening.openFile.lineEnd,
          text: ed ? `Opened ${opening.openFile.filePath}` : `Could not open ${opening.openFile.filePath}`,
        });
        this.questionCount = this.chained.count;
        onEvent({ kind: 'question_count', text: String(this.questionCount) });
      }
      onEvent({ kind: 'agent_message', text: opening.text });
      await this.speakText(opening.text, onEvent);
      if (!this.cancelled) this.setState('listening', onEvent);
    } catch (e) {
      onEvent({ kind: 'error', text: `Opening turn failed: ${(e as Error).message}` });
    }
  }

  /** Process candidate WAV audio: STT → chat → TTS → play. */
  private async processCandidateWav(wav: Buffer, onEvent: (e: InterviewEvent) => void): Promise<void> {
    if (!this.chained) return;
    this.setState('thinking', onEvent);
    try {
      // 1. STT
      const text = await this.chained.transcribe(wav, 'wav');
      onEvent({ kind: 'user_transcript', text });
      logger.log(`[stt] "${text}"`);

      // 2. Chat → next interviewer turn
      const turn = await this.chained.nextTurn(text);
      if (turn.openFile) {
        const ed = await openAndHighlight(turn.openFile, this.workspaceRoot);
        onEvent({
          kind: 'file_opened',
          filePath: turn.openFile.filePath,
          lineStart: turn.openFile.lineStart,
          lineEnd: turn.openFile.lineEnd,
          text: ed ? `Opened ${turn.openFile.filePath}:${turn.openFile.lineStart}-${turn.openFile.lineEnd}` : `Could not open ${turn.openFile.filePath}`,
        });
        this.questionCount = this.chained.count;
        onEvent({ kind: 'question_count', text: String(this.questionCount) });
      }
      onEvent({ kind: 'agent_message', text: turn.text });
      logger.log(`[chat] "${turn.text}"`);

      // 3. TTS → send to webview for playback
      await this.speakText(turn.text, onEvent);

      if (turn.endInterview) {
        onEvent({ kind: 'log', text: 'Interview ending per agent request.' });
        this.cancelled = true;
        this.setState('ended', onEvent);
      } else if (!this.cancelled) {
        this.setState('listening', onEvent);
      }
    } catch (e) {
      onEvent({ kind: 'error', text: `Chained turn failed: ${(e as Error).message}` });
      logger.error(`[chained] ${(e as Error).message}`);
      this.setState('listening', onEvent);
    }
  }

  /** Synthesize text via TTS and play via ffplay. Pauses mic during playback to prevent feedback.
   *  Does NOT transition state after playback — caller decides next state (listening/ended). */
  private async speakText(text: string, onEvent: (e: InterviewEvent) => void): Promise<void> {
    if (!this.chained) return;
    this.setState('speaking', onEvent);
    // Mute mic during TTS playback so the interviewer's own voice doesn't get captured
    this.paMic?.pause();
    try {
      const audio = await this.chained.synthesize(text);
      logger.log(`[tts] Synthesized ${audio.length} bytes for "${text.slice(0, 60)}..."`);
      await this.playMp3Blocking(audio);
    } catch (e) {
      logger.error(`[tts] Synthesis failed: ${(e as Error).message}`);
      onEvent({ kind: 'error', text: `TTS failed: ${(e as Error).message}` });
    } finally {
      // Unmute mic after a short delay so we don't capture the tail of TTS playback
      if (!this.cancelled) setTimeout(() => this.paMic?.resume(), 200);
    }
  }

  /** Play mp3 buffer through ffplay, blocking until playback completes. */
  private async playMp3Blocking(mp3: Buffer): Promise<void> {
    const { spawn } = require('child_process');
    const cfg = await import('../config').then((m) => m.loadConfig());
    const ffplay = cfg.audio.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffplay$1');
    return new Promise<void>((resolve) => {
      const p = spawn(ffplay, ['-nodisp', '-autoexit', '-nostats', '-loglevel', 'quiet', '-i', 'pipe:0'], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      p.on('error', (err: Error) => {
        logger.error(`[tts] ffplay error: ${err.message}`);
        resolve();
      });
      p.on('exit', () => resolve());
      try {
        p.stdin?.write(mp3);
        p.stdin?.end();
      } catch { resolve(); }
    });
  }

  private async waitCancelled(opts: InterviewStartOptions): Promise<void> {
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.cancelled || opts.token?.isCancellationRequested) {
          resolve();
        } else {
          setTimeout(check, 250);
        }
      };
      check();
    });
  }

  private setState(s: InterviewState, onEvent: (e: InterviewEvent) => void) {
    const prev = this.state;
    this.state = s;
    onEvent({ kind: 'state', state: s });
    // Play beep when entering listening state (interviewer finished speaking)
    if (s === 'listening' && prev !== 'listening' && !this.cancelled) {
      const cfg = vscode.workspace.getConfiguration('interviewLele');
      const beepEnabled = cfg.get('audio.beepEnabled', true);
      if (beepEnabled) {
        const ffmpegPath = cfg.get('audio.ffmpegPath', 'ffmpeg');
        playListeningBeep(ffmpegPath);
        logger.log('[beep] Playing listening beep');
      }
    }
  }

  async stop(onEvent?: (e: InterviewEvent) => void): Promise<void> {
    this.cancelled = true;
    try { await this.mic?.stop(); } catch { /* ignore */ }
    try { await this.paMic?.stop(); } catch { /* ignore */ }
    try { await this.playback?.stop(); } catch { /* ignore */ }
    try { await this.provider?.disconnect(); } catch { /* ignore */ }
    try { await this.chained?.disposeAcp(); } catch { /* ignore */ }
    if (this.homeView) {
      this.homeView.stopListening();
      this.homeView.onAudio = null;
      this.homeView.onRequestOpening = null;
    }
    this.mic = null;
    this.paMic = null;
    this.playback = null;
    this.provider = null;
    this.chained = null;
    this.acpClient = null;
    clearHighlights();
    if (onEvent) this.setState('ended', onEvent);
  }
}
