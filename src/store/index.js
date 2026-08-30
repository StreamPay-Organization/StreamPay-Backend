'use strict';

/**
 * In-memory data store. A single process-wide singleton holding all streams
 * keyed by id. Swapping this out for a real database would only require
 * reimplementing these methods.
 */
const streams = new Map();
const outbox = new Map();
const deliveredEvents = new Map();
const batchOperations = new Map();
const batchLocks = new Map();

const store = {
  /**
   * Insert a stream record.
   */
  insertStream(stream) {
    streams.set(stream.id, stream);
    return stream;
  },

  /**
   * Get a stream by id, or undefined if not present.
   */
  getStream(id) {
    return streams.get(id);
  },

  /**
   * Replace an existing stream record.
   */
  updateStream(stream) {
    streams.set(stream.id, stream);
    return stream;
  },

  /** Return the idempotency record for a batch key, if one exists. */
  getBatchOperation(key) {
    return batchOperations.get(key);
  },

  /** Create an idempotency record. Callers serialize creation with a lock. */
  createBatchOperation({ key, fingerprint, operationId }) {
    const operation = {
      key,
      fingerprint,
      operationId,
      outcomes: new Map(),
      completed: false,
    };
    batchOperations.set(key, operation);
    return operation;
  },

  /** Store one immutable item outcome so successful work is not repeated. */
  saveBatchOutcome(key, index, outcome) {
    const operation = batchOperations.get(key);
    if (!operation) return false;
    operation.outcomes.set(index, JSON.parse(JSON.stringify(outcome)));
    return true;
  },

  /** Serialize concurrent requests that present the same idempotency key. */
  async withBatchLock(key, callback) {
    const previous = batchLocks.get(key) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => turn);
    batchLocks.set(key, queued);

    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (batchLocks.get(key) === queued) batchLocks.delete(key);
    }
  },

  /**
   * Return all streams as an array.
   */
  listStreams() {
    return Array.from(streams.values());
  },

  /**
   * Remove every stream. Primarily used by tests and seeding.
   */
  clear() {
    streams.clear();
    outbox.clear();
    deliveredEvents.clear();
    batchOperations.clear();
    batchLocks.clear();
  },

  /**
   * Number of stored streams.
   */
  size() {
    return streams.size;
  },

  outbox,
  deliveredEvents,
  batchOperations,
};

module.exports = store;
