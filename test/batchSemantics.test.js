'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const streamService = require('../src/services/streamService');
const stellarService = require('../src/services/stellarService');
const { validateBatchUpdate } = require('../src/validators/streamValidators');
const { STREAM_STATUS } = require('../src/constants/streamStatus');

const SENDER = 'GALICE0000000000000000000000000000000000000000000000';
const RECIPIENT_PREFIX = 'GBOB000000000000000000000000000000000000000000000';

function seedStream(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const stream = {
    id: `stream_${Math.random().toString(16).slice(2)}`,
    sender: SENDER,
    recipient: `${RECIPIENT_PREFIX}${Math.random().toString(16).slice(2, 7)}`,
    total: 1000,
    asset: 'XLM',
    startTime: now - 200,
    endTime: now - 100,
    status: STREAM_STATUS.ACTIVE,
    withdrawn: 0,
    createdAt: now - 200,
    updatedAt: now - 200,
    txHashes: { lock: 'tx_seed' },
    ...overrides,
  };
  store.insertStream(stream);
  return stream;
}

function installProvider({ releaseFunds, refundFunds } = {}) {
  const originals = {
    releaseFunds: stellarService.releaseFunds,
    refundFunds: stellarService.refundFunds,
  };
  if (releaseFunds) stellarService.releaseFunds = releaseFunds;
  if (refundFunds) stellarService.refundFunds = refundFunds;
  return () => {
    stellarService.releaseFunds = originals.releaseFunds;
    stellarService.refundFunds = originals.refundFunds;
  };
}

function tx(name) {
  return { txHash: `tx_${name}`, network: 'test', asset: 'XLM' };
}

test('returns a deterministic partial contract and preserves input order', async (t) => {
  t.after(() => store.clear());
  const restore = installProvider({
    releaseFunds: async ({ recipient }) => tx(recipient.slice(-3)),
    refundFunds: async () => tx('refund'),
  });
  t.after(restore);

  const first = seedStream();
  const second = seedStream();
  const result = await streamService.batchUpdate([
    { id: first.id, action: 'withdraw', amount: 125 },
    { id: 'stream_missing', action: 'cancel' },
    { id: second.id, action: 'cancel' },
  ], { idempotencyKey: 'batch-order-1' });

  assert.equal(result.atomicity, 'partial');
  assert.match(result.operationId, /^batch_[0-9a-f-]+$/);
  assert.equal(result.correlationId, result.operationId);
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results.map((item) => item.index), [0, 1, 2]);
  assert.deepEqual(result.results.map((item) => item.itemCorrelationId), [
    `${result.operationId}:item:1`,
    `${result.operationId}:item:2`,
    `${result.operationId}:item:3`,
  ]);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].error.code, 'NOT_FOUND');
  assert.equal(result.results[2].ok, true);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.retryableFailures, 1);
});

test('does not repeat successful items when the same key is replayed', async (t) => {
  t.after(() => store.clear());
  let releases = 0;
  const restore = installProvider({
    releaseFunds: async () => {
      releases += 1;
      return tx(`release-${releases}`);
    },
  });
  t.after(restore);

  const first = seedStream();
  const second = seedStream();
  const updates = [
    { id: first.id, action: 'withdraw' },
    { id: second.id, action: 'withdraw' },
  ];
  const initial = await streamService.batchUpdate(updates, { idempotencyKey: 'batch-replay-1' });
  const replay = await streamService.batchUpdate(updates, { idempotencyKey: 'batch-replay-1' });

  assert.equal(releases, 2);
  assert.equal(initial.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.operationId, initial.operationId);
  assert.deepEqual(replay.results, initial.results);
  assert.equal(store.getStream(first.id).withdrawn, 1000);
  assert.equal(store.getStream(second.id).withdrawn, 1000);
});

