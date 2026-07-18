import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { logger } from '../logger';

/**
 * Load the naudiodon2 native addon and wrap it with a minimal AudioIO.
 * In dev: require('naudiodon2') resolves from node_modules (has JS wrapper).
 * In packaged VSIX: load the raw .node addon from dist/native/ and wrap it ourselves.
 */
function loadPortAudio(): any {
  // Try the full naudiodon2 package first (dev mode)
  try {
    const pa = require('naudiodon2');
    if (pa.AudioIO && typeof pa.AudioIO === 'function') return pa;
  } catch { /* fall through to manual loading */ }

  // Packaged mode: load raw addon from dist/native/
  const path = require('path');
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', 'native', 'naudiodon.node'),
    path.join(__dirname, 'native', 'naudiodon.node'),
    path.join(__dirname, '..', '..', 'dist', 'native', 'naudiodon.node'),
  ];
  let addonPath: string | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { addonPath = p; break; }
  }
  if (!addonPath) {
    throw new Error('naudiodon2 not found. Install it with: npm install naudiodon2 && npx node-gyp rebuild --directory=node_modules/naudiodon2');
  }
  logger.log(`Loading naudiodon native addon from ${addonPath}`);
  const binding = require(addonPath);

  // Minimal AudioIO wrapper matching naudiodon2's API
  function AudioIO(options: any): Readable {
    const adon = binding.create(options);
    const readable = 'inOptions' in options;
    const writable = 'outOptions' in options;

    let stream: Readable;
    if (readable && writable) {
      const { Duplex } = require('stream');
      stream = new Duplex({
        allowHalfOpen: false,
        readableHighWaterMark: options.inOptions?.highwaterMark || 16384,
        writableHighWaterMark: options.outOptions?.highwaterMark || 16384,
        read: async (size: number) => {
          const result = await adon.read(size);
          if (result.err) stream.destroy(result.err);
          else if (result.finished) stream.push(null);
          else stream.push(result.buf);
        },
        write: async (chunk: Buffer, _enc: string, cb: (err?: Error) => void) => {
          const err = await adon.write(chunk);
          cb(err);
        },
      });
    } else if (readable) {
      stream = new Readable({
        highWaterMark: options.inOptions?.highwaterMark || 16384,
        objectMode: false,
        read: async (size: number) => {
          const result = await adon.read(size);
          if (result.err) stream.destroy(result.err);
          else if (result.finished) stream.push(null);
          else stream.push(result.buf);
        },
      });
    } else {
      const { Writable } = require('stream');
      stream = new Writable({
        highWaterMark: options.outOptions?.highwaterMark || 16384,
        decodeStrings: false,
        objectMode: false,
        write: async (chunk: Buffer, _enc: string, cb: (err?: Error) => void) => {
          const err = await adon.write(chunk);
          cb(err);
        },
      }) as any;
    }

    (stream as any).start = () => adon.start();
    (stream as any).quit = async (cb?: () => void) => {
      await adon.quit('WAIT');
      if (typeof cb === 'function') cb();
    };
    (stream as any).abort = (cb?: () => void) => {
      adon.quit('ABORT', () => { if (typeof cb === 'function') cb(); });
    };
    stream.on('close', () => stream.emit('closed'));
    stream.on('finish', async () => { await (stream as any).quit(); stream.emit('finished'); });
    stream.on('error', (err: Error) => logger.error(`AudioIO: ${err.message}`));
    return stream;
  }

  return {
    AudioIO,
    getDevices: binding.getDevices,
    getHostAPIs: binding.getHostAPIs,
    SampleFormatFloat32: 1,
    SampleFormat8Bit: 8,
    SampleFormat16Bit: 16,
    SampleFormat24Bit: 24,
    SampleFormat32Bit: 32,
  };
}

/**
 * Microphone capture + VAD using PortAudio (via naudiodon2).
 * No ffmpeg dependency. Captures PCM16, detects speech/silence,
 * and emits 'recording' events with WAV-encoded buffers.
 */
export class PortAudioMicCapture extends EventEmitter {
  private audioIn: any = null;
  private recording = false;
  private cancelled = false;
  private muted = false; // when true, incoming audio is dropped (used during TTS playback)
  private chunks: Buffer[] = [];
  private preRollChunks: Buffer[] = [];  // circular buffer for pre-roll
  private readonly preRollCount: number; // number of chunks to keep before speech
  private recordingStarted = 0;
  private quietSince = 0;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly deviceId?: number;
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxSpeechMs: number;
  private readonly rmsStart: number;
  private readonly rmsStop: number;
  private loudFrames = 0;
  private chunkCount = 0;
  private lastLevelEmit = 0;
  private readonly levelEmitMs = 50; // emit level events at ~20fps

  constructor(opts: {
    sampleRate?: number;
    channels?: number;
    deviceId?: number;
    silenceMs?: number;
    minSpeechMs?: number;
    maxSpeechMs?: number;
    rmsStart?: number;
    rmsStop?: number;
    preRollMs?: number;
  }) {
    super();
    this.sampleRate = opts.sampleRate ?? 16000;
    this.channels = opts.channels ?? 1;
    this.deviceId = opts.deviceId;
    this.silenceMs = opts.silenceMs ?? 2000;       // increased: 2s silence before cutting
    this.minSpeechMs = opts.minSpeechMs ?? 200;     // lower: 200ms min speech
    this.maxSpeechMs = opts.maxSpeechMs ?? 60000;   // 60s max
    this.rmsStart = opts.rmsStart ?? 0.006;         // lower threshold for speech start
    this.rmsStop = opts.rmsStop ?? 0.004;           // lower threshold for silence
    // Pre-roll: keep last N chunks (~500ms) so we don't miss the start of speech
    const preRollMs = opts.preRollMs ?? 500;
    // Each chunk at 16kHz/16bit/mono is ~256 samples = 16ms, so ~31 chunks for 500ms
    this.preRollCount = Math.max(10, Math.ceil(preRollMs / 16));
  }

  /** List available input devices, deduplicated by name. */
  static listInputDevices(): Array<{ id: number; name: string; maxInputChannels: number }> {
    try {
      const pa = loadPortAudio();
      const all = pa.getDevices().filter((d: any) => d.maxInputChannels > 0);
      // Deduplicate by name — PortAudio lists the same device under each host API
      const seen = new Set<string>();
      const unique: Array<{ id: number; name: string; maxInputChannels: number }> = [];
      for (const d of all) {
        if (seen.has(d.name)) continue;
        seen.add(d.name);
        unique.push({ id: d.id, name: d.name, maxInputChannels: d.maxInputChannels });
      }
      return unique;
    } catch (e) {
      logger.error(`Failed to list PortAudio devices: ${(e as Error).message}`);
      return [];
    }
  }

  start(): void {
    if (this.audioIn) return;
    try {
      const pa = loadPortAudio();
      this.audioIn = new pa.AudioIO({
        inOptions: {
          channelCount: this.channels,
          sampleFormat: pa.SampleFormat16Bit,
          sampleRate: this.sampleRate,
          deviceId: this.deviceId ?? -1, // -1 = default
        },
      });
    } catch (e) {
      this.emit('error', new Error(`PortAudio init failed: ${(e as Error).message}. Make sure naudiodon2 is installed.`));
      return;
    }

    this.audioIn.on('data', (chunk: Buffer) => {
      if (this.cancelled || this.muted) return;
      this.processChunk(chunk);
    });

    this.audioIn.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.audioIn.start();
    this.emit('log', `PortAudio mic started (${this.sampleRate}Hz, ${this.channels}ch)`);
  }

  /** Mute the mic: drop incoming audio and reset VAD state. Used during TTS playback to prevent feedback. */
  pause(): void {
    this.muted = true;
    // Reset VAD state so we don't emit a stale speech_end when resuming
    this.recording = false;
    this.chunks = [];
    this.loudFrames = 0;
    this.quietSince = Date.now();
  }

