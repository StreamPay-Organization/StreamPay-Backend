'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Generate a unique stream id. Prefixed so ids are self-describing in logs
 * and API responses.
 */
function newStreamId() {
  return `stream_${uuidv4()}`;
}

/**
 * Generate a mock on-chain transaction hash. Stands in for a real Stellar
 * transaction hash returned by the (mocked) network layer.
 */
function newTxHash() {
  return `tx_${uuidv4().replace(/-/g, '')}`;
}

/**
 * Generate a correlation id for one batch request. It is separate from a
 * stream id so logs and retries can group several item outcomes safely.
 */
function newBatchOperationId() {
  return `batch_${uuidv4()}`;
}

module.exports = { newStreamId, newTxHash, newBatchOperationId };
