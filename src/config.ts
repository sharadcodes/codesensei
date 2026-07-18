import * as vscode from 'vscode';

export type VoiceMode = 'auto' | 'realtime' | 'chained';

export interface RealtimeConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  voice: string;
  instructions: string;
  inputFormat: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | 'opus';
  outputFormat: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | 'opus';
  sampleRate: number;
  turnDetection: 'server_vad' | 'none';
}

export interface SttConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  path: string;
  language: string;
}

export interface TtsConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  voice: string;
  path: string;
}

export interface ChatConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  path: string;
}

export interface AudioConfig {
  ffmpegPath: string;
  inputDevice: string;
  inputDeviceId: number;
  silenceSeconds: number;
  beepEnabled: boolean;
}

export interface AcpConfig {
  selectedAgentId: string;
  contextPrompt: string;
  customAgents: CustomAgentEntry[];
}

export interface CustomAgentEntry {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export interface InterviewConfig {
  maxQuestions: number;
  difficulty: 'adaptive' | 'junior' | 'mid' | 'senior' | 'staff';
}

export interface FullConfig {
  voiceMode: VoiceMode;
  realtime: RealtimeConfig;
  stt: SttConfig;
  tts: TtsConfig;
  chat: ChatConfig;
  audio: AudioConfig;
  acp: AcpConfig;
  interview: InterviewConfig;
}

function resolveApiKey(settingKey: string, ...envFallbacks: string[]): string {
  const cfg = vscode.workspace.getConfiguration('interviewLele');
  const fromSetting = cfg.get<string>(settingKey);
  if (fromSetting) return fromSetting;
  for (const env of envFallbacks) {
    if (process.env[env]) return process.env[env]!;
  }
  return '';
}

export function loadConfig(): FullConfig {
  const cfg = vscode.workspace.getConfiguration('interviewLele');
  return {
    voiceMode: cfg.get<VoiceMode>('voiceMode', 'auto'),
    realtime: {
      baseUrl: cfg.get('realtime.baseUrl', 'wss://api.openai.com/v1/realtime'),
      model: cfg.get('realtime.model', 'gpt-4o-realtime-preview'),
      apiKey: resolveApiKey('realtime.apiKey', 'OPENAI_API_KEY', 'CODEX_API_KEY'),
      voice: cfg.get('realtime.voice', 'alloy'),
      instructions: cfg.get('realtime.instructions', ''),
      inputFormat: cfg.get('realtime.inputFormat', 'pcm16'),
      outputFormat: cfg.get('realtime.outputFormat', 'pcm16'),
      sampleRate: cfg.get('realtime.sampleRate', 24000),
      turnDetection: cfg.get('realtime.turnDetection', 'server_vad'),
    },
    // STT defaults to OpenRouter with Voxtral Mini Transcribe
    stt: {
      baseUrl: cfg.get('stt.baseUrl', 'https://openrouter.ai/api/v1'),
      model: cfg.get('stt.model', 'mistralai/voxtral-mini-transcribe'),
      apiKey: resolveApiKey('stt.apiKey', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'),
      path: cfg.get('stt.path', '/audio/transcriptions'),
      language: cfg.get('stt.language', 'en'),
    },
    // TTS defaults to local Kokoro FastAPI (docker, port 8881)
    tts: {
      baseUrl: cfg.get('tts.baseUrl', 'http://localhost:8881/v1'),
      model: cfg.get('tts.model', 'tts-1'),
      apiKey: cfg.get('tts.apiKey', 'not-needed'),
      voice: cfg.get('tts.voice', 'af_heart'),
      path: cfg.get('tts.path', '/audio/speech'),
    },
    // Chat defaults to OpenRouter
    chat: {
      baseUrl: cfg.get('chat.baseUrl', 'https://openrouter.ai/api/v1'),
      model: cfg.get('chat.model', 'openai/gpt-5.6'),
      apiKey: resolveApiKey('chat.apiKey', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'),
      path: cfg.get('chat.path', '/chat/completions'),
    },
    audio: {
      ffmpegPath: cfg.get('audio.ffmpegPath', 'ffmpeg'),
      inputDevice: cfg.get('audio.inputDevice', ''),
      inputDeviceId: cfg.get('audio.inputDeviceId', -1),
      silenceSeconds: cfg.get('audio.silenceSeconds', 2.0),
      beepEnabled: cfg.get('audio.beepEnabled', true),
    },
    acp: {
      selectedAgentId: cfg.get('acp.selectedAgentId', ''),
      contextPrompt: cfg.get('acp.contextPrompt', ''),
      customAgents: cfg.get('acp.customAgents', []),
    },
    interview: {
      maxQuestions: cfg.get('interview.maxQuestions', 0),
      difficulty: cfg.get('interview.difficulty', 'adaptive'),
    },
  };
}

export function resolveApiKeyFromConfig(cfg: RealtimeConfig): string {
  return cfg.apiKey || process.env.OPENAI_API_KEY || '';
}
