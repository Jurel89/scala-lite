import * as vscode from 'vscode';
import {
  formatStructuredLogEntry,
  ScalaLiteLogCategory,
  ScalaLiteLogLevel,
  shouldEmitLog
} from './structuredLogCore';

export class StructuredLogger implements vscode.Disposable {
  private readonly outputChannel: vscode.OutputChannel;
  private level: ScalaLiteLogLevel;
  private readonly lines: string[] = [];

  public constructor(level: ScalaLiteLogLevel) {
    this.outputChannel = vscode.window.createOutputChannel('Scala Lite');
    this.level = level;
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }

  public setLevel(level: ScalaLiteLogLevel): void {
    this.level = level;
  }

  public getLastLines(limit: number): string[] {
    if (limit <= 0) {
      return [];
    }

    return this.lines.slice(-limit);
  }

  public log(
    level: ScalaLiteLogLevel,
    category: ScalaLiteLogCategory,
    message: string,
    durationMs?: number
  ): void {
    if (!shouldEmitLog(level, this.level)) {
      return;
    }

    const line = formatStructuredLogEntry({
      timestamp: new Date(),
      level,
      category,
      message,
      durationMs
    });

    this.lines.push(line);
    if (this.lines.length > 3000) {
      this.lines.splice(0, this.lines.length - 3000);
    }

    this.outputChannel.appendLine(line);
  }

  public debug(category: ScalaLiteLogCategory, message: string, durationMs?: number): void {
    this.log('DEBUG', category, message, durationMs);
  }

  public info(category: ScalaLiteLogCategory, message: string, durationMs?: number): void {
    this.log('INFO', category, message, durationMs);
  }

  public warn(category: ScalaLiteLogCategory, message: string, durationMs?: number): void {
    this.log('WARN', category, message, durationMs);
  }

  public error(category: ScalaLiteLogCategory, message: string, durationMs?: number): void {
    this.log('ERROR', category, message, durationMs);
  }
}