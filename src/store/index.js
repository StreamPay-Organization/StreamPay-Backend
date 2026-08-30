'use strict';

/**
 * In-memory data store. A single process-wide singleton holding all streams
 * keyed by id. Swapping this out for a real database would only require
 * reimplementing these methods.
 */
const streams = new Map();
const outbox = new Map();
const deliveredEvents = new Map();
const streamLocks = new Map();

function streamVersion(stream) {
  return Number.isInteger(stream && stream.version) && stream.version > 0
    ? stream.version
    : 1;
}

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

  /**
   * Replace a stream only when its caller observed the current version.
   * Returning false gives services a stable conflict path instead of allowing
   * a stale transition to overwrite a newer balance-affecting transition.
   */
  updateStreamIfVersion(id, expectedVersion, stream) {
    const current = streams.get(id);
    if (!current || streamVersion(current) !== expectedVersion) return false;
    const updated = { ...stream, version: expectedVersion + 1 };
    streams.set(id, updated);
    return updated;
  },

  /**
   * Serialize all balance-affecting transitions for one stream. The callback
   * may await the network/provider; the next callback starts only after it
   * releases this stream's turn.
   */
  async withStreamLock(id, callback) {
    const previous = streamLocks.get(id) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => turn);
    streamLocks.set(id, queued);

    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (streamLocks.get(id) === queued) streamLocks.delete(id);
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
    streamLocks.clear();
  },

  /**
   * Number of stored streams.
   */
  size() {
    return streams.size;
  },

  outbox,
  deliveredEvents,
  streamVersion,
};

module.exports = store;
