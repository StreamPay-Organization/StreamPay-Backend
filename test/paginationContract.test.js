'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const streamService = require('../src/services/streamService');
const analyticsService = require('../src/services/analyticsService');
const { PAGINATION } = require('../src/constants/pagination');

function makeStream(id, createdAt, overrides = {}) {
  return {
    id,
    sender: overrides.sender || 'sender-a',
    recipient: overrides.recipient || 'recipient-a',
    total: 100,
    asset: 'XLM',
    startTime: createdAt,
    endTime: createdAt + 100,
    status: overrides.status || 'active',
    withdrawn: 0,
    createdAt,
    updatedAt: createdAt,
    txHashes: {},
  };
}

test.beforeEach(() => store.clear());

test('pagination constants enforce a finite operational budget', () => {
  assert.equal(PAGINATION.DEFAULT_LIMIT, 50);
  assert.equal(PAGINATION.MAX_LIMIT, 200);
  assert.equal(PAGINATION.MIN_LIMIT, 1);
  assert.ok(PAGINATION.MAX_WINDOW_SECONDS > 0);
  assert.ok(PAGINATION.MAX_ANALYTICS_STREAMS > 0);
  assert.ok(Object.isFrozen(PAGINATION));
});

test('stream list ordering is deterministic when timestamps tie', () => {
  store.insertStream(makeStream('stream_b', 10));
  store.insertStream(makeStream('stream_a', 10));
  const result = streamService.listStreams({ limit: 10 });
  assert.deepEqual(result.streams.map((stream) => stream.id), ['stream_b', 'stream_a']);
});

test('sender, recipient, status and time filters compose before pagination', () => {
  store.insertStream(makeStream('a', 10, { sender: 's1', recipient: 'r1', status: 'active' }));
  store.insertStream(makeStream('b', 20, { sender: 's1', recipient: 'r2', status: 'completed' }));
  store.insertStream(makeStream('c', 30, { sender: 's2', recipient: 'r1', status: 'active' }));
  const result = streamService.listStreams({ sender: 's1', recipient: 'r1', status: 'active', from: 5, to: 15, limit: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.streams[0].id, 'a');
});

test('offset pagination remains backward compatible', () => {
  for (let i = 1; i <= 5; i += 1) store.insertStream(makeStream(`stream_${i}`, i));
  const result = streamService.listStreams({ limit: 2, offset: 2 });
  assert.equal(result.offset, 2);
  assert.deepEqual(result.streams.map((stream) => stream.id), ['stream_3', 'stream_2']);
  assert.ok(result.nextCursor);
});

test('cursor pagination ignores offset once a cursor is supplied', () => {
  for (let i = 1; i <= 5; i += 1) store.insertStream(makeStream(`stream_${i}`, i));
  const first = streamService.listStreams({ limit: 2 });
  const second = streamService.listStreams({ limit: 2, offset: 100, cursor: first.nextCursor });
  assert.equal(second.offset, 0);
  assert.equal(second.streams.length, 2);
});

test('cursor pagination reaches every record exactly once', () => {
  for (let i = 1; i <= 9; i += 1) store.insertStream(makeStream(`stream_${i}`, i));
  const seen = [];
  let page = streamService.listStreams({ limit: 3 });
  seen.push(...page.streams.map((stream) => stream.id));
  while (page.nextCursor) {
    page = streamService.listStreams({ limit: 3, cursor: page.nextCursor });
    seen.push(...page.streams.map((stream) => stream.id));
  }
  assert.equal(seen.length, 9);
  assert.equal(new Set(seen).size, 9);
});

test('malformed cursors fail with a client error', () => {
  assert.throws(() => streamService.listStreams({ cursor: 'not-a-cursor' }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, 'BAD_REQUEST');
    return true;
  });
});

test('time filters do not mutate stored streams', () => {
  const original = makeStream('stream_1', 100);
  store.insertStream(original);
  streamService.listStreams({ from: 50, to: 150 });
  assert.deepEqual(store.getStream('stream_1'), original);
});

test('analytics defaults to the configured maximum window and count', () => {
  const result = analyticsService.overview();
  assert.equal(result.windowSeconds, PAGINATION.MAX_WINDOW_SECONDS);
  assert.equal(result.maxStreams, PAGINATION.MAX_ANALYTICS_STREAMS);
});

test('analytics caps oversized windows and counts', () => {
  const result = analyticsService.overview({ windowSeconds: 999999999, maxStreams: 999999999 });
  assert.equal(result.windowSeconds, PAGINATION.MAX_WINDOW_SECONDS);
  assert.equal(result.maxStreams, PAGINATION.MAX_ANALYTICS_STREAMS);
});

test('analytics ignores non-positive and malformed bounds safely', () => {
  const result = analyticsService.overview({ windowSeconds: -1, maxStreams: 'nope' });
  assert.equal(result.windowSeconds, PAGINATION.MAX_WINDOW_SECONDS);
  assert.equal(result.maxStreams, PAGINATION.MAX_ANALYTICS_STREAMS);
});

test('analytics sorts before applying the max stream budget', () => {
  store.insertStream(makeStream('old', 1));
  store.insertStream(makeStream('new', Math.floor(Date.now() / 1000)));
  const result = analyticsService.overview({ windowSeconds: PAGINATION.MAX_WINDOW_SECONDS, maxStreams: 1 });
  assert.equal(result.streams, 1);
});
