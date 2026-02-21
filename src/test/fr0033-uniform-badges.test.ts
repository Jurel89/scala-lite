import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatResultBadge } from '../resultBadges';

test('FR-0033: formatResultBadge returns correct badge for indexed source', () => {
  const badge = formatResultBadge('indexed');
  assert.equal(badge, '[Indexed]');
});

test('FR-0033: formatResultBadge returns correct badge for text source', () => {
  const badge = formatResultBadge('text');
  assert.equal(badge, '≈ [Text]');
});
