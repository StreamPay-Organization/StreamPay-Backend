'use strict';

const store = require('../store');
const stellarService = require('./stellarService');
const streamMath = require('./streamMath');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { newStreamId, newBatchOperationId } = require('../utils/ids');
const { nowSeconds } = require('../utils/time');
const money = require('../utils/money');
const { STREAM_STATUS } = require('../constants/streamStatus');
const { PAGINATION } = require('../constants/pagination');
const outboxService = require('./outboxService');
const { BATCH } = require('../constants/batch');

/**
 * Build the public-facing view of a stream, enriching the stored record with
 * computed amounts at the given time.
 */
function toView(stream, atTime) {
  const at = atTime === undefined ? nowSeconds() : atTime;
  return {
    id: stream.id,
    sender: stream.sender,
    recipient: stream.recipient,
    total: stream.total,
    asset: stream.asset,
    startTime: stream.startTime,
    endTime: stream.endTime,
    status: stream.status,
    withdrawn: stream.withdrawn,
    streamed: streamMath.streamedAmount(stream, at),
    withdrawable: streamMath.withdrawableAmount(stream, at),
    locked: streamMath.lockedAmount(stream, at),
    progress: streamMath.progress(stream, at),
    remainingSeconds: streamMath.remainingSeconds(stream, at),
    createdAt: stream.createdAt,
    updatedAt: stream.updatedAt,
    txHashes: stream.txHashes,
  };
}

/**
 * Create and persist a new stream, locking the sender's funds on-chain (mock).
 */
async function createStream(input) {
  const now = nowSeconds();
  const startTime = input.startTime || now;
  const endTime = input.endTime;

  const lock = await stellarService.lockFunds({
    sender: input.sender,
    amount: input.total,
  });

  const stream = {
    id: newStreamId(),
    sender: input.sender,
    recipient: input.recipient,
    total: money.round(input.total),
    asset: lock.asset,
    startTime,
    endTime,
    status: STREAM_STATUS.ACTIVE,
    withdrawn: 0,
    createdAt: now,
    updatedAt: now,
    txHashes: { lock: lock.txHash },
  };

  store.insertStream(stream);
  outboxService.enqueue({
    key: `${stream.id}:created`,
    type: 'stream.created',
    aggregateId: stream.id,
    payload: { streamId: stream.id, sender: stream.sender, recipient: stream.recipient, total: stream.total },
  });
  logger.info('stream created', { id: stream.id, sender: stream.sender });
  return toView(stream, now);
}

/**
 * Fetch a single stream view by id or throw 404.
 */
function getStream(id) {
  const stream = store.getStream(id);
  if (!stream) throw ApiError.notFound(`Stream ${id} not found`);
  return toView(stream);
}

/**
 * Describe a stream's vesting schedule: its window, duration, the per-second
 * release rate and a small set of projected milestones (start, quarter, half,
 * three-quarter, end). Useful for rendering a vesting curve client-side.
 */
function getSchedule(id) {
  const stream = store.getStream(id);
  if (!stream) throw ApiError.notFound(`Stream ${id} not found`);

  const duration = Math.max(0, stream.endTime - stream.startTime);
  const ratePerSecond = duration > 0 ? money.round(stream.total / duration) : 0;
  const milestones = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const time = stream.startTime + Math.round(duration * fraction);
    return {
      fraction,
      time,
      streamed: streamMath.streamedAmount(stream, time),
    };
  });

  return {
    id: stream.id,
    startTime: stream.startTime,
    endTime: stream.endTime,
    durationSeconds: duration,
    total: stream.total,
    ratePerSecond,
    milestones,
  };
}

/**
 * Compute point-in-time statistics for a single stream: streamed/withdrawn/
 * withdrawable/locked amounts plus the share of the total each represents and
 * the seconds remaining. Complements the schedule endpoint with live figures.
 */
function getStats(id) {
  const stream = store.getStream(id);
  if (!stream) throw ApiError.notFound(`Stream ${id} not found`);

  const at = nowSeconds();
  const streamed = streamMath.streamedAmount(stream, at);
  const withdrawable = streamMath.withdrawableAmount(stream, at);
  const locked = streamMath.lockedAmount(stream, at);

  return {
    id: stream.id,
    status: stream.status,
    total: stream.total,
    streamed,
    withdrawn: stream.withdrawn,
    withdrawable,
    locked,
    percentStreamed: money.percent(streamed, stream.total),
    percentWithdrawn: money.percent(stream.withdrawn, stream.total),
    remainingSeconds: streamMath.remainingSeconds(stream, at),
  };
}

/**
 * List streams, optionally filtered by sender, recipient and/or status, with
 * `limit`/`offset` pagination. Returns the page of stream views together with
 * the total number of matches so callers can build pagination controls.
 */
function listStreams(filter = {}) {
  const at = nowSeconds();
  const matched = store
    .listStreams()
    .filter((s) => (filter.sender ? s.sender === filter.sender : true))
    .filter((s) => (filter.recipient ? s.recipient === filter.recipient : true))
    .filter((s) => (filter.status ? s.status === filter.status : true))
    .filter((s) => (filter.from === undefined ? true : s.createdAt >= filter.from))
    .filter((s) => (filter.to === undefined ? true : s.createdAt <= filter.to))
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));

  const limit = clampLimit(filter.limit);
  const decoded = filter.cursor ? decodeCursor(filter.cursor) : null;
  let candidates = matched;
  if (decoded) {
    candidates = candidates.filter((s) => isAtOrBefore(s, decoded.snapshot));
    candidates = candidates.filter((s) => isBefore(s, decoded.after));
  }
  const offset = decoded ? 0 : clampOffset(filter.offset);
  const pageRecords = candidates.slice(offset, offset + limit);
  const page = pageRecords.map((s) => toView(s, at));
  const last = pageRecords[pageRecords.length - 1];
  const snapshot = decoded ? decoded.snapshot : matched[0];
  const hasMore = offset + limit < candidates.length;

  return {
    total: matched.length,
    limit,
    offset,
    streams: page,
    nextCursor: hasMore && last ? encodeCursor({ snapshot, after: last }) : null,
  };
}

function isBefore(stream, boundary) {
  return stream.createdAt < boundary.createdAt ||
    (stream.createdAt === boundary.createdAt && stream.id < boundary.id);
}

function isAtOrBefore(stream, boundary) {
  return stream.createdAt < boundary.createdAt ||
    (stream.createdAt === boundary.createdAt && stream.id <= boundary.id);
}

function encodeCursor({ snapshot, after }) {
  return Buffer.from(JSON.stringify({
    snapshot: { createdAt: snapshot.createdAt, id: snapshot.id },
    after: { createdAt: after.createdAt, id: after.id },
  })).toString('base64url');
}

function decodeCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded.snapshot || !decoded.after ||
        !Number.isFinite(decoded.snapshot.createdAt) ||
        !Number.isFinite(decoded.after.createdAt) ||
        typeof decoded.snapshot.id !== 'string' || typeof decoded.after.id !== 'string') {
      throw new Error('invalid shape');
    }
    return decoded;
  } catch (_error) {
    throw ApiError.badRequest('Invalid pagination cursor');
  }
}

/**
 * Normalize a requested page size into [MIN_LIMIT, MAX_LIMIT], defaulting when
 * absent.
 */
function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return PAGINATION.DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(n), PAGINATION.MIN_LIMIT), PAGINATION.MAX_LIMIT);
}

/**
 * Normalize a requested offset into a non-negative integer.
 */
function clampOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Release the streamed-so-far amount to the recipient.
 */
async function withdraw(id, requestedAmount) {
  const stream = store.getStream(id);
  if (!stream) throw ApiError.notFound(`Stream ${id} not found`);

  const now = nowSeconds();
  const available = streamMath.withdrawableAmount(stream, now);
  if (available <= 0) {
    throw ApiError.badRequest('Nothing available to withdraw');
  }

  // Allow partial withdrawals; default to the full available amount.
  const amount = requestedAmount ? money.round(requestedAmount) : available;
  if (amount > available) {
    throw ApiError.badRequest(
      `Requested ${amount} exceeds withdrawable ${available}`
    );
  }

  const release = await stellarService.releaseFunds({
    recipient: stream.recipient,
    amount,
  });

  stream.withdrawn = money.round(stream.withdrawn + amount);
  stream.updatedAt = now;
  stream.txHashes = { ...stream.txHashes, lastWithdraw: release.txHash };
  if (stream.withdrawn >= stream.total && stream.status === STREAM_STATUS.ACTIVE) {
    stream.status = STREAM_STATUS.COMPLETED;
  }
  store.updateStream(stream);
  outboxService.enqueue({
    key: `${stream.id}:withdraw:${release.txHash}`,
    type: 'stream.withdrawn',
    aggregateId: stream.id,
    payload: { streamId: stream.id, amount, withdrawn: stream.withdrawn, txHash: release.txHash },
  });

  logger.info('stream withdraw', { id: stream.id, amount });
  return { stream: toView(stream, now), amount, txHash: release.txHash };
}

/**
 * Cancel a stream: recipient keeps what streamed, sender reclaims the rest.
 */
async function cancel(id) {
  const stream = store.getStream(id);
  if (!stream) throw ApiError.notFound(`Stream ${id} not found`);
  if (stream.status === STREAM_STATUS.CANCELLED) {
    throw ApiError.conflict('Stream already cancelled');
  }
  if (stream.status === STREAM_STATUS.COMPLETED) {
    throw ApiError.conflict('Stream already completed');
  }

  const now = nowSeconds();
  const refund = streamMath.lockedAmount(stream, now);

  const refundTx = await stellarService.refundFunds({
    sender: stream.sender,
    amount: refund,
  });

  stream.status = STREAM_STATUS.CANCELLED;
  stream.updatedAt = now;
  stream.txHashes = { ...stream.txHashes, refund: refundTx.txHash };
  store.updateStream(stream);
  outboxService.enqueue({
    key: `${stream.id}:cancelled`,
    type: 'stream.cancelled',
    aggregateId: stream.id,
    payload: { streamId: stream.id, refunded: refund, txHash: refundTx.txHash },
  });

  logger.info('stream cancelled', { id: stream.id, refund });
  return { stream: toView(stream, now), refunded: refund, txHash: refundTx.txHash };
}

/**
 * Helpers for the batch contract. Batches are partial-commit operations: items
 * run in request order, each gets a stable correlation id, and one item error
 * does not roll back earlier successful items.
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw ApiError.badRequest('Idempotency-Key must be a string');
  }
  const key = value.trim();
  if (!key) return null;
  if (key.length > BATCH.MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw ApiError.badRequest(
      `Idempotency-Key must not exceed ${BATCH.MAX_IDEMPOTENCY_KEY_LENGTH} characters`
    );
  }
  return key;
}

function batchFingerprint(updates) {
  return JSON.stringify(updates);
}

function itemCorrelationId(operation, index) {
  return `${operation.operationId}:item:${index + 1}`;
}

async function executeBatch(operation, updates, replayable) {
  const results = [];
  let replayed = replayable;

  for (const [index, item] of updates.entries()) {
    const previous = operation.outcomes.get(index);
    if (previous && previous.ok) {
      results.push(clone(previous));
      continue;
    }
    replayed = false;

    let outcome;
    try {
      const transition =
        item.action === 'withdraw'
          ? await withdraw(item.id, item.amount)
          : await cancel(item.id);

      outcome = {
        index,
        itemCorrelationId: itemCorrelationId(operation, index),
        id: item.id,
        action: item.action,
        ok: true,
        ...transition,
      };
    } catch (err) {
      const statusCode = err instanceof ApiError ? err.statusCode : 500;
      const code = err instanceof ApiError ? err.code : ApiError.codeFor(statusCode);
      outcome = {
        index,
        itemCorrelationId: itemCorrelationId(operation, index),
        id: item.id,
        action: item.action,
        ok: false,
        error: { message: err.message, code, statusCode },
      };
    }
    if (operation.key) {
      store.saveBatchOutcome(operation.key, index, outcome);
    } else {
      operation.outcomes.set(index, clone(outcome));
    }
    results.push(outcome);
  }

  const failed = results.filter((r) => !r.ok).length;
  operation.completed = failed === 0;
  return {
    operationId: operation.operationId,
    correlationId: operation.operationId,
    atomicity: 'partial',
    replayed,
    results,
    count: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed,
    retryableFailures: failed,
  };
}

/**
 * Apply a batch in input order under an explicit partial-commit contract.
 * Successful outcomes are cached by Idempotency-Key; a retry resumes only
 * failed items, so an already committed item is never submitted twice.
 */
async function batchUpdate(updates, { idempotencyKey } = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const fingerprint = batchFingerprint(updates);

  if (!key) {
    const operation = {
      key: null,
      fingerprint,
      operationId: newBatchOperationId(),
      outcomes: new Map(),
      completed: false,
    };
    return executeBatch(operation, updates, false);
  }

  return store.withBatchLock(key, async () => {
    const existing = store.getBatchOperation(key);
    if (existing && existing.fingerprint !== fingerprint) {
      throw ApiError.conflict('Idempotency-Key was reused with a different batch');
    }
    const operation = existing || store.createBatchOperation({
      key,
      fingerprint,
      operationId: newBatchOperationId(),
    });
    return executeBatch(operation, updates, Boolean(existing));
  });
}

module.exports = {
  toView,
  createStream,
  getStream,
  getSchedule,
  getStats,
  listStreams,
  encodeCursor,
  withdraw,
  cancel,
  batchUpdate,
  normalizeIdempotencyKey,
};
