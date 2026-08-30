'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const streamService = require('../src/services/streamService');
const stellarService = require('../src/services/stellarService');
const ApiError = require('../src/utils/ApiError');
const { STREAM_STATUS } = require('../src/constants/streamStatus');

function seedStream(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const stream = {
    id: `stream_concurrency_${Math.random().toString(16).slice(2)}`,
    sender: 'GALICE0000000000000000000000000000000000000000000000',
    recipient: 'GBOB00000000000000000000000000000000000000000000000',
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTx(name) {
  return { txHash: `tx_${name}`, network: 'test', asset: 'XLM' };
}

test('two concurrent full withdrawals release funds exactly once', async (t) => {
  t.after(() => store.clear());
  const stream = seedStream();
  const originalRelease = stellarService.releaseFunds;
  let providerCalls = 0;
  const providerGate = deferred();
  stellarService.releaseFunds = async (input) => {
    providerCalls += 1;
    assert.equal(input.amount, 1000);
    await providerGate.promise;
    return fakeTx(`withdraw_${providerCalls}`);
  };

  const first = streamService.withdraw(stream.id);
  const second = streamService.withdraw(stream.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 1, 'the second request must wait before provider release');
  providerGate.resolve();

  const results = await Promise.allSettled([first, second]);
  stellarService.releaseFunds = originalRelease;
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(results[1].reason instanceof ApiError, true);
  assert.equal(results[1].reason.statusCode, 409);
  assert.equal(providerCalls, 1);
  assert.equal(store.getStream(stream.id).withdrawn, 1000);
  assert.equal(store.getStream(stream.id).status, STREAM_STATUS.COMPLETED);
  assert.equal(store.getStream(stream.id).version, 2);
});

test('concurrent withdrawal and cancellation serialize valid transitions', async (t) => {
  t.after(() => store.clear());
  const now = Math.floor(Date.now() / 1000);
  const stream = seedStream({ startTime: now - 50, endTime: now + 50 });
  const originalRelease = stellarService.releaseFunds;
  const originalRefund = stellarService.refundFunds;
  const calls = [];
  stellarService.releaseFunds = async ({ amount }) => {
    calls.push(['withdraw', amount]);
    return fakeTx('withdraw-race');
  };
  stellarService.refundFunds = async ({ amount }) => {
    calls.push(['refund', amount]);
    return fakeTx('refund-race');
  };

  const results = await Promise.allSettled([
    streamService.withdraw(stream.id, 100),
    streamService.cancel(stream.id),
  ]);
  stellarService.releaseFunds = originalRelease;
  stellarService.refundFunds = originalRefund;

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0);
  assert.equal(calls.length, 2, 'each valid serialized transition has one provider call');
  const stored = store.getStream(stream.id);
  assert.equal(stored.version, 3);
  assert.equal(stored.status, STREAM_STATUS.CANCELLED);
  assert.equal(stored.withdrawn, 100);
});

test('queued cancellation sees a completed withdrawal instead of refunding again', async (t) => {
  t.after(() => store.clear());
  const stream = seedStream();
  const originalRelease = stellarService.releaseFunds;
  const originalRefund = stellarService.refundFunds;
  let refundCalls = 0;
  stellarService.releaseFunds = async () => fakeTx('withdraw-first');
  stellarService.refundFunds = async () => {
    refundCalls += 1;
    return fakeTx('unexpected-refund');
  };

  const withdrawal = streamService.withdraw(stream.id);
  const cancellation = streamService.cancel(stream.id);
  await withdrawal;
  const result = await Promise.allSettled([cancellation]);
  stellarService.releaseFunds = originalRelease;
  stellarService.refundFunds = originalRefund;

  assert.equal(result[0].status, 'rejected');
  assert.equal(result[0].reason.statusCode, 409);
  assert.equal(refundCalls, 0);
  assert.equal(store.getStream(stream.id).status, STREAM_STATUS.COMPLETED);
  assert.equal(store.getStream(stream.id).version, 2);
});

test('queued withdrawal sees cancellation and cannot release refunded funds', async (t) => {
  t.after(() => store.clear());
  const now = Math.floor(Date.now() / 1000);
  const stream = seedStream({ startTime: now - 10, endTime: now + 1000 });
  const originalRelease = stellarService.releaseFunds;
  const originalRefund = stellarService.refundFunds;
  let releaseCalls = 0;
  stellarService.releaseFunds = async () => {
    releaseCalls += 1;
    return fakeTx('unexpected-release');
  };
  stellarService.refundFunds = async () => fakeTx('cancel-first');

  const cancellation = streamService.cancel(stream.id);
  const withdrawal = streamService.withdraw(stream.id, 1);
  await cancellation;
  const result = await Promise.allSettled([withdrawal]);
  stellarService.releaseFunds = originalRelease;
  stellarService.refundFunds = originalRefund;

  assert.equal(result[0].status, 'rejected');
  assert.equal(result[0].reason.statusCode, 409);
  assert.equal(releaseCalls, 0);
  assert.equal(store.getStream(stream.id).status, STREAM_STATUS.CANCELLED);
  assert.equal(store.getStream(stream.id).version, 2);
});

test('provider failure leaves state unchanged and releases the lock', async (t) => {
  t.after(() => store.clear());
  const stream = seedStream();
  const originalRelease = stellarService.releaseFunds;
  let calls = 0;
  stellarService.releaseFunds = async () => {
    calls += 1;
    if (calls === 1) throw new Error('provider unavailable');
    return fakeTx('retry-success');
  };

  await assert.rejects(streamService.withdraw(stream.id), /provider unavailable/);
  assert.equal(store.getStream(stream.id).withdrawn, 0);
  assert.equal(store.getStream(stream.id).version, undefined);
  const retry = await streamService.withdraw(stream.id);
  stellarService.releaseFunds = originalRelease;

  assert.equal(retry.amount, 1000);
  assert.equal(store.getStream(stream.id).withdrawn, 1000);
  assert.equal(store.getStream(stream.id).version, 2);
  assert.equal(calls, 2);
});

test('provider failure in cancellation does not consume the transition', async (t) => {
  t.after(() => store.clear());
  const stream = seedStream();
  const originalRefund = stellarService.refundFunds;
  let calls = 0;
  stellarService.refundFunds = async () => {
    calls += 1;
    if (calls === 1) throw new Error('refund provider unavailable');
    return fakeTx('retry-refund');
  };

  await assert.rejects(streamService.cancel(stream.id), /refund provider unavailable/);
  assert.equal(store.getStream(stream.id).status, STREAM_STATUS.ACTIVE);
  assert.equal(store.getStream(stream.id).version, undefined);
  const retry = await streamService.cancel(stream.id);
  stellarService.refundFunds = originalRefund;

  assert.equal(retry.stream.status, STREAM_STATUS.CANCELLED);
  assert.equal(store.getStream(stream.id).version, 2);
  assert.equal(calls, 2);
});

test('compare-and-swap rejects a stale writer without overwriting newer state', (t) => {
  t.after(() => store.clear());
  const stream = seedStream({ version: 4, withdrawn: 10 });
  const stale = { ...stream, withdrawn: 900, status: STREAM_STATUS.ACTIVE };
  const updated = store.updateStreamIfVersion(stream.id, 4, { ...stream, withdrawn: 20 });
  assert.equal(updated.version, 5);
  assert.equal(store.updateStreamIfVersion(stream.id, 4, stale), false);
  assert.equal(store.getStream(stream.id).withdrawn, 20);
  assert.equal(store.getStream(stream.id).version, 5);
});

test('different streams do not block one another', async (t) => {
  t.after(() => store.clear());
  const first = seedStream({ id: 'stream_parallel_a' });
  const second = seedStream({ id: 'stream_parallel_b' });
  const originalRelease = stellarService.releaseFunds;
  const gates = [deferred(), deferred()];
  let calls = 0;
  stellarService.releaseFunds = async () => {
    const gate = gates[calls];
    calls += 1;
    await gate.promise;
    return fakeTx(`parallel-${calls}`);
  };

  const firstWithdrawal = streamService.withdraw(first.id);
  const secondWithdrawal = streamService.withdraw(second.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  gates[0].resolve();
  gates[1].resolve();
  await Promise.all([firstWithdrawal, secondWithdrawal]);
  stellarService.releaseFunds = originalRelease;

  assert.equal(store.getStream(first.id).version, 2);
  assert.equal(store.getStream(second.id).version, 2);
});

test('new stream views expose version one and transition to version two', async (t) => {
  t.after(() => store.clear());
  const originalLock = stellarService.lockFunds;
  const originalRelease = stellarService.releaseFunds;
  stellarService.lockFunds = async () => fakeTx('lock-versioned');
  stellarService.releaseFunds = async () => fakeTx('withdraw-versioned');

  const created = await streamService.createStream({
    sender: 'sender-versioned',
    recipient: 'recipient-versioned',
    total: 1000,
    endTime: Math.floor(Date.now() / 1000) - 100,
  });
  assert.equal(created.version, 1);
  const result = await streamService.withdraw(created.id);
  stellarService.lockFunds = originalLock;
  stellarService.releaseFunds = originalRelease;

  assert.equal(result.stream.version, 2);
  assert.equal(store.getStream(created.id).version, 2);
});

test('lock cleanup permits a later transition after an error', async (t) => {
  t.after(() => store.clear());
  const stream = seedStream();
  const originalRefund = stellarService.refundFunds;
  stellarService.refundFunds = async () => { throw new Error('one-shot failure'); };
  await assert.rejects(streamService.cancel(stream.id));
  stellarService.refundFunds = async () => fakeTx('later-success');
  const result = await streamService.cancel(stream.id);
  stellarService.refundFunds = originalRefund;

  assert.equal(result.stream.status, STREAM_STATUS.CANCELLED);
  assert.equal(store.getStream(stream.id).version, 2);
});
