'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/store');
const streamService = require('../src/services/streamService');
const analyticsService = require('../src/services/analyticsService');

function stream(id, createdAt) {
  return {
    id,
    sender: 'sender',
    recipient: 'recipient',
    total: 100,
    asset: 'XLM',
    startTime: createdAt,
    endTime: createdAt + 100,
    status: 'active',
    withdrawn: 0,
    createdAt,
    updatedAt: createdAt,
    txHashes: {},
  };
}

test('cursor pagination keeps a snapshot stable when newer streams are inserted', () => {
  store.clear();
  [1, 2, 3, 4, 5].forEach((time) => store.insertStream(stream(`stream_${time}`, time)));

  const first = streamService.listStreams({ limit: 2 });
  assert.equal(first.streams.length, 2);
  assert.ok(first.nextCursor);

  store.insertStream(stream('stream_new', 99));
  const second = streamService.listStreams({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.streams.map((item) => item.id), ['stream_3', 'stream_2']);
});

test('analytics bounds both the time window and number of streams', () => {
  store.clear();
  [1, 2, 3, 4].forEach((time) => store.insertStream(stream(`stream_${time}`, time)));

  const result = analyticsService.overview({ windowSeconds: 1, maxStreams: 1 });
  assert.equal(result.windowSeconds, 1);
  assert.equal(result.maxStreams, 1);
  assert.ok(result.streams <= 1);
});
