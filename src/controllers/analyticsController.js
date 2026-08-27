'use strict';

const analyticsService = require('../services/analyticsService');
const ApiError = require('../utils/ApiError');

/**
 * GET /api/balances?user=
 * Return the total withdrawable balance for a user across their streams.
 */
function balances(req, res) {
  const user = typeof req.query.user === 'string' ? req.query.user.trim() : '';
  if (!user) {
    throw ApiError.badRequest('Query parameter "user" is required');
  }
  res.json(analyticsService.withdrawableForUser(user));
}

/**
 * GET /api/withdrawable
 * Protocol-wide withdrawable balances grouped by recipient.
 */
function withdrawable(req, res) {
  res.json(analyticsService.withdrawableSummary());
}

/**
 * GET /api/analytics
 * Protocol-wide totals: total streamed, active streams, total locked.
 */
function analytics(req, res) {
  res.json(analyticsService.overview({
    windowSeconds: req.query.windowSeconds,
    maxStreams: req.query.maxStreams,
  }));
}

module.exports = { balances, withdrawable, analytics };
