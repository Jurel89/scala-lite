import * as vscode from 'vscode';
import { StructuredLogger } from './structuredLogger';
import { NativeEngine, NativeEngineUnavailableError } from './nativeEngine';

export const COMMAND_RESTART_NATIVE_ENGINE = 'scalaLite.restartNativeEngine';

interface NativeEngineRuntime {
  available: boolean;
  status: 'active' | 'fallback' | 'crashed' | 'restarting';
  engine: NativeEngine;
  lastError: string | undefined;
}

const runtime: NativeEngineRuntime = {
  available: false,
  status: 'fallback',
  engine: NativeEngine.createFallback(),
  lastError: undefined
};

function showFallbackModeBadge(): void {
  vscode.window.setStatusBarMessage(vscode.l10n.t('⚠ Fallback mode (slower)'), 5000);
}

function bindMemoryUsageHook(engine: NativeEngine): void {
  let cachedNativeRssBytes = 0;
  const globalScope = globalThis as {
    __scalaLiteNativeMemoryUsage?: () => number | { rssBytes?: number };
  };

  globalScope.__scalaLiteNativeMemoryUsage = () => {
    if (engine.status === 'crashed') {
      return { rssBytes: cachedNativeRssBytes };
    }

    void engine.getMemoryUsage()
      .then((usage) => {
        cachedNativeRssBytes = usage.nativeRssBytes;
      })
      .catch(() => {
      });
    return { rssBytes: cachedNativeRssBytes };
  };
}

function createRuntimeFromLoad(): { readonly ok: boolean; readonly engine: NativeEngine; readonly error?: string } {
  try {
    const engine = NativeEngine.create();
    return { ok: engine.status === 'active', engine };
  } catch (error) {
    if (error instanceof NativeEngineUnavailableError) {
      return {
        ok: false,
        engine: NativeEngine.createFallback(),
        error: error.message
      };
    }

    return {
      ok: false,
      engine: NativeEngine.createFallback(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function isNativeEngineAvailable(): boolean {
  return runtime.available;
}

export function getNativeEngineStatus(): 'active' | 'fallback' | 'crashed' | 'restarting' {
  return runtime.status;
}

export function getNativeEngine(): NativeEngine {
  return runtime.engine;
}

export function initializeNativeEngine(logger: StructuredLogger): void {
  const load = createRuntimeFromLoad();
  runtime.engine = load.engine;
  runtime.available = load.ok;
  runtime.status = load.engine.status;
  runtime.lastError = load.error;
  bindMemoryUsageHook(runtime.engine);

  if (!runtime.available) {
    logger.warn('ACTIVATE', `Native engine unavailable. Falling back to TypeScript path. ${load.error ?? ''}`.trim());
    showFallbackModeBadge();
  }
}

async function restartNativeEngine(logger: StructuredLogger): Promise<void> {
  runtime.status = 'restarting';
  const load = createRuntimeFromLoad();
  runtime.engine = load.engine;
  runtime.available = load.ok;
  runtime.status = load.engine.status;
  runtime.lastError = load.error;
  bindMemoryUsageHook(runtime.engine);

  if (runtime.available) {
    vscode.window.showInformationMessage(vscode.l10n.t('Native engine restarted successfully.'));
    logger.info('ACTIVATE', 'Native engine restarted successfully.');
    return;
  }

  showFallbackModeBadge();
  vscode.window.showWarningMessage(vscode.l10n.t('Native engine restart failed. Continuing in fallback mode.'));
  logger.warn('ACTIVATE', `Native engine restart failed. ${load.error ?? ''}`.trim());
}

export function registerNativeEngineFeature(logger: StructuredLogger): vscode.Disposable[] {
  const restartCommand = vscode.commands.registerCommand(COMMAND_RESTART_NATIVE_ENGINE, async () => {
    await restartNativeEngine(logger);
  });

  return [restartCommand];
}
