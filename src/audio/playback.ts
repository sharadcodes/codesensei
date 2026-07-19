import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface PlaybackOptions {
  sampleRate: number;
  channels?: number;
  /** Path to ffplay binary. Defaults to 'ffplay'. */
  ffplayPath?: string;
  /** Path to ffmpeg binary (used for wav fallback). Defaults to 'ffmpeg'. */
  ffmpegPath?: string;
}

/**
 * Streams PCM16 audio to the system speakers via ffplay, with a graceful
 * fallback that accumulates audio and plays a WAV file via the OS default
 * player if ffplay is unavailable.
 */
export class AudioPlayback extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer: Buffer[] = [];
  private mode: 'stream' | 'wav' = 'stream';
  private started = false;
  private closed = false;

  constructor(private opts: PlaybackOptions) {
    super();
  }

  /** Start the playback stream. Safe to call once before feeding chunks. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const ffplay = this.opts.ffplayPath ?? 'ffplay';
    try {
      this.proc = spawn(
        ffplay,
        [
          '-nodisp',
          '-autoexit',
          '-nostats',
          '-loglevel',
          'quiet',
          '-f',
          's16le',
          '-ar',
          String(this.opts.sampleRate),
          '-ac',
          String(this.opts.channels ?? 1),
          '-i',
          'pipe:0',
        ],
        { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
      );
      this.proc.on('error', () => {
        this.mode = 'wav';
        this.proc = null;
      });
      this.proc.on('exit', () => {
        if (!this.closed) {
          // ffplay exited mid-stream; switch mode for subsequent audio
          this.mode = 'wav';
        }
      });
      this.proc.stderr?.on('data', () => {
        /* swallow */
      });
    } catch {
      this.mode = 'wav';
      this.proc = null;
    }
  }

  /** Feed a chunk of PCM16 audio. */
  feed(chunk: Buffer): void {
    if (!this.started) this.start();
    if (this.mode === 'stream' && this.proc?.stdin && !this.proc.killed) {
      try {
        this.proc.stdin.write(chunk);
        return;
      } catch {
        this.mode = 'wav';
      }
    }
    this.buffer.push(chunk);
  }

  /** Called when a complete audio response has been received. */
  async flush(): Promise<void> {
    if (this.mode === 'stream' && this.proc?.stdin) {
      try {
        await new Promise<void>((resolve) => {
          this.proc!.stdin!.end(() => resolve());
        });
      } catch {
        /* ignore */
      }
      this.proc = null;
      return;
    }
    await this.playWav();
  }

  private async playWav(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pcm = Buffer.concat(this.buffer);
    this.buffer = [];
    const wav = pcmToWav(pcm, this.opts.sampleRate, this.opts.channels ?? 1);
    const tmp = path.join(os.tmpdir(), `codebase-tutor-${Date.now()}.wav`);
    await fs.writeFile(tmp, wav);
    try {
      await playFile(tmp);
    } finally {
      // Clean up after a delay to let the player read it
      setTimeout(() => fs.unlink(tmp).catch(() => undefined), 30000);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.proc) {
      try {
        this.proc.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function playFile(file: string): Promise<void> {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'win32') {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`];
  } else if (platform === 'darwin') {
    cmd = 'afplay';
    args = [file];
  } else {
    cmd = 'aplay';
    args = [file];
  }
  await new Promise<void>((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => resolve());
    p.on('exit', () => resolve());
  });
}
