export type WorkspaceMode = 'A' | 'B' | 'C';

interface ModeDefinition {
  readonly mode: WorkspaceMode;
  readonly text: string;
  readonly description: string;
  readonly impact: string;
}

export const MODES: readonly ModeDefinition[] = [
  {
    mode: 'A',
    text: '⚡ A',
    description: 'Editing-only: syntax and lightweight editing features.',
    impact: 'Minimal CPU/RAM. No background indexing.'
  },
  {
    mode: 'B',
    text: '▶ B',
    description: 'Run/Test: task discovery and execution workflows.',
    impact: 'Medium CPU/RAM while running commands.'
  },
  {
    mode: 'C',
    text: '🔍 C',
    description: 'Indexed Module: adds lightweight symbol indexing.',
    impact: 'Higher CPU/RAM during indexing for selected module.'
  }
] as const;

export function getModeText(mode: WorkspaceMode): string {
  return MODES.find((item) => item.mode === mode)?.text ?? '⚡ A';
}

export function getModeDefinition(mode: WorkspaceMode): ModeDefinition {
  return MODES.find((item) => item.mode === mode) ?? MODES[0];
}