import * as vscode from 'vscode';
import { FullConfig } from '../config';
import { CodebaseContext } from '../types';
import { PortAudioMicCapture } from '../audio/portAudioMic';
import { playListeningBeep } from '../audio/beep';
import { AcpClient } from '../acp/client';
import { DiscoveredAgent } from '../acp/registry';
import { AgentConfig } from '../acp/agentConfig';
import { ChainedVoiceProvider, ChainedTurn } from '../realtime/chained';
import { openAndHighlight, clearHighlights } from '../ui/highlight';
import { logger } from '../logger';
import { HomeViewProvider } from '../ui/homeView';
import { StoredSession, saveSession } from './sessionStore';

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
  /** Prior conversation turns to seed when resuming a previous interview. */
  priorTranscript?: ChainedTurn[];
  /** VS Code context for persisting session state (cache + transcript). */
  extContext?: vscode.ExtensionContext;
}



export class InterviewOrchestrator {
  private chained: ChainedVoiceProvider | null = null;
  private paMic: PortAudioMicCapture | null = null;
  private acpClient: AcpClient | null = null;
  private state: InterviewState = 'idle';
  private questionCount = 0;
  private cancelled = false;
  private homeView: HomeViewProvider | null = null;
  private workspaceRoot = '';
  private extContext: vscode.ExtensionContext | null = null;
  private sessionBase: StoredSession | null = null;

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
    const { context, workspaceRoot } = opts;
    this.cancelled = false;
    this.questionCount = 0;
    this.workspaceRoot = workspaceRoot;
    this.extContext = opts.extContext ?? null;

    // Initialize session base for continuous persistence
    if (this.extContext) {
      this.sessionBase = {
        workspaceRoot,
        analyzedAt: Date.now(),
        context,
        agentId: opts.agent?.id ?? '',
        supportsAcpResume: false,
        transcript: opts.priorTranscript ? [...opts.priorTranscript] : [],
      };
    }

    await this.startChained(opts);
  }

  /** Persist the current session state (context + transcript) to global storage. */
  private persistSession(): void {
    if (!this.extContext || !this.sessionBase) return;
    this.sessionBase.transcript = this.chained?.transcript ?? this.sessionBase.transcript;
    void saveSession(this.extContext, this.sessionBase);
  }



  private async startChained(opts: InterviewStartOptions): Promise<void> {
    const { config, context, workspaceRoot, onEvent, agent, agentConfig } = opts;
    this.workspaceRoot = workspaceRoot;

    // Validate STT key (still needed for transcription)
    if (!config.stt.apiKey) {
      onEvent({ kind: 'error', text: 'No STT API key. Set codeSensei.stt.apiKey or OPENROUTER_API_KEY.' });
      return;
    }

    this.setState('connecting', onEvent);

    const chained = new ChainedVoiceProvider(config);
    chained.setContext(context);
    chained.setMaxQuestions(config.interview.maxQuestions);
    this.chained = chained;

    // Seed prior conversation history when resuming
    if (opts.priorTranscript && opts.priorTranscript.length > 0) {
      chained.seedTranscript(opts.priorTranscript);
    }

    // Chat uses OpenAI-compatible endpoint (OpenRouter /chat/completions)
    // The ACP agent is NOT used for chat — it doesn't follow the <open_file> tag
    // convention needed for file highlighting during the interview.
    if (!config.chat.apiKey) {
      onEvent({ kind: 'error', text: 'No chat API key. Set codeSensei.chat.apiKey or OPENROUTER_API_KEY.' });
      return;
    }

    if (!this.homeView) {
      onEvent({ kind: 'error', text: 'Home view not available for TTS playback.' });
      return;
    }

    // PortAudio mic capture with VAD — use the configured device or system default.
    const silenceMs = Math.round(config.audio.silenceSeconds * 1000);

    this.paMic = new PortAudioMicCapture({
      sampleRate: 16000,
      channels: 1,
      deviceId: config.audio.inputDeviceId,
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
      // Half-duplex turn-taking: stop listening as soon as the user's
      // utterance ends, for the entire duration of this turn (STT → chat →
      // TTS). Without this, the VAD stays armed while we're generating the
      // response, so a second utterance mid-turn fires a second, overlapping
      // `processCandidateWav` call — racing transcript order, TTS playback,
      // and mic mute state. Resumed by `speakText`'s `finally` (normal path)
      // or the safety-net `resume()` calls below (error / discarded paths).
      this.paMic?.pause();
    });
    this.paMic.on('speech_discarded', () => {
      // finishRecording() decided the utterance was too short to process —
      // no 'recording' event (and therefore no speakText) will follow, so we
      // must resume the mic here or it stays muted forever.
      if (!this.cancelled) {
        this.paMic?.resume();
        this.setState('listening', onEvent);
      }
    });
    this.paMic.on('recording', async (wav: Buffer) => {
      if (this.cancelled || !this.chained) return;
      await this.processCandidateWav(wav, onEvent);
    });

    this.setState('listening', onEvent);
    onEvent({ kind: 'log', text: `Knowledge Check is live (chained: PortAudio mic → Voxtral STT → OpenAI-compatible chat → Kokoro TTS). Speak naturally.` });

    // Start mic, muted until the opening turn has been spoken so we don't
    // capture (and race against) speech before the greeting is even asked.
    this.paMic.start();
    this.paMic.pause();

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
      // If we're already cancelled, this is almost certainly the abort()
      // fired by stop() unblocking an in-flight fetch — not a real failure.
      if (this.cancelled) return;
      onEvent({ kind: 'error', text: `Opening turn failed: ${(e as Error).message}` });
      // speakText (which would normally resume the mic) may never have run —
      // make sure we don't leave the mic muted forever.
      this.paMic?.resume();
      this.setState('listening', onEvent);
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

      // Persist transcript after each turn
      this.persistSession();

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
      // If we're already cancelled, this is almost certainly the abort()
      // fired by stop() unblocking an in-flight fetch — not a real failure.
      // Don't surface an error and don't stomp the 'ended' state stop() set.
      if (this.cancelled) return;
      onEvent({ kind: 'error', text: `Chained turn failed: ${(e as Error).message}` });
      logger.error(`[chained] ${(e as Error).message}`);
      // speakText (which would normally resume the mic) may not have been
      // reached (e.g. STT/chat failed first) — don't leave the mic muted.
      this.paMic?.resume();
      this.setState('listening', onEvent);
    }
  }

  /** Synthesize text via TTS and play via webview. Pauses mic during playback to prevent feedback.
   *  Does NOT transition state after playback — caller decides next state (listening/ended). */
  private async speakText(text: string, onEvent: (e: InterviewEvent) => void): Promise<void> {
    if (!this.chained) return;
    this.setState('speaking', onEvent);
    // Mute mic during TTS playback so the interviewer's own voice doesn't get captured
    this.paMic?.pause();
    try {
      const audio = await this.chained.synthesize(text);
      if (this.cancelled) return; // stop() was called while synthesizing — don't play it
      logger.log(`[tts] Synthesized ${audio.length} bytes for "${text.slice(0, 60)}..."`);
      await this.playMp3Blocking(audio);
    } catch (e) {
      // If we're already cancelled, this is almost certainly the abort()
      // fired by stop() — not a real failure, don't surface it.
      if (this.cancelled) return;
      logger.error(`[tts] Synthesis failed: ${(e as Error).message}`);
      onEvent({ kind: 'error', text: `TTS failed: ${(e as Error).message}` });
    } finally {
      // Unmute mic after a short delay so we don't capture the tail of TTS playback
      if (!this.cancelled) setTimeout(() => this.paMic?.resume(), 200);
    }
  }

  /** Play mp3 buffer through the webview audio element, blocking until playback completes. */
  private async playMp3Blocking(mp3: Buffer): Promise<void> {
    if (!this.homeView) return;
    await this.homeView.playAudioBlob(mp3.toString('base64'), 'audio/mp3');
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
      const cfg = vscode.workspace.getConfiguration('codeSensei');
      const beepEnabled = cfg.get('audio.beepEnabled', true);
      if (beepEnabled && this.homeView) {
        playListeningBeep(this.homeView);
        logger.log('[beep] Playing listening beep');
      }
    }
  }

  /**
   * Stop immediately: flip cancelled, emit 'ended' state, persist session,
   * then tear down ACP / TTS / STT / mic / playback in the background.
   * Reports per-step progress via onEvent so the UI can show status dots.
   * Idempotent — safe to call multiple times.
   */
  async stop(onEvent?: (e: InterviewEvent) => void): Promise<void> {
    if (this.cancelled && this.state === 'ended') return; // already stopped
    this.cancelled = true;
    // Silence any TTS/beep audio currently playing and cancel any in-flight
    // STT/TTS/chat request immediately — otherwise the assistant keeps
    // talking (and speakText's await keeps blocking) until whatever was
    // already in flight finishes on its own.
    try { this.homeView?.stopAudio(); } catch { /* ignore */ }
    try { this.chained?.abort(); } catch { /* ignore */ }
    // Emit 'ended' immediately so the UI responds instantly
    if (onEvent) this.setState('ended', onEvent);
    // Persist transcript synchronously (fast, non-blocking)
    try { this.persistSession(); } catch { /* ignore */ }
    // Tear down everything in the background — does not block the caller
    void this.tearDown(onEvent);
  }

  /**
   * Background teardown: stops each live component (ACP agent, TTS, STT,
   * mic, playback, realtime WebSocket) one by one, emitting a log event
   * after each so the webview can animate status dots.
   */
  private async tearDown(onEvent?: (e: InterviewEvent) => void): Promise<void> {
    const steps: Array<{ label: string; fn: () => Promise<void> | void }> = [
      { label: 'portaudio', fn: async () => { try { await this.paMic?.stop(); } catch { /* ignore */ } } },
      { label: 'acp', fn: async () => { try { await this.chained?.disposeAcp(); } catch { /* ignore */ } } },
    ];
    for (const step of steps) {
      try { await step.fn(); } catch { /* ignore */ }
      onEvent?.({ kind: 'log', text: `stopped ${step.label}` });
    }
    if (this.homeView) {
      this.homeView.stopListening();
      this.homeView.onAudio = null;
      this.homeView.onRequestOpening = null;
    }
    this.paMic = null;
    this.chained = null;
    this.acpClient = null;
    clearHighlights();
  }
}
