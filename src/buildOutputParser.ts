export type ParsedSeverity = 'error' | 'warning';

export interface ParsedBuildOutputLine {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly severity: ParsedSeverity;
}

function parseSbt(line: string): ParsedBuildOutputLine | undefined {
  const match = line.match(/^\[(error|warn(?:ing)?)\]\s+(.+?):(\d+):(\d+):\s*(.+)$/i);
  if (!match) {
    return undefined;
  }

  const severity: ParsedSeverity = match[1].toLowerCase().startsWith('warn') ? 'warning' : 'error';

  return {
    filePath: match[2],
    line: Number(match[3]),
    column: Number(match[4]),
    message: match[5],
    severity
  };
}

function parseScalaCli(line: string): ParsedBuildOutputLine | undefined {
  const match = line.match(/^--\s+(Error|Warning):\s+(.+?):(\d+):(\d+)\s+-+/i);
  if (!match) {
    return undefined;
  }

  return {
    filePath: match[2],
    line: Number(match[3]),
    column: Number(match[4]),
    message: `${match[1]} in Scala CLI output`,
    severity: match[1].toLowerCase() === 'warning' ? 'warning' : 'error'
  };
}

function parseMillOrScalac(line: string): ParsedBuildOutputLine | undefined {
  const match = line.match(/^(.+?):(\d+):(?:(\d+):)?\s*(error|warning):\s*(.+)$/i);
  if (!match) {
    return undefined;
  }

  return {
    filePath: match[1],
    line: Number(match[2]),
    column: Number(match[3] ?? '1'),
    message: match[5],
    severity: match[4].toLowerCase() === 'warning' ? 'warning' : 'error'
  };
}

export function parseBuildOutputLine(line: string): ParsedBuildOutputLine | undefined {
  return parseSbt(line) ?? parseScalaCli(line) ?? parseMillOrScalac(line);
}