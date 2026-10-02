import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import md from '../../scripts/agent-docs.mjs';

test('docs/agent.md is up to date (run node scripts/agent-docs.mjs)', () => {
  assert.equal(readFileSync(new URL('../../docs/agent.md', import.meta.url), 'utf8'), md);
});
