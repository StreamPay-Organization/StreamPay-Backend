'use strict';

/**
 * Bounds for the batch update endpoint. Kept small since each item performs a
 * mock on-chain call; a large batch would just serialize a long queue of
 * network round-trips.
 */
const BATCH = Object.freeze({
  MAX_ITEMS: 25,
  MAX_IDEMPOTENCY_KEY_LENGTH: 128,
  ACTIONS: Object.freeze(['withdraw', 'cancel']),
});

module.exports = { BATCH };
