import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatStructuredLogEntry,
  shouldEmitLog
} from '../structuredLogCore';

test('FR-0021: structured log format matches specification', () => {
  const line = formatStructuredLogEntry({
    timestamp: new Date('2026-02-20T14:32:05Z'),
    level: 'INFO',
    category: 'INDEX',
    message: 'Indexed 23 files (45 symbols).',
    durationMs: 187
  });

  assert.equal(line.includes('[INFO] [INDEX] Indexed 23 files (45 symbols). (187ms)'), true);
});

test('FR-0021: log level filtering hides DEBUG at INFO threshold', () => {
  assert.equal(shouldEmitLog('DEBUG', 'INFO'), false);
  assert.equal(shouldEmitLog('INFO', 'INFO'), true);
  assert.equal(shouldEmitLog('WARN', 'INFO'), true);
});
