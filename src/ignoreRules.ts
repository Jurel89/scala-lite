import * as vscode from 'vscode';
import { resolveIgnoreRules, IgnoreRulesResolution } from './ignoreRulesCore';
import { StructuredLogger } from './structuredLogger';
import { readIgnoreRulesFromWorkspaceConfig } from './workspaceConfig';

function renderInvalidPatternWarning(patterns: readonly string[]): string {
  return `Invalid ignore pattern(s) in .vscode/scala-lite.json: ${patterns.join(', ')}`;
}

export async function resolveWorkspaceIgnoreRules(): Promise<IgnoreRulesResolution> {
  const config = await readIgnoreRulesFromWorkspaceConfig();
  return resolveIgnoreRules(config);
}

export async function validateIgnoreRulesAtActivation(logger: StructuredLogger): Promise<void> {
  const resolved = await resolveWorkspaceIgnoreRules();

  if (resolved.unsafeModeEnabled) {
    const unsafeMessage = vscode.l10n.t('Unsafe mode enabled. Performance guardrails weakened. Scanning may be slow.');
    logger.warn('CONFIG', unsafeMessage);
    vscode.window.showWarningMessage(unsafeMessage);
  }

  if (resolved.blockedHardSafetyRemovals.length > 0) {
    logger.warn(
      'CONFIG',
      `Blocked hard-safety ignore removal(s): ${resolved.blockedHardSafetyRemovals.join(', ')}`
    );
  }

  if (resolved.invalidPatterns.length > 0) {
    const warning = renderInvalidPatternWarning(resolved.invalidPatterns);
    logger.warn('CONFIG', warning);
    vscode.window.showWarningMessage(vscode.l10n.t('Some ignore patterns are invalid. See Scala Lite output for details.'));
  }
}
