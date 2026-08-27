'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const outbox = require('../src/services/outboxService');

test('outbox deduplicates a committed event key', () => {
  store.clear();
  const first = outbox.enqueue({ key: 'stream-1:created', type: 'stream.created', aggregateId: 'stream-1', payload: { id: 'stream-1' } });
  const second = outbox.enqueue({ key: 'stream-1:created', type: 'stream.created', aggregateId: 'stream-1', payload: { id: 'changed' } });
  assert.equal(first.id, second.id);
  assert.equal(outbox.list().length, 1);
  assert.equal(second.payload.id, 'stream-1');
});

test('delivery retries transient failures with backoff and isolates poison events', async () => {
  store.clear();
  const now = Date.now();
  outbox.enqueue({ key: 'ok', type: 'ok', aggregateId: '1', payload: {} });
  outbox.enqueue({ key: 'poison', type: 'poison', aggregateId: '2', payload: {} });

  const first = await outbox.deliverPending(async (event) => {
    if (event.key === 'poison') throw new Error('bad payload');
  }, { now });
  assert.equal(first.delivered.length, 1);
  assert.equal(first.failed.length, 1);
  assert.equal(outbox.list({ status: 'delivered' }).length, 1);
  assert.equal(outbox.list({ status: 'pending' })[0].nextAttemptAt, now + 1000);
});

test('events become permanently failed after bounded retries', async () => {
  store.clear();
  outbox.enqueue({ key: 'poison', type: 'poison', aggregateId: '2', payload: {} });
  for (let attempt = 0; attempt < outbox.MAX_ATTEMPTS; attempt += 1) {
    const event = outbox.list()[0];
    await outbox.deliverPending(() => { throw new Error('bad payload'); }, { now: event.nextAttemptAt });
  }
  assert.equal(outbox.list({ status: 'failed' }).length, 1);
});
