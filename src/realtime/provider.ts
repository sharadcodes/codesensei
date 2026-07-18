import { EventEmitter } from 'events';

export interface RealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeSessionConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  voice: string;
  instructions: string;
  inputFormat: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | 'opus';
  outputFormat: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | 'opus';
  sampleRate: number;
  turnDetection: 'server_vad' | 'none';
  tools?: RealtimeTool[];
  /** Extra metadata to pass through to the provider. */
  metadata?: Record<string, unknown>;
}

export interface RealtimeEvents {
  audio_delta: (chunk: Buffer) => void;
  audio_done: () => void;
  transcript_delta: (text: string) => void;
  transcript_done: (text: string) => void;
  text_delta: (text: string) => void;
  text_done: (text: string) => void;
  function_call: (call: { callId: string; name: string; arguments: string }) => void;
  response_done: () => void;
  speech_started: () => void;
  speech_stopped: () => void;
  error: (err: Error) => void;
  ready: () => void;
  log: (msg: string) => void;
}

export interface RealtimeProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(chunk: Buffer): void;
  commitAudio(): void;
  sendText(text: string): void;
  /** Submit a tool call result back to the model. */
  submitToolResult(callId: string, result: unknown): void;
  /** Request the model to produce a response now (used with turn_detection=none). */
  requestResponse(): void;
  /** Interrupt an in-progress response. */
  interrupt(): void;
  updateSession(patch: Record<string, unknown>): Promise<void>;
  on<K extends keyof RealtimeEvents>(event: K, listener: RealtimeEvents[K]): this;
  emit(event: 'audio_delta', chunk: Buffer): boolean;
  emit(event: 'audio_done'): boolean;
  emit(event: 'transcript_delta', text: string): boolean;
  emit(event: 'transcript_done', text: string): boolean;
  emit(event: 'text_delta', text: string): boolean;
  emit(event: 'text_done', text: string): boolean;
  emit(event: 'function_call', call: { callId: string; name: string; arguments: string }): boolean;
  emit(event: 'response_done'): boolean;
  emit(event: 'speech_started'): boolean;
  emit(event: 'speech_stopped'): boolean;
  emit(event: 'error', err: Error): boolean;
  emit(event: 'ready'): boolean;
  emit(event: 'log', msg: string): boolean;
}