test('retries failed items while retaining successful item outcomes', async (t) => {
  t.after(() => store.clear());
  const successful = seedStream();
  const retryable = seedStream();
  let successfulCalls = 0;
  let retryableCalls = 0;
  const restore = installProvider({
    releaseFunds: async ({ recipient }) => {
      if (recipient === retryable.recipient) {
        retryableCalls += 1;
        if (retryableCalls === 1) throw new Error('provider temporarily unavailable');
      } else {
        successfulCalls += 1;
      }
      return tx(`release-${successfulCalls}-${retryableCalls}`);
    },
  });
  t.after(restore);

  const updates = [
    { id: successful.id, action: 'withdraw' },
    { id: retryable.id, action: 'withdraw' },
  ];
  const first = await streamService.batchUpdate(updates, { idempotencyKey: 'batch-resume-1' });
  assert.equal(first.succeeded, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.results[1].error.code, 'INTERNAL_ERROR');
  assert.equal(store.getStream(successful.id).withdrawn, 1000);
  assert.equal(store.getStream(retryable.id).withdrawn, 0);

  const retry = await streamService.batchUpdate(updates, { idempotencyKey: 'batch-resume-1' });
  assert.equal(retry.succeeded, 2);
  assert.equal(retry.failed, 0);
  assert.equal(retry.replayed, false);
  assert.equal(successfulCalls, 1, 'the previously successful item is not submitted again');
  assert.equal(retryableCalls, 2, 'the failed item receives one retry');
  assert.equal(store.getStream(retryable.id).withdrawn, 1000);
});

test('rejects reuse of a key with a different normalized request', async (t) => {
  t.after(() => store.clear());
  const restore = installProvider({ releaseFunds: async () => tx('release') });
  t.after(restore);
  const stream = seedStream();
  const key = 'batch-fingerprint-1';

  await streamService.batchUpdate([{ id: stream.id, action: 'withdraw', amount: 100 }], {
    idempotencyKey: key,
  });
  await assert.rejects(
    () => streamService.batchUpdate([{ id: stream.id, action: 'withdraw', amount: 200 }], {
      idempotencyKey: key,
    }),
    (error) => error.statusCode === 409 && error.code === 'CONFLICT'
  );
  assert.equal(store.getStream(stream.id).withdrawn, 100);
});

test('serializes concurrent requests with the same idempotency key', async (t) => {
  t.after(() => store.clear());
  const stream = seedStream();
  let calls = 0;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => { releaseProvider = resolve; });
  let continueProvider;
  const providerGate = new Promise((resolve) => { continueProvider = resolve; });
  const restore = installProvider({
    releaseFunds: async () => {
      calls += 1;
      releaseProvider();
      await providerGate;
      return tx('concurrent');
    },
  });
  t.after(restore);

  const updates = [{ id: stream.id, action: 'withdraw' }];
  const firstPromise = streamService.batchUpdate(updates, { idempotencyKey: 'batch-concurrent-1' });
  await providerStarted;
  const secondPromise = streamService.batchUpdate(updates, { idempotencyKey: 'batch-concurrent-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'the second request waits for the first operation record');
  continueProvider();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(calls, 1);
  assert.equal(first.operationId, second.operationId);
  assert.equal(second.replayed, true);
  assert.equal(store.getStream(stream.id).withdrawn, 1000);
});

test('keeps prior successes when a later item fails; no batch rollback is implied', async (t) => {
  t.after(() => store.clear());
  const first = seedStream();
  const second = seedStream();
  let refundCalls = 0;
  const restore = installProvider({
    releaseFunds: async () => tx('release'),
    refundFunds: async () => {
      refundCalls += 1;
      if (refundCalls === 2) throw new Error('refund unavailable');
      return tx('refund');
    },
  });
  t.after(restore);

  const result = await streamService.batchUpdate([
    { id: first.id, action: 'cancel' },
    { id: second.id, action: 'cancel' },
  ]);

  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(store.getStream(first.id).status, STREAM_STATUS.CANCELLED);
  assert.equal(store.getStream(second.id).status, STREAM_STATUS.ACTIVE);
  assert.equal(result.results[1].error.code, 'INTERNAL_ERROR');
});

test('validator rejects duplicate IDs before any item can be applied', () => {
  const result = validateBatchUpdate({
    updates: [
      { id: 'stream_same', action: 'cancel' },
      { id: 'stream_same', action: 'withdraw' },
    ],
  });
  assert.deepEqual(result.value, undefined);
  assert.equal(result.error.length, 1);
  assert.match(result.error[0], /duplicated in this batch/);
});

test('rejects overlong idempotency keys before provider work begins', async (t) => {
  t.after(() => store.clear());
  let calls = 0;
  const restore = installProvider({
    releaseFunds: async () => {
      calls += 1;
      return tx('release');
    },
  });
  t.after(restore);
  const stream = seedStream();

  await assert.rejects(
    () => streamService.batchUpdate([{ id: stream.id, action: 'withdraw' }], {
      idempotencyKey: 'x'.repeat(129),
    }),
    (error) => error.statusCode === 400 && error.code === 'BAD_REQUEST'
  );
  assert.equal(calls, 0);
});
