import * as vscode from 'vscode';

/**
 * Persistent output channel that shows up in VSCode's Output panel dropdown
 * as "Interview Lele". All extension logs (ACP agent stderr, Realtime events,
 * audio capture, orchestrator state) route through here so users can watch
 * the full pipeline live.
 */
class Logger {
  private channel: vscode.OutputChannel | null = null;

  init(): void {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel('Interview Lele');
    }
  }

  show(): void {
    this.init();
    this.channel?.show(true);
  }

  log(msg: string): void {
    this.init();
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.channel?.appendLine(line);
  }

  error(msg: string): void {
    this.init();
    const line = `[${new Date().toISOString()}] [ERROR] ${msg}`;
    this.channel?.appendLine(line);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = null;
  }
}

export const logger = new Logger();
