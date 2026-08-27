'use strict';

const streamService = require('../services/streamService');
const ApiError = require('../utils/ApiError');
const { ALL_STATUSES } = require('../constants/streamStatus');

/**
 * POST /api/streams
 * Create a new payment stream. Body has been validated upstream and the
 * cleaned payload is available on req.validated.
 */
async function create(req, res) {
  const stream = await streamService.createStream(req.validated);
  res.status(201).json({ stream });
}

/**
 * GET /api/streams
 * List streams, optionally filtered by ?sender=, ?recipient= and/or ?status=,
 * with ?limit= and ?offset= pagination.
 */
function list(req, res) {
  const { sender, recipient, status, limit, offset, cursor, from, to } = req.query;
  if (status !== undefined && !ALL_STATUSES.includes(status)) {
    throw ApiError.badRequest(
      `Invalid status filter; expected one of ${ALL_STATUSES.join(', ')}`
    );
  }
  const fromTime = from === undefined ? undefined : Number(from);
  const toTime = to === undefined ? undefined : Number(to);
  if ((from !== undefined && !Number.isFinite(fromTime)) ||
      (to !== undefined && !Number.isFinite(toTime)) ||
      (fromTime !== undefined && toTime !== undefined && fromTime > toTime)) {
    throw ApiError.badRequest('from and to must be valid ordered unix timestamps');
  }
  const result = streamService.listStreams({ sender, recipient, status, limit, offset, cursor, from: fromTime, to: toTime });
  res.json({
    count: result.streams.length,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    nextCursor: result.nextCursor,
    streams: result.streams,
  });
}

/**
 * GET /api/streams/:id
 * Fetch a single stream by id.
 */
function getById(req, res) {
  const stream = streamService.getStream(req.params.id);
  res.json({ stream });
}

/**
 * GET /api/streams/:id/schedule
 * Return the stream's vesting schedule and projected milestones.
 */
function getSchedule(req, res) {
  const schedule = streamService.getSchedule(req.params.id);
  res.json({ schedule });
}

/**
 * GET /api/streams/:id/stats
 * Return live point-in-time statistics for a single stream.
 */
function getStats(req, res) {
  const stats = streamService.getStats(req.params.id);
  res.json({ stats });
}

/**
 * POST /api/streams/:id/withdraw
 * Release the amount streamed-so-far to the recipient.
 */
async function withdraw(req, res) {
  const amount = req.validated ? req.validated.amount : undefined;
  const result = await streamService.withdraw(req.params.id, amount);
  res.json(result);
}

/**
 * POST /api/streams/:id/cancel
 * Cancel a stream; the sender reclaims the unstreamed remainder.
 */
async function cancel(req, res) {
  const result = await streamService.cancel(req.params.id);
  res.json(result);
}

/**
 * POST /api/streams/batch
 * Apply a batch of withdraw/cancel actions in one request. Body has been
 * validated upstream. Always responds 200; each item in `results` carries its
 * own ok/error outcome so partial application is visible to the caller.
 */
async function batchUpdate(req, res) {
  const result = await streamService.batchUpdate(req.validated.updates);
  res.json(result);
}

module.exports = { create, list, getById, getSchedule, getStats, withdraw, cancel, batchUpdate };
