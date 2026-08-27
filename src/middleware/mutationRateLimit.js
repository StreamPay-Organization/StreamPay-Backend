'use strict';

const config = require('../config');
const createRateLimiter = require('./rateLimit');

const IDENTITY_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;

function cleanIdentity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return IDENTITY_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Resolve the actor identity supplied by an authentication layer. The
 * development fallback is the socket-derived Express IP; arbitrary
 * X-Forwarded-For values do not enter the key unless TRUST_PROXY is enabled
 * in app.js. `X-Actor-Id` is supported for the repository's mock auth
 * boundary and should be overwritten by a trusted gateway in production.
 */
function actorKey(req) {
  const actor = cleanIdentity(
    req.actorId || req.auth?.actorId || req.user?.id || req.get?.('x-actor-id'),
  );
  if (actor) return `actor:${actor}`;
  return `ip:${cleanIdentity(req.ip) || 'unknown'}`;
}

function trustedClientKey(req, trustedClientIds) {
  const supplied = cleanIdentity(
    req.trustedClientId || req.get?.('x-client-id'),
  );
  if (!supplied || !trustedClientIds.has(supplied)) return null;
  return `client:${supplied}`;
}

function createMutationRateLimiter(options = {}) {
  const settings = {
    windowMs: options.windowMs ?? config.rateLimit.mutation.windowMs,
    actorMax: options.actorMax ?? config.rateLimit.mutation.actorMax,
    trustedClientMax: options.trustedClientMax ?? config.rateLimit.mutation.trustedClientMax,
    routeMax: options.routeMax ?? config.rateLimit.mutation.routeMax,
    maxEntries: options.maxEntries ?? config.rateLimit.maxEntries,
    trustedClientIds: new Set(options.trustedClientIds ?? config.rateLimit.trustedClientIds),
    now: options.now,
  };

  const actorState = new Map();
  const clientState = new Map();
  const routeStates = new Map();
  const actorLimiter = createRateLimiter({
    windowMs: settings.windowMs,
    max: settings.actorMax,
    maxEntries: settings.maxEntries,
    state: actorState,
    keyGenerator: actorKey,
    headerPrefix: 'X-Mutation-Actor-RateLimit',
    now: settings.now,
  });
  const clientLimiter = createRateLimiter({
    windowMs: settings.windowMs,
    max: settings.trustedClientMax,
    maxEntries: settings.maxEntries,
    state: clientState,
    keyGenerator: (req) => trustedClientKey(req, settings.trustedClientIds) || '__no_trusted_client__',
    headerPrefix: 'X-Mutation-Client-RateLimit',
    now: settings.now,
  });

  function routeLimiter(routeName) {
    if (!routeStates.has(routeName)) {
      routeStates.set(routeName, new Map());
    }
    return createRateLimiter({
      windowMs: settings.windowMs,
      max: settings.routeMax,
      maxEntries: settings.maxEntries,
      state: routeStates.get(routeName),
      keyGenerator: actorKey,
      headerPrefix: 'X-Mutation-Route-RateLimit',
      now: settings.now,
    });
  }

  function middleware(routeName) {
    if (typeof routeName !== 'string' || !routeName.trim()) {
      throw new TypeError('routeName is required for mutation rate limiting');
    }
    const route = routeLimiter(routeName);
    return (req, res, next) => {
      actorLimiter(req, res, (actorError) => {
        if (actorError) return next(actorError);

        const trusted = trustedClientKey(req, settings.trustedClientIds);
        if (trusted) {
          clientLimiter(req, res, (clientError) => {
            if (clientError) return next(clientError);
            return route(req, res, next);
          });
          return;
        }
        return route(req, res, next);
      });
    };
  }

  middleware.reset = () => {
    actorState.clear();
    clientState.clear();
    for (const state of routeStates.values()) state.clear();
  };

  middleware.snapshot = () => ({
    actors: actorState.size,
    trustedClients: clientState.size,
    routes: Array.from(routeStates, ([route, state]) => ({ route, entries: state.size })),
  });

  return middleware;
}

const mutationRateLimit = createMutationRateLimiter();

module.exports = mutationRateLimit;
module.exports.createMutationRateLimiter = createMutationRateLimiter;
module.exports.actorKey = actorKey;
module.exports.trustedClientKey = trustedClientKey;
