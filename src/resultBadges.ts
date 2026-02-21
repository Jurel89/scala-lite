export type ResultSource = 'indexed' | 'text';

export function formatResultBadge(source: ResultSource): string {
  if (source === 'indexed') {
    return '[Indexed]';
  }

  return '≈ [Text]';
}
