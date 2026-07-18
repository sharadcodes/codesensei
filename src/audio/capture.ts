import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

export interface MicCaptureOptions {
  ffmpegPath: string;
  sampleRate: number;
  channels?: number;
  inputDevice?: string;
  /** Optional input format override; defaults to platform sensible defaults. */
  inputFormat?: string;
}

/**
 * Captures microphone audio as raw PCM16 little-endian using ffmpeg.
 * Emits 'data' events with Buffer chunks (PCM16, mono, sampleRate Hz).
 *
 * VSCode webviews cannot access the microphone (permissions policy), so we
 * capture in the extension host via ffmpeg, mirroring how the grok-build-vscode
 * extension and the CLIs do it.
 */
export class MicCapture extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stopped = false;

  constructor(private opts: MicCaptureOptions) {
    super();
  }

  start(): void {
    const args = this.buildArgs();
    this.proc = spawn(this.opts.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.length) this.emit('data', chunk);
    });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      // ffmpeg writes progress / errors to stderr; surface only errors
      if (/error|invalid|cannot/i.test(s)) this.emit('log', s.trim());
    });
    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code, signal) => {
      if (!this.stopped) this.emit('error', new Error(`ffmpeg exited code=${code} signal=${signal}`));
      this.emit('exit', { code, signal });
    });
  }

  private buildArgs(): string[] {
    const sr = this.opts.sampleRate;
    const channels = this.opts.channels ?? 1;
    const platform = process.platform;
    const inputArgs: string[] = [];

    if (this.opts.inputFormat) {
      inputArgs.push('-f', this.opts.inputFormat);
    } else if (platform === 'win32') {
      inputArgs.push('-f', 'dshow');
    } else if (platform === 'darwin') {
      inputArgs.push('-f', 'avfoundation');
    } else {
      inputArgs.push('-f', 'pulse');
    }

    if (this.opts.inputDevice) {
      inputArgs.push('-i', this.opts.inputDevice);
    } else if (platform === 'win32') {
      inputArgs.push('-i', 'audio=default');
    } else if (platform === 'darwin') {
      // ":0" = default audio input device
      inputArgs.push('-i', ':0');
    } else {
      inputArgs.push('-i', 'default');
    }

    return [
      ...inputArgs,
      '-ac',
      String(channels),
      '-ar',
      String(sr),
      '-sample_fmt',
      's16',
      '-f',
      's16le',
      '-flush_packets',
      '1',
      '-nostdin',
      '-loglevel',
      'error',
      'pipe:1',
    ];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.proc) {
      try {
        this.proc.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        this.proc.kill('SIGINT');
      } catch {
        try {
          this.proc.kill();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
