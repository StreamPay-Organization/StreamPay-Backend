'use strict';

const store = require('../store');
const streamMath = require('./streamMath');
const money = require('../utils/money');
const { nowSeconds } = require('../utils/time');
const { STREAM_STATUS } = require('../constants/streamStatus');
const config = require('../config');
const { PAGINATION } = require('../constants/pagination');

/**
 * Aggregate withdrawable balance for a single user across every stream where
 * they are the recipient.
 */
function withdrawableForUser(user) {
  const at = nowSeconds();
  const streams = store.listStreams().filter((s) => s.recipient === user);

  let total = 0;
  const details = streams.map((s) => {
    const amount = streamMath.withdrawableAmount(s, at);
    total = money.round(total + amount);
    return { streamId: s.id, withdrawable: amount, status: s.status };
  });

  return { user, totalWithdrawable: total, streams: details };
}

/**
 * Withdrawable summary grouped by recipient across every stream. Returns one
 * entry per recipient with their aggregate withdrawable balance and stream
 * count, sorted from largest balance to smallest. Recipients with nothing
 * currently withdrawable are omitted.
 */
function withdrawableSummary() {
  const at = nowSeconds();
  const byRecipient = new Map();

  for (const s of store.listStreams()) {
    const amount = streamMath.withdrawableAmount(s, at);
    if (amount <= 0) continue;
    const entry = byRecipient.get(s.recipient) || { withdrawable: 0, streams: 0 };
    entry.withdrawable = money.round(entry.withdrawable + amount);
    entry.streams += 1;
    byRecipient.set(s.recipient, entry);
  }

  const recipients = Array.from(byRecipient.entries())
    .map(([recipient, entry]) => ({ recipient, ...entry }))
    .sort((a, b) => b.withdrawable - a.withdrawable);

  const totalWithdrawable = money.sum(recipients.map((r) => r.withdrawable));
  return { totalWithdrawable, recipients };
}

/**
 * Protocol-wide analytics: total streamed across all streams, count of active
 * streams, and the total amount still locked.
 */
function overview({ windowSeconds, maxStreams } = {}) {
  const at = nowSeconds();
  const requestedWindow = Number(windowSeconds);
  const safeWindow = Number.isFinite(requestedWindow) && requestedWindow > 0
    ? Math.min(requestedWindow, PAGINATION.MAX_WINDOW_SECONDS)
    : PAGINATION.MAX_WINDOW_SECONDS;
  const requestedMax = Number(maxStreams);
  const safeMax = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(Math.floor(requestedMax), PAGINATION.MAX_ANALYTICS_STREAMS)
    : PAGINATION.MAX_ANALYTICS_STREAMS;
  const streams = store.listStreams()
    .filter((s) => s.createdAt >= at - safeWindow)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, safeMax);

  let totalStreamed = 0;
  let totalLocked = 0;
  let totalWithdrawn = 0;
  let totalWithdrawable = 0;
  let active = 0;
  let cancelled = 0;
  let completed = 0;

  for (const s of streams) {
    totalStreamed = money.round(totalStreamed + streamMath.streamedAmount(s, at));
    totalLocked = money.round(totalLocked + streamMath.lockedAmount(s, at));
    totalWithdrawn = money.round(totalWithdrawn + s.withdrawn);
    totalWithdrawable = money.round(totalWithdrawable + streamMath.withdrawableAmount(s, at));
    if (s.status === STREAM_STATUS.ACTIVE) active += 1;
    if (s.status === STREAM_STATUS.CANCELLED) cancelled += 1;
    if (s.status === STREAM_STATUS.COMPLETED) completed += 1;
  }

  return {
    network: config.stellar.network,
    asset: config.stellar.nativeAsset,
    streams: streams.length,
    activeStreams: active,
    cancelledStreams: cancelled,
    completedStreams: completed,
    totalStreamed,
    totalLocked,
    totalWithdrawn,
    totalWithdrawable,
    windowSeconds: safeWindow,
    maxStreams: safeMax,
  };
}

module.exports = { withdrawableForUser, withdrawableSummary, overview };
