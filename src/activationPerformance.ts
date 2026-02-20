import * as vscode from 'vscode';
import { StructuredLogger } from './structuredLogger';

export const COMMAND_RUN_ACTIVATION_AUDIT = 'scalaLite.runActivationAudit';
export const ACTIVATION_BUDGET_MS = 500;

let lastActivationDurationMs: number | undefined;

export function recordActivationDuration(durationMs: number, logger: StructuredLogger): void {
  const normalizedDuration = Math.max(0, Math.round(durationMs));
  lastActivationDurationMs = normalizedDuration;

  logger.info('ACTIVATE', `Activation core completed in ${normalizedDuration}ms.`);
  if (normalizedDuration > ACTIVATION_BUDGET_MS) {
    logger.warn(
      'ACTIVATE',
      `Activation exceeded performance budget (${normalizedDuration}ms > ${ACTIVATION_BUDGET_MS}ms).`
    );
  }
}

export function registerActivationPerformanceFeature(): vscode.Disposable[] {
  const command = vscode.commands.registerCommand(COMMAND_RUN_ACTIVATION_AUDIT, async () => {
    if (typeof lastActivationDurationMs !== 'number') {
      vscode.window.showInformationMessage(vscode.l10n.t('Activation audit unavailable until extension has fully initialized.'));
      return;
    }

    const message = vscode.l10n.t(
      'Activation audit: {0}ms (budget: {1}ms).',
      String(lastActivationDurationMs),
      String(ACTIVATION_BUDGET_MS)
    );

    if (lastActivationDurationMs > ACTIVATION_BUDGET_MS) {
      vscode.window.showWarningMessage(message);
      return;
    }

    vscode.window.showInformationMessage(message);
  });

  return [command];
}
