const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startLog, appendEntry, readEntries } = require('../src/audit-log');

function tempLogPath() {
  return path.join(os.tmpdir(), `audit-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

test('startLog creates an empty file', () => {
  const filePath = tempLogPath();
  startLog(filePath);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '');
  fs.unlinkSync(filePath);
});

test('appendEntry writes one JSON object per line', () => {
  const filePath = tempLogPath();
  startLog(filePath);
  appendEntry({ customer_id: 'cust_0001', action: 'escalate' }, filePath);
  appendEntry({ customer_id: 'cust_0002', action: 'recover' }, filePath);
  const entries = readEntries(filePath);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].customer_id, 'cust_0001');
  assert.equal(entries[1].action, 'recover');
  fs.unlinkSync(filePath);
});

test('startLog truncates a pre-existing file so re-runs do not mix audit trails', () => {
  const filePath = tempLogPath();
  startLog(filePath);
  appendEntry({ customer_id: 'stale' }, filePath);
  startLog(filePath); // simulate a second run
  appendEntry({ customer_id: 'fresh' }, filePath);
  const entries = readEntries(filePath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].customer_id, 'fresh');
  fs.unlinkSync(filePath);
});
