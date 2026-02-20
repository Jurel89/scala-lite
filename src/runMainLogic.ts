import { BuildTool } from './buildToolInference';

export type EntryKind = 'scala3-main-def' | 'scala2-app-object' | 'scala-main-method' | 'scala-cli-script';

export interface EntryPoint {
  readonly line: number;
  readonly displayName: string;
  readonly kind: EntryKind;
  readonly objectName?: string;
}

function findNearestObjectName(lines: readonly string[], line: number): string | undefined {
  for (let i = line; i >= 0; i -= 1) {
    const objectMatch = lines[i].match(/^\s*object\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (objectMatch?.[1]) {
      return objectMatch[1];
    }
  }

  return undefined;
}

export function inferPackageName(text: string): string | undefined {
  const match = text.match(/^\s*package\s+([A-Za-z0-9_.]+)/m);
  return match?.[1];
}

export function detectRunEntryPoints(text: string): EntryPoint[] {
  const entries: EntryPoint[] = [];
  const lines = text.split(/\r?\n/);

  let hasScalaCliDirective = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^\s*\/\/>\s+using\b/.test(line)) {
      hasScalaCliDirective = true;
    }

    const scala3MainMatch = line.match(/^\s*@main\s+def\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (scala3MainMatch?.[1]) {
      entries.push({
        line: index,
        displayName: scala3MainMatch[1],
        kind: 'scala3-main-def'
      });
      continue;
    }

    const appObjectMatch = line.match(/^\s*object\s+([A-Za-z_][A-Za-z0-9_]*)\s+extends\s+App\b/);
    if (appObjectMatch?.[1]) {
      entries.push({
        line: index,
        displayName: appObjectMatch[1],
        kind: 'scala2-app-object',
        objectName: appObjectMatch[1]
      });
      continue;
    }

    const mainMethodMatch = line.match(/^\s*def\s+main\s*\(\s*args\s*:\s*Array\[[^\]]+\]\s*\)\s*:\s*Unit\b/);
    if (mainMethodMatch) {
      const objectName = findNearestObjectName(lines, index);
      entries.push({
        line: index,
        displayName: objectName ? `${objectName}.main` : 'main',
        kind: 'scala-main-method',
        objectName
      });
    }
  }

  if (hasScalaCliDirective && entries.length === 0) {
    entries.push({
      line: 0,
      displayName: 'Scala CLI Script',
      kind: 'scala-cli-script'
    });
  }

  return entries;
}

export function inferFqnForEntry(packageName: string | undefined, entry: EntryPoint): string | undefined {
  const symbol = entry.kind === 'scala3-main-def' ? entry.displayName : entry.objectName;
  if (!symbol) {
    return undefined;
  }

  return packageName ? `${packageName}.${symbol}` : symbol;
}

export function createRunCommandFromInputs(
  buildTool: BuildTool,
  filePath: string,
  entry: EntryPoint,
  packageName: string | undefined,
  millModule: string
): string | undefined {
  const inferredFqn = inferFqnForEntry(packageName, entry);

  if (buildTool === 'scala-cli') {
    return `scala-cli run "${filePath}"`;
  }

  if (buildTool === 'sbt' && inferredFqn) {
    return `sbt "runMain ${inferredFqn}"`;
  }

  if (buildTool === 'mill' && inferredFqn) {
    return `mill ${millModule}.runMain ${inferredFqn}`;
  }

  if (buildTool === 'none') {
    return undefined;
  }

  return inferredFqn ? `sbt "runMain ${inferredFqn}"` : undefined;
}