import * as vscode from 'vscode';
import { WorkspaceMode } from './modePresentation';
import { StructuredLogger } from './structuredLogger';

export const COMMAND_RUN_MEMORY_BUDGET_AUDIT = 'scalaLite.runMemoryBudgetAudit';

interface ModeMemoryBudget {
  readonly maxTotalBytes: number;
  readonly maxHeapBytes: number;
  readonly maxNativeBytes: number;
}

interface MemoryUsageSnapshot {
  readonly heapUsedBytes: number;
  readonly nativeRssBytes: number;
  readonly totalBytes: number;
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

function formatBytes(bytes: number): string {
  return `${(Math.max(0, bytes) / MB).toFixed(1)}MB`;
}

function readNativeRssBytes(): number {
  try {
    const globalScope = globalThis as {
      __scalaLiteNativeMemoryUsage?: () => number | { rssBytes?: number };
    };

    const provider = globalScope.__scalaLiteNativeMemoryUsage;
    if (!provider) {
      return 0;
    }

    const value = provider();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }

    if (typeof value === 'object' && value && typeof value.rssBytes === 'number' && Number.isFinite(value.rssBytes)) {
      return Math.max(0, Math.round(value.rssBytes));
    }
  } catch {
  }

  return 0;
}

function sampleMemoryUsage(): MemoryUsageSnapshot {
  const heapUsedBytes = Math.max(0, Math.round(process.memoryUsage().heapUsed));
  const nativeRssBytes = readNativeRssBytes();
  const totalBytes = heapUsedBytes + nativeRssBytes;

  return {
    heapUsedBytes,
    nativeRssBytes,
    totalBytes
  };
}

export function auditMemoryBudgetForMode(mode: WorkspaceMode, logger: StructuredLogger): void {
  const budget = MODE_MEMORY_BUDGETS[mode];
  const snapshot = sampleMemoryUsage();

  const withinHeap = snapshot.heapUsedBytes <= budget.maxHeapBytes;
  const withinNative = snapshot.nativeRssBytes <= budget.maxNativeBytes;
  const withinTotal = snapshot.totalBytes <= budget.maxTotalBytes;

  const logMessage =
    `Mode ${mode} memory usage — heap: ${formatBytes(snapshot.heapUsedBytes)}/${formatBytes(budget.maxHeapBytes)}, ` +
    `native: ${formatBytes(snapshot.nativeRssBytes)}/${formatBytes(budget.maxNativeBytes)}, ` +
    `total: ${formatBytes(snapshot.totalBytes)}/${formatBytes(budget.maxTotalBytes)}.`;

  if (withinHeap && withinNative && withinTotal) {
    logger.info('BUDGET', logMessage);
    return;
  }

  logger.warn('BUDGET', `[MEMORY] Budget exceeded. ${logMessage}`);
}

export function registerMemoryBudgetFeature(
  getMode: () => WorkspaceMode,
  logger: StructuredLogger
): vscode.Disposable[] {
  const command = vscode.commands.registerCommand(COMMAND_RUN_MEMORY_BUDGET_AUDIT, async () => {
    const mode = getMode();
    auditMemoryBudgetForMode(mode, logger);
    vscode.window.showInformationMessage(vscode.l10n.t('Memory budget audit completed for mode {0}.', mode));
  });

  return [command];
}
