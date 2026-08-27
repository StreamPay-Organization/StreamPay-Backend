'use strict';

const store = require('../store');
const stellarService = require('./stellarService');
const streamMath = require('./streamMath');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { newStreamId } = require('../utils/ids');
const { nowSeconds } = require('../utils/time');
const money = require('../utils/money');
const { STREAM_STATUS } = require('../constants/streamStatus');
const { PAGINATION } = require('../constants/pagination');

/**
 * Build the public-facing view of a stream, enriching the stored record with
 * computed amounts at the given time.
 */
function toView(stream, atTime) {
  const at = atTime || nowSeconds();
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

  logger.info('stream cancelled', { id: stream.id, refund });
  return { stream: toView(stream, now), refunded: refund, txHash: refundTx.txHash };
}

/**
 * Apply a batch of withdraw/cancel actions in a single request. Each item is
 * applied independently and best-effort: one item failing (e.g. a stream not
 * found, or nothing withdrawable) does not stop the rest of the batch from
 * being applied. The per-item outcome is reported back so callers can tell
 * exactly which updates succeeded and which didn't, rather than getting a
 * single pass/fail for the whole request.
 */
async function batchUpdate(updates) {
  const results = [];

  for (const item of updates) {
    try {
      const outcome =
        item.action === 'withdraw'
          ? await withdraw(item.id, item.amount)
          : await cancel(item.id);

      results.push({ id: item.id, action: item.action, ok: true, ...outcome });
    } catch (err) {
      const statusCode = err instanceof ApiError ? err.statusCode : 500;
      const code = err instanceof ApiError ? err.code : ApiError.codeFor(statusCode);
      results.push({
        id: item.id,
        action: item.action,
        ok: false,
        error: { message: err.message, code, statusCode },
      });
    }
  }

  return {
    results,
    count: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
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
};
