'use strict';

const { clamp } = require('../utils/time');
const money = require('../utils/money');
const { STREAM_STATUS } = require('../constants/streamStatus');

const UNIT_FACTOR = 10 ** money.DECIMALS;

/**
 * Convert an amount into the smallest supported asset unit. Keeping the
 * interpolation in integer units prevents a rounded midpoint from moving
 * backwards when adjacent timestamps are projected.
 */
function amountToUnits(amount) {
  const normalized = Number.isFinite(amount) ? money.round(amount) : 0;
  return Math.max(0, Math.round(normalized * UNIT_FACTOR));
}

function unitsToAmount(units) {
  return units / UNIT_FACTOR;
}

/**
 * A bad clock reading must not turn a balance into NaN. Treat unknown finite
 * context as the beginning of the stream; infinities are explicit sentinel
 * readings and map to the corresponding boundary.
 */
function safeTime(atTime, startTime, endTime) {
  if (atTime === Infinity) return endTime;
  if (atTime === -Infinity) return startTime;
  return Number.isFinite(atTime) ? atTime : startTime;
}

function windowFor(stream) {
  const startTime = Number.isFinite(stream.startTime) ? stream.startTime : 0;
  const endTime = Number.isFinite(stream.endTime) ? stream.endTime : startTime;
  return { startTime, endTime };
}

/**
 * Core streaming math.
 *
 * A stream linearly releases `total` over the window [startTime, endTime].
 * Given the current time we compute how much has streamed so far.
 *
 *   streamed(t) = total * (clamp(t, start, end) - start) / (end - start)
 *
 * Before startTime nothing has streamed; after endTime the full total has.
 */
function streamedAmount(stream, atTime) {
  const { startTime, endTime } = windowFor(stream);
  const totalUnits = amountToUnits(stream.total);
  const time = safeTime(atTime, startTime, endTime);

  if (endTime <= startTime) {
    // Degenerate window: treat as fully streamed once started.
    return time >= startTime ? unitsToAmount(totalUnits) : 0;
  }

  const elapsed = clamp(time, startTime, endTime) - startTime;
  const duration = endTime - startTime;
  const streamedUnits = Math.round((totalUnits * elapsed) / duration);
  return unitsToAmount(Math.min(totalUnits, Math.max(0, streamedUnits)));
}

/**
 * Amount currently available for the recipient to withdraw: everything that
 * has streamed minus whatever has already been withdrawn. Cancelled streams
 * release nothing further beyond what was already settled.
 */
function withdrawableAmount(stream, atTime) {
  const streamed = streamedAmount(stream, atTime);
  return money.subtract(streamed, stream.withdrawn);
}

/**
 * Amount still locked for the sender (not yet streamed). Once a stream is
 * cancelled this becomes zero because the remainder was refunded.
 */
function lockedAmount(stream, atTime) {
  if (stream.status === STREAM_STATUS.CANCELLED || stream.status === STREAM_STATUS.COMPLETED) return 0;
  const streamed = streamedAmount(stream, atTime);
  return money.subtract(stream.total, streamed);
}

/**
 * Progress of a stream as a fraction in [0, 1] of total time elapsed.
 */
function progress(stream, atTime) {
  const { startTime, endTime } = windowFor(stream);
  const time = safeTime(atTime, startTime, endTime);
  if (endTime <= startTime) return time >= startTime ? 1 : 0;
  const elapsed = clamp(time, startTime, endTime) - startTime;
  return Math.round((elapsed / (endTime - startTime)) * 10000) / 10000;
}

/**
 * Whole seconds remaining until the stream is fully streamed. Zero once the
 * window has closed (or for a degenerate window once it has started).
 */
function remainingSeconds(stream, atTime) {
  const { startTime, endTime } = windowFor(stream);
  const time = safeTime(atTime, startTime, endTime);
  return Math.max(0, endTime - time);
}

/**
 * Project how much will have streamed at a series of future timestamps. Returns
 * an array of `{ time, streamed }` points, useful for charting a vesting curve
 * without recomputing the math client-side. Timestamps are evaluated as given;
 * callers control whether they fall inside or outside the stream window.
 */
function vestingProjection(stream, times) {
  return times.map((time) => ({
    time,
    streamed: streamedAmount(stream, time),
  }));
}

module.exports = {
  amountToUnits,
  unitsToAmount,
  safeTime,
  streamedAmount,
  withdrawableAmount,
  lockedAmount,
  progress,
  remainingSeconds,
  vestingProjection,
};