  /** Unmute the mic: resume processing incoming audio. */
  resume(): void {
    if (!this.muted) return;
    this.muted = false;
    this.quietSince = Date.now();
  }

  private processChunk(chunk: Buffer): void {
    // Compute RMS for VAD
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
    let sum = 0;
    let maxSample = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] / 32768;
      sum += x * x;
      const abs = Math.abs(samples[i]);
      if (abs > maxSample) maxSample = abs;
    }
    const rms = Math.sqrt(sum / samples.length);

    // Emit level event for waveform visualization (throttled to ~20fps)
    const now = Date.now();
    if (now - this.lastLevelEmit >= this.levelEmitMs) {
      this.lastLevelEmit = now;
      // Downsample to 48 points for the waveform display
      const points = 48;
      const step = Math.max(1, Math.floor(samples.length / points));
      const wave: number[] = [];
      for (let i = 0; i < samples.length; i += step) {
        wave.push(samples[i] / 32768);
      }
      this.emit('level', { rms, peak: maxSample / 32768, recording: this.recording, wave });
    }

    // Debug: log RMS every ~1s
    this.chunkCount = (this.chunkCount || 0) + 1;
    if (this.chunkCount % 62 === 0) {
      this.emit('log', `RMS=${rms.toFixed(4)} peak=${maxSample} rec=${this.recording} loudFrames=${this.loudFrames} preRoll=${this.preRollChunks.length}`);
    }

    const now2 = Date.now();

    if (!this.recording) {
      // Always maintain pre-roll buffer (circular)
      this.preRollChunks.push(chunk);
      if (this.preRollChunks.length > this.preRollCount) this.preRollChunks.shift();

      // Detect speech start — require 5 consecutive loud frames (~80ms) to avoid false triggers
      if (rms > this.rmsStart) {
        this.loudFrames++;
        if (this.loudFrames >= 5) {
          this.recording = true;
          // Prepend pre-roll buffer so we capture the beginning of speech
          this.chunks = [...this.preRollChunks];
          this.preRollChunks = [];
          this.recordingStarted = now2 - (this.preRollCount * 16); // approximate start
          this.quietSince = 0;
          this.loudFrames = 0;
          this.emit('speech_start');
        }
      } else {
        this.loudFrames = 0;
      }
    } else {
      // Recording — accumulate
      this.chunks.push(chunk);

      // Check silence — use higher threshold to detect end of speech
      if (rms < this.rmsStop) {
        if (!this.quietSince) this.quietSince = now2;
        const silenceDur = now2 - this.quietSince;
        const speechDur = now2 - this.recordingStarted;
        if (silenceDur > this.silenceMs && speechDur > this.minSpeechMs) {
          this.emit('log', `Silence detected: ${silenceDur}ms quiet, ${speechDur}ms speech. Finishing.`);
          this.finishRecording();
        }
      } else {
        this.quietSince = 0;
      }

      // Max duration cutoff
      if (now2 - this.recordingStarted > this.maxSpeechMs) {
        this.emit('log', `Max duration reached (${this.maxSpeechMs}ms). Finishing.`);
        this.finishRecording();
      }
    }
  }

  private finishRecording(): void {
    this.recording = false;
    this.emit('speech_end');

    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];

    // Skip if too short (< 0.3s)
    const durationMs = (pcm.length / (this.sampleRate * this.channels * 2)) * 1000;
    if (durationMs < 300) {
      this.emit('log', `Skipping short recording (${durationMs.toFixed(0)}ms)`);
      return;
    }

    const wav = this.pcmToWav(pcm);
    this.emit('recording', wav);
  }

  /** Wrap raw PCM16 in a WAV header. */
  private pcmToWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    const dataSize = pcm.length;
    const totalSize = 44 + dataSize;

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(totalSize - 8, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // chunk size
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(this.sampleRate * this.channels * 2, 28); // byte rate
    header.writeUInt16LE(this.channels * 2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    if (this.recording) {
      this.finishRecording();
    }
    if (this.audioIn) {
      try {
        this.audioIn.quit();
      } catch { /* ignore */ }
      this.audioIn = null;
    }
  }
}
