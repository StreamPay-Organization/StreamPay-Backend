'use strict';

const config = require('../config');
const ApiError = require('../utils/ApiError');

/**
 * Minimal in-memory fixed-window rate limiter. Dependency-free and suited to a
 * single-process deployment; for a real cluster prefer a shared store (Redis)
 * via `express-rate-limit`. Requests are bucketed per client IP and reset at
 * the end of each window.
 *
 * The optional state, keyGenerator, clock, headerPrefix, and maxEntries hooks
 * let several limiters share an identity budget while retaining independent
 * route buckets. Expired entries are pruned on every request and a bounded
 * oldest-entry eviction protects the process from unbounded identity churn.
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs ?? config.rateLimit.windowMs;
  const max = options.max ?? config.rateLimit.max;
  const maxEntries = options.maxEntries ?? config.rateLimit.maxEntries;
  const skip = options.skip;
  const keyGenerator = options.keyGenerator || ((req) => req.ip || req.connection?.remoteAddress || 'unknown');
  const now = options.now || (() => Date.now());
  const headerPrefix = options.headerPrefix || 'X-RateLimit';
  const hits = options.state || new Map();

  function prune(currentTime, protectedKey) {
    for (const [key, entry] of hits) {
      if (currentTime >= entry.resetAt && key !== protectedKey) hits.delete(key);
    }

    if (hits.has(protectedKey)) return;
    while (hits.size >= maxEntries) {
      let oldestKey;
      let oldestReset = Infinity;
      for (const [key, entry] of hits) {
        if (entry.resetAt < oldestReset) {
          oldestKey = key;
          oldestReset = entry.resetAt;
        }
      }
      if (oldestKey === undefined) break;
      hits.delete(oldestKey);
    }
  }

  return function rateLimit(req, res, next) {
    if (skip && skip(req)) {
      return next();
    }

    const key = String(keyGenerator(req) || 'unknown');
    const currentTime = now();
    prune(currentTime, key);

    let entry = hits.get(key);
    if (!entry || currentTime >= entry.resetAt) {
      entry = { count: 0, resetAt: currentTime + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader(`${headerPrefix}-Limit`, max);
    res.setHeader(`${headerPrefix}-Remaining`, remaining);
    res.setHeader(`${headerPrefix}-Reset`, Math.ceil(entry.resetAt / 1000));

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000));
      res.setHeader('Retry-After', retryAfter);
      return next(ApiError.tooManyRequests('Rate limit exceeded'));
    }
    next();
  };
}

module.exports = createRateLimiter;
