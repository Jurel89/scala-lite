import { Minimatch } from 'minimatch';

export const HARD_SAFETY_IGNORES = [
  'target/',
  '.bloop/',
  '.metals/',
  '.scala-build/',
  '.idea/',
  '.bsp/',
  '.ammonite/'
] as const;

export const DEFAULT_IGNORES = [
  'node_modules/',
  'dist/',
  'out/',
  '.git/',
  '__pycache__/',
  'build/',
  '.gradle/'
] as const;

export interface IgnoreRulesInput {
  readonly ignorePatterns?: readonly string[];
  readonly unsafeMode?: boolean;
}

export interface IgnoreRulesResolution {
  readonly unsafeModeEnabled: boolean;
  readonly hardSafetyPatterns: readonly string[];
  readonly defaultPatterns: readonly string[];
  readonly customPatterns: readonly string[];
  readonly effectivePatterns: readonly string[];
  readonly invalidPatterns: readonly string[];
  readonly blockedHardSafetyRemovals: readonly string[];
  readonly warnings: readonly string[];
}

function normalizeCandidate(candidate: string): string {
  return candidate.trim().replace(/\\+/g, '/').replace(/^\.\//, '');
}

function isValidGlobPattern(pattern: string): boolean {
  if (pattern.length === 0) {
    return false;
  }

  const pairChecks: ReadonlyArray<readonly [string, string]> = [
    ['[', ']'],
    ['{', '}'],
    ['(', ')']
  ];

  for (const [openChar, closeChar] of pairChecks) {
    const openCount = pattern.split(openChar).length - 1;
    const closeCount = pattern.split(closeChar).length - 1;
    if (openCount !== closeCount) {
      return false;
    }
  }

  const matcher = new Minimatch(pattern, { dot: true });
  return matcher.makeRe() !== false;
}

function dedupeInOrder(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

export function resolveIgnoreRules(input: IgnoreRulesInput): IgnoreRulesResolution {
  const unsafeModeEnabled = input.unsafeMode === true;
  const hardSafety = new Set<string>(HARD_SAFETY_IGNORES);
  const defaults = new Set<string>(DEFAULT_IGNORES);
  const customPatterns: string[] = [];
  const invalidPatterns: string[] = [];
  const blockedHardSafetyRemovals: string[] = [];

  for (const rawPattern of input.ignorePatterns ?? []) {
    const trimmed = rawPattern.trim();
    if (trimmed.length === 0) {
      invalidPatterns.push(rawPattern);
      continue;
    }

    const isRemoval = trimmed.startsWith('!');
    const candidate = normalizeCandidate(isRemoval ? trimmed.slice(1) : trimmed);

    if (!isValidGlobPattern(candidate)) {
      invalidPatterns.push(rawPattern);
      continue;
    }

    if (isRemoval) {
      if (hardSafety.has(candidate)) {
        if (unsafeModeEnabled) {
          hardSafety.delete(candidate);
        } else {
          blockedHardSafetyRemovals.push(candidate);
        }
        continue;
      }

      defaults.delete(candidate);
      continue;
    }

    customPatterns.push(candidate);
  }

  const hardSafetyPatterns = Array.from(hardSafety);
  const defaultPatterns = Array.from(defaults);
  const effectivePatterns = dedupeInOrder([
    ...hardSafetyPatterns,
    ...defaultPatterns,
    ...customPatterns
  ]);

  const warnings: string[] = [];
  if (unsafeModeEnabled) {
    warnings.push('Unsafe mode enabled. Performance guardrails weakened. Scanning may be slow.');
  }

  if (blockedHardSafetyRemovals.length > 0) {
    warnings.push('Hard safety ignore patterns cannot be removed unless unsafeMode is true.');
  }

  if (invalidPatterns.length > 0) {
    warnings.push('One or more ignore patterns are invalid and were skipped.');
  }

  return {
    unsafeModeEnabled,
    hardSafetyPatterns,
    defaultPatterns,
    customPatterns,
    effectivePatterns,
    invalidPatterns,
    blockedHardSafetyRemovals,
    warnings
  };
}

export function toRipgrepExcludeGlobArgs(ignorePatterns: readonly string[]): string[] {
  return ignorePatterns.map((pattern) => `--glob=!${pattern}`);
}
