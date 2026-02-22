import * as vscode from 'vscode';
import { totalmem } from 'node:os';
import { WorkspaceMode } from './modePresentation';
import { StructuredLogger } from './structuredLogger';
import { MemoryBudgetOverrideConfig, readMemoryBudgetOverridesFromWorkspaceConfig } from './workspaceConfig';
import { MemoryBreakdown } from './symbolIndex';

export const COMMAND_RUN_MEMORY_BUDGET_AUDIT = 'scalaLite.runMemoryBudgetAudit';
export const COMMAND_MEMORY_REPORT = 'scalaLite.memoryReport';

interface ModeMemoryBudget {
  readonly maxTotalBytes: number;
  readonly maxHeapBytes: number;
  readonly maxNativeBytes: number;
}

export interface WorkspaceMemoryMetrics {
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly openFileCount: number;
  readonly scalaLiteEstimatedHeapBytes: number;
}

interface MemoryUsageSnapshot {
  readonly extensionHostHeapBytes: number;
  readonly scalaLiteEstimatedHeapBytes: number;
  readonly nativeAccountedBytes: number;
  readonly nativeEstimatedOverheadBytes: number;
  readonly nativeRssBytes: number;
  readonly totalBytes: number;
  readonly nativeIncludes: string;
  readonly nativeExcludes: string;
}

export interface BudgetAuditResult {
  readonly exceeded: boolean;
  readonly heapOverage: number;
  readonly nativeOverage: number;
  readonly totalOverage: number;
  readonly heapUsedBytes: number;
  readonly nativeUsedBytes: number;
  readonly totalUsedBytes: number;
  readonly maxHeapBytes: number;
  readonly maxNativeBytes: number;
  readonly maxTotalBytes: number;
}

const MB = 1024 * 1024;

const MODE_MEMORY_BUDGETS: Record<WorkspaceMode, ModeMemoryBudget> = {
  A: {
    maxTotalBytes: 25 * MB,
    maxHeapBytes: 20 * MB,
    maxNativeBytes: 5 * MB
  },
  B: {
    maxTotalBytes: 55 * MB,
    maxHeapBytes: 30 * MB,
    maxNativeBytes: 25 * MB
  },
  C: {
    maxTotalBytes: 100 * MB,
    maxHeapBytes: 30 * MB,
    maxNativeBytes: 70 * MB
  }
};

function toMbBytes(valueMb: number): number {
  return Math.max(0, Math.round(valueMb * MB));
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue);
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.round(value);
}

export function computeBudgetForMode(
  mode: WorkspaceMode,
  metrics: WorkspaceMemoryMetrics,
  overrides: MemoryBudgetOverrideConfig = {},
  totalSystemMemoryBytes: number = totalmem()
): ModeMemoryBudget {
  const floor = MODE_MEMORY_BUDGETS[mode];
  const fileCount = normalizeCount(metrics.fileCount);
  const symbolCount = normalizeCount(metrics.symbolCount);
  const openFileCount = normalizeCount(metrics.openFileCount);

  const defaultModeCTotalCap = Math.min(toMbBytes(768), Math.max(0, Math.round(totalSystemMemoryBytes * 0.08)));
  const modeCTotalCap = overrides.totalMb ? toMbBytes(overrides.totalMb) : defaultModeCTotalCap;
  const modeCHeapCap = overrides.heapMb ? toMbBytes(overrides.heapMb) : toMbBytes(512);
  const modeCNativeCap = overrides.nativeMb ? toMbBytes(overrides.nativeMb) : toMbBytes(256);

  if (mode === 'A') {
    return floor;
  }

  if (mode === 'B') {
    const computedHeap = Math.max(toMbBytes(20), toMbBytes(openFileCount * 0.5));
    const maxHeapBytes = Math.max(floor.maxHeapBytes, computedHeap);
    const maxNativeBytes = floor.maxNativeBytes;
    const maxTotalBytes = Math.max(floor.maxTotalBytes, maxHeapBytes + maxNativeBytes);

    return {
      maxTotalBytes,
      maxHeapBytes,
      maxNativeBytes
    };
  }

  const computedHeap = Math.max(toMbBytes(50), toMbBytes(fileCount * 0.4));
  const computedNative = Math.max(toMbBytes(20), toMbBytes(symbolCount * 0.004));

  const cappedHeap = clamp(computedHeap, floor.maxHeapBytes, Math.max(floor.maxHeapBytes, modeCHeapCap));
  const cappedNative = clamp(computedNative, floor.maxNativeBytes, Math.max(floor.maxNativeBytes, modeCNativeCap));
  const cappedTotal = clamp(
    cappedHeap + cappedNative,
    floor.maxTotalBytes,
    Math.max(floor.maxTotalBytes, modeCTotalCap)
  );

  return {
    maxTotalBytes: cappedTotal,
    maxHeapBytes: cappedHeap,
    maxNativeBytes: cappedNative
  };
}

function formatBytes(bytes: number): string {
  return `${(Math.max(0, bytes) / MB).toFixed(1)}MB`;
}

function readNativeRssBytes(): number {
  return readNativeUsage().nativeRssBytes;
}

function readNativeUsage(): {
  readonly nativeRssBytes: number;
  readonly accountedBytes: number;
  readonly estimatedOverheadBytes: number;
  readonly includes: string;
  readonly excludes: string;
} {
  try {
    const globalScope = globalThis as {
      __scalaLiteNativeMemoryUsage?: () => number | {
        rssBytes?: number;
        accountedBytes?: number;
        estimatedOverheadBytes?: number;
        includes?: string;
        excludes?: string;
      };
    };

    const provider = globalScope.__scalaLiteNativeMemoryUsage;
    if (!provider) {
      return {
        nativeRssBytes: 0,
        accountedBytes: 0,
        estimatedOverheadBytes: 0,
        includes: 'native engine allocations',
        excludes: 'allocator metadata and runtime overhead'
      };
    }

    const value = provider();
    if (typeof value === 'number' && Number.isFinite(value)) {
      const nativeRssBytes = Math.max(0, Math.round(value));
      return {
        nativeRssBytes,
        accountedBytes: nativeRssBytes,
        estimatedOverheadBytes: 0,
        includes: 'native engine allocations',
        excludes: 'allocator metadata and runtime overhead'
      };
    }

    if (typeof value === 'object' && value) {
      const nativeRssBytes = typeof value.rssBytes === 'number' && Number.isFinite(value.rssBytes)
        ? Math.max(0, Math.round(value.rssBytes))
        : 0;
      const accountedBytes = typeof value.accountedBytes === 'number' && Number.isFinite(value.accountedBytes)
        ? Math.max(0, Math.round(value.accountedBytes))
        : nativeRssBytes;
      const estimatedOverheadBytes = typeof value.estimatedOverheadBytes === 'number'
        && Number.isFinite(value.estimatedOverheadBytes)
        ? Math.max(0, Math.round(value.estimatedOverheadBytes))
        : Math.max(0, nativeRssBytes - accountedBytes);

      return {
        nativeRssBytes,
        accountedBytes,
        estimatedOverheadBytes,
        includes: typeof value.includes === 'string' ? value.includes : 'native engine allocations',
        excludes: typeof value.excludes === 'string' ? value.excludes : 'allocator metadata and runtime overhead'
      };
    }
  } catch {
  }

  return {
    nativeRssBytes: 0,
    accountedBytes: 0,
    estimatedOverheadBytes: 0,
    includes: 'native engine allocations',
    excludes: 'allocator metadata and runtime overhead'
  };
}

function sampleMemoryUsage(metrics: WorkspaceMemoryMetrics): MemoryUsageSnapshot {
  const extensionHostHeapBytes = Math.max(0, Math.round(process.memoryUsage().heapUsed));
  const scalaLiteEstimatedHeapBytes = Math.max(0, Math.round(metrics.scalaLiteEstimatedHeapBytes));
  const nativeUsage = readNativeUsage();
  const totalBytes = scalaLiteEstimatedHeapBytes + nativeUsage.nativeRssBytes;

  return {
    extensionHostHeapBytes,
    scalaLiteEstimatedHeapBytes,
    nativeAccountedBytes: nativeUsage.accountedBytes,
    nativeEstimatedOverheadBytes: nativeUsage.estimatedOverheadBytes,
    nativeRssBytes: nativeUsage.nativeRssBytes,
    totalBytes,
    nativeIncludes: nativeUsage.includes,
    nativeExcludes: nativeUsage.excludes
  };
}

export async function auditMemoryBudgetForMode(
  mode: WorkspaceMode,
  logger: StructuredLogger,
  metrics: WorkspaceMemoryMetrics
): Promise<BudgetAuditResult> {
  const overrides = await readMemoryBudgetOverridesFromWorkspaceConfig();
  const budget = computeBudgetForMode(mode, metrics, overrides);
  const snapshot = sampleMemoryUsage(metrics);

  const withinHeap = snapshot.scalaLiteEstimatedHeapBytes <= budget.maxHeapBytes;
  const withinNative = snapshot.nativeRssBytes <= budget.maxNativeBytes;
  const withinTotal = snapshot.totalBytes <= budget.maxTotalBytes;

  const logMessage =
    `Mode ${mode} memory usage — extension host heap: ${formatBytes(snapshot.extensionHostHeapBytes)}, ` +
    `estimated scala-lite heap: ${formatBytes(snapshot.scalaLiteEstimatedHeapBytes)}/${formatBytes(budget.maxHeapBytes)}, ` +
    `native: ${formatBytes(snapshot.nativeRssBytes)}/${formatBytes(budget.maxNativeBytes)}, ` +
    `total: ${formatBytes(snapshot.totalBytes)}/${formatBytes(budget.maxTotalBytes)}. ` +
    `Native accounting — accounted: ${formatBytes(snapshot.nativeAccountedBytes)}, ` +
    `estimated overhead: ${formatBytes(snapshot.nativeEstimatedOverheadBytes)}, ` +
    `includes: ${snapshot.nativeIncludes}, excludes: ${snapshot.nativeExcludes}.`;

  const result: BudgetAuditResult = {
    exceeded: !(withinHeap && withinNative && withinTotal),
    heapOverage: Math.max(0, snapshot.scalaLiteEstimatedHeapBytes - budget.maxHeapBytes),
    nativeOverage: Math.max(0, snapshot.nativeRssBytes - budget.maxNativeBytes),
    totalOverage: Math.max(0, snapshot.totalBytes - budget.maxTotalBytes),
    heapUsedBytes: snapshot.scalaLiteEstimatedHeapBytes,
    nativeUsedBytes: snapshot.nativeRssBytes,
    totalUsedBytes: snapshot.totalBytes,
    maxHeapBytes: budget.maxHeapBytes,
    maxNativeBytes: budget.maxNativeBytes,
    maxTotalBytes: budget.maxTotalBytes
  };

  if (withinHeap && withinNative && withinTotal) {
    logger.info('BUDGET', logMessage);
    return result;
  }

  logger.warn('BUDGET', `[MEMORY] Budget exceeded. ${logMessage}`);
  return result;
}

export function registerMemoryBudgetFeature(
  getMode: () => WorkspaceMode,
  getMetrics: () => WorkspaceMemoryMetrics,
  getMemoryBreakdown: () => Promise<MemoryBreakdown>,
  logger: StructuredLogger
): vscode.Disposable[] {
  const memoryOutputChannel = vscode.window.createOutputChannel('Scala Lite Memory');

  const command = vscode.commands.registerCommand(COMMAND_RUN_MEMORY_BUDGET_AUDIT, async () => {
    const mode = getMode();
    await auditMemoryBudgetForMode(mode, logger, getMetrics());
    vscode.window.showInformationMessage(vscode.l10n.t('Memory budget audit completed for mode {0}.', mode));
  });

  const memoryReportCommand = vscode.commands.registerCommand(COMMAND_MEMORY_REPORT, async () => {
    const mode = getMode();
    const metrics = getMetrics();
    const breakdown = await getMemoryBreakdown();
    const overrides = await readMemoryBudgetOverridesFromWorkspaceConfig();
    const budget = computeBudgetForMode(mode, metrics, overrides);

    const reportLines = [
      'Scala Lite Memory Report',
      '========================',
      `Mode: ${mode}`,
      `Indexed files: ${breakdown.fileCount}`,
      `Symbol count: ${breakdown.symbolCount}`,
      `Import count: ${breakdown.importCount}`,
      `Diagnostic count: ${breakdown.diagnosticCount}`,
      `Content cache size (bytes): ${breakdown.contentCacheBytes}`,
      `Estimated JS heap contribution (bytes): ${breakdown.estimatedJsHeapBytes}`,
      `Native engine memory (bytes): ${breakdown.nativeMemoryUsage.nativeRssBytes}`,
      `Native accounted bytes: ${breakdown.nativeMemoryUsage.accountedBytes}`,
      `Native estimated overhead bytes: ${breakdown.nativeMemoryUsage.estimatedOverheadBytes}`,
      `Native includes: ${breakdown.nativeMemoryUsage.includes}`,
      `Native excludes: ${breakdown.nativeMemoryUsage.excludes}`,
      `String table entries: ${breakdown.stringTableEntries ?? 'n/a'}`,
      `String table estimated byte savings: ${breakdown.stringTableBytes ?? 'n/a'}`,
      `Mode heap budget (bytes): ${budget.maxHeapBytes}`,
      `Mode native budget (bytes): ${budget.maxNativeBytes}`,
      `Mode total budget (bytes): ${budget.maxTotalBytes}`
    ];

    memoryOutputChannel.clear();
    memoryOutputChannel.appendLine(reportLines.join('\n'));
    memoryOutputChannel.show(true);

    logger.debug('BUDGET', `[MEMORY_REPORT]\n${reportLines.join('\n')}`);
    vscode.window.showInformationMessage(vscode.l10n.t('Scala Lite memory report generated.'));
  });

  return [command, memoryReportCommand, memoryOutputChannel];
}
