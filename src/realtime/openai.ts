import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { RealtimeProvider, RealtimeSessionConfig } from './provider';

/**
 * OpenAI-compatible Realtime API client.
 *
 * Connects to `${baseUrl}?model=${model}` with `Authorization: Bearer <apiKey>`,
 * configures the session via `session.update`, then exchanges audio + text
 * events following the OpenAI Realtime GA event names:
 *   - input_audio_buffer.append / commit / clear
 *   - response.output_audio.delta / .done
 *   - response.output_audio_transcript.delta / .done
 *   - response.output_text.delta / .done
 *   - response.function_call_arguments.delta / .done
 *   - input_audio_buffer.speech_started / .speech_stopped
 *   - response.done
 *
 * This works against OpenAI and any compatible gateway (Speaches, SCX, etc.)
 * that implements the same event names.
 */
export class OpenAIRealtimeProvider extends EventEmitter implements RealtimeProvider {
  private ws: WebSocket | null = null;
  private ready = false;
  private functionCallBuffers = new Map<string, string>();

  constructor(private cfg: RealtimeSessionConfig) {
    super();
  }

  async connect(): Promise<void> {
    const url = `${this.cfg.baseUrl}?model=${encodeURIComponent(this.cfg.model)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
    // OpenAI requires this beta header for realtime
    headers['OpenAI-Beta'] = 'realtime=v1';

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, { headers });
      this.ws.on('open', () => {
        this.configureSession();
      });
      this.ws.on('message', (data: WebSocket.RawData) => this.onMessage(data));
      this.ws.on('error', (err: Error) => {
        this.emit('error', err);
        if (!this.ready) reject(err);
      });
      this.ws.on('close', (code: number, reason: Buffer) => {
        this.emit('log', `realtime socket closed code=${code} reason=${reason?.toString()}`);
        this.ready = false;
      });
      // Resolve once ready
      const onReady = () => {
        this.off('ready', onReady);
        resolve();
      };
      this.on('ready', onReady);
    });
  }

  private configureSession() {
    const session: any = {
      type: 'realtime',
      voice: this.cfg.voice,
      instructions: this.cfg.instructions,
      input_audio_format: this.cfg.inputFormat,
      output_audio_format: this.cfg.outputFormat,
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection:
        this.cfg.turnDetection === 'server_vad'
          ? { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
          : null,
      tools: (this.cfg.tools ?? []).map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    };
    this.send({ type: 'session.update', session });
  }

  async updateSession(patch: Record<string, unknown>): Promise<void> {
    this.send({ type: 'session.update', session: patch });
  }

  private onMessage(data: WebSocket.RawData) {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const t = msg.type as string;
    switch (t) {
      case 'session.created':
      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          this.emit('ready');
        }
        break;
      case 'input_audio_buffer.speech_started':
        this.emit('speech_started');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('speech_stopped');
        break;
      case 'response.output_audio.delta': {
        const delta = msg.delta as string;
        if (delta) this.emit('audio_delta', Buffer.from(delta, 'base64'));
        break;
      }
      case 'response.output_audio.done':
        this.emit('audio_done');
        break;
      case 'response.output_audio_transcript.delta':
        this.emit('transcript_delta', (msg.delta as string) ?? '');
        break;
      case 'response.output_audio_transcript.done':
        this.emit('transcript_done', (msg.transcript as string) ?? '');
        break;
      case 'response.output_text.delta':
        this.emit('text_delta', (msg.delta as string) ?? '');
        break;
      case 'response.output_text.done':
        this.emit('text_done', (msg.text as string) ?? '');
        break;
      case 'response.function_call_arguments.delta': {
        const callId = msg.call_id as string;
        const prev = this.functionCallBuffers.get(callId) ?? '';
        this.functionCallBuffers.set(callId, prev + ((msg.delta as string) ?? ''));
        break;
      }
      case 'response.function_call_arguments.done': {
        const callId = msg.call_id as string;
        const args = this.functionCallBuffers.get(callId) ?? (msg.arguments as string) ?? '';
        this.functionCallBuffers.delete(callId);
        this.emit('function_call', {
          callId,
          name: msg.name as string,
          arguments: args,
        });
        break;
      }
      case 'response.done':
        this.emit('response_done');
        break;
      case 'error':
        this.emit('error', new Error(msg.error?.message ?? 'Realtime API error'));
        break;
      default:
        // Ignore other events
        break;
    }
  }

  private send(msg: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emit('error', new Error('Realtime socket not open'));
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  sendAudio(chunk: Buffer): void {
    this.send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
  }

  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  sendText(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this.requestResponse();
  }

  submitToolResult(callId: string, result: unknown): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: typeof result === 'string' ? result : JSON.stringify(result),
      },
    });
    this.requestResponse();
  }

  requestResponse(): void {
    this.send({ type: 'response.create' });
  }

  interrupt(): void {
    this.send({ type: 'response.cancel' });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.ready = false;
  }
}
