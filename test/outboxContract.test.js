'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const outbox = require('../src/services/outboxService');

test.beforeEach(() => store.clear());

function event(key, type = 'stream.changed') {
  return outbox.enqueue({ key, type, aggregateId: key.split(':')[0], payload: { key, value: 1 } });
}

test('new events begin pending with zero attempts and a ready time', () => {
  const record = event('stream-1:created');
  assert.equal(record.status, 'pending');
  assert.equal(record.attempts, 0);
  assert.ok(record.nextAttemptAt <= Date.now());
  assert.equal(record.deliveredAt, null);
  assert.equal(record.lastError, null);
});

test('deduplication preserves the first immutable payload', () => {
  const first = event('stream-1:created', 'stream.created');
  const second = outbox.enqueue({
    key: 'stream-1:created',
    type: 'different.type',
    aggregateId: 'stream-1',
    payload: { value: 999 },
  });
  assert.equal(first.id, second.id);
  assert.equal(second.type, 'stream.created');
  assert.equal(second.payload.value, 1);
});

test('delivery marks a successful event delivered and records the delivery copy', async () => {
  const record = event('stream-1:created');
  const seen = [];
  const result = await outbox.deliverPending(async (item) => seen.push(item.key));
  assert.deepEqual(seen, ['stream-1:created']);
  assert.equal(result.delivered.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(record.status, 'delivered');
  assert.equal(record.attempts, 1);
  assert.equal(store.deliveredEvents.get(record.key).id, record.id);
});

test('a delivered event is never selected again', async () => {
  event('stream-1:created');
  let calls = 0;
  await outbox.deliverPending(async () => { calls += 1; });
  const result = await outbox.deliverPending(async () => { calls += 1; });
  assert.equal(calls, 1);
  assert.equal(result.delivered.length, 0);
});

test('a failed event returns to pending with exponential backoff', async () => {
  const now = Date.now();
  const record = event('stream-1:created');
  await outbox.deliverPending(() => { throw new Error('temporary'); }, { now });
  assert.equal(record.status, 'pending');
  assert.equal(record.attempts, 1);
  assert.equal(record.nextAttemptAt, now + outbox.BASE_BACKOFF_MS);
  assert.equal(record.lastError, 'temporary');
});

test('events before their next attempt time are not claimed', async () => {
  const now = Date.now();
  const record = event('stream-1:created');
  await outbox.deliverPending(() => { throw new Error('temporary'); }, { now });
  const result = await outbox.deliverPending(() => {}, { now: record.nextAttemptAt - 1 });
  assert.equal(result.delivered.length, 0);
  assert.equal(record.attempts, 1);
});

test('retry backoff doubles for each consecutive failure', async () => {
  const record = event('stream-1:created');
  let now = Date.now();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await outbox.deliverPending(() => { throw new Error(`failure-${attempt}`); }, { now });
    assert.equal(record.attempts, attempt);
    assert.equal(record.nextAttemptAt, now + outbox.BASE_BACKOFF_MS * (2 ** (attempt - 1)));
    now = record.nextAttemptAt;
  }
});

test('a poison event reaches a terminal failed state at the attempt limit', async () => {
  const record = event('stream-poison');
  let now = Date.now();
  for (let attempt = 0; attempt < outbox.MAX_ATTEMPTS; attempt += 1) {
    await outbox.deliverPending(() => { throw new Error('poison'); }, { now });
    now = record.nextAttemptAt;
  }
  assert.equal(record.status, 'failed');
  assert.equal(record.attempts, outbox.MAX_ATTEMPTS);
  assert.equal(record.lastError, 'poison');
});

test('a poison event does not block a healthy event in the same batch', async () => {
  event('poison');
  event('healthy');
  const result = await outbox.deliverPending((item) => {
    if (item.key === 'poison') throw new Error('bad');
  });
  assert.equal(result.delivered.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(store.outbox.get('healthy').status, 'delivered');
  assert.equal(store.outbox.get('poison').status, 'pending');
});

test('delivery limit bounds the number of events claimed per run', async () => {
  for (let i = 0; i < 5; i += 1) event(`stream-${i}`);
  const result = await outbox.deliverPending(async () => {}, { limit: 2 });
  assert.equal(result.delivered.length, 2);
  assert.equal(outbox.list({ status: 'pending' }).length, 3);
});

test('outbox list filters status without changing record state', () => {
  event('pending');
  event('pending-2');
  assert.equal(outbox.list({ status: 'pending' }).length, 2);
  assert.equal(outbox.list({ status: 'delivered' }).length, 0);
});

test('payloads are cloned so producer mutation cannot alter the event', () => {
  const payload = { nested: { value: 1 } };
  const record = outbox.enqueue({ key: 'stream-copy', type: 'copy', aggregateId: 'stream-copy', payload });
  payload.nested.value = 2;
  assert.equal(record.payload.nested.value, 1);
});
