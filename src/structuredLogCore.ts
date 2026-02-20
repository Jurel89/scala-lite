export type ScalaLiteLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type ScalaLiteLogCategory =
  | 'ACTIVATE'
  | 'INDEX'
  | 'SEARCH'
  | 'RUN'
  | 'TEST'
  | 'FORMAT'
  | 'LINT'
  | 'DIAG'
  | 'BUDGET'
  | 'DOCTOR'
  | 'CONFIG';

export interface StructuredLogEntryInput {
  readonly timestamp: Date;
  readonly level: ScalaLiteLogLevel;
  readonly category: ScalaLiteLogCategory;
  readonly message: string;
  readonly durationMs?: number;
}

const LEVEL_PRIORITY: Record<ScalaLiteLogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatStructuredLogEntry(input: StructuredLogEntryInput): string {
  const hours = pad(input.timestamp.getHours());
  const minutes = pad(input.timestamp.getMinutes());
  const seconds = pad(input.timestamp.getSeconds());
  const prefix = `[${hours}:${minutes}:${seconds}] [${input.level}] [${input.category}] ${input.message}`;

  if (typeof input.durationMs === 'number') {
    return `${prefix} (${Math.max(0, Math.round(input.durationMs))}ms)`;
  }

  return prefix;
}

export function shouldEmitLog(level: ScalaLiteLogLevel, threshold: ScalaLiteLogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[threshold];
}