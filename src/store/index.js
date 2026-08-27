'use strict';

/**
 * In-memory data store. A single process-wide singleton holding all streams
 * keyed by id. Swapping this out for a real database would only require
 * reimplementing these methods.
 */
const streams = new Map();
const outbox = new Map();
const deliveredEvents = new Map();

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
  },

  /**
   * Number of stored streams.
   */
  size() {
    return streams.size;
  },

  outbox,
  deliveredEvents,
};

module.exports = store;
