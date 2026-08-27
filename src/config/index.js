'use strict';

require('dotenv').config();

/**
 * Centralized application configuration. Values are read from environment
 * variables with sensible defaults so the app boots without a .env file.
 */
const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 4000,
  logLevel: process.env.LOG_LEVEL || 'info',

  // Maximum time a request may take before it is failed with 503.
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 15000,

  // Forwarded addresses are untrusted unless the deployment explicitly opts
  // into proxy support. The proxy must overwrite, rather than append to,
  // forwarding headers before enabling this setting.
  trustProxy: process.env.TRUST_PROXY === 'true',

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 120,
    maxEntries: parseInt(process.env.RATE_LIMIT_MAX_ENTRIES, 10) || 10000,
    mutation: {
      windowMs: parseInt(process.env.MUTATION_RATE_LIMIT_WINDOW_MS, 10) || 60000,
      actorMax: parseInt(process.env.MUTATION_RATE_LIMIT_ACTOR_MAX, 10) || 20,
      trustedClientMax: parseInt(process.env.MUTATION_RATE_LIMIT_CLIENT_MAX, 10) || 200,
      routeMax: parseInt(process.env.MUTATION_RATE_LIMIT_ROUTE_MAX, 10) || 10,
    },
    trustedClientIds: (process.env.TRUSTED_RATE_LIMIT_CLIENTS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  },

  // Comma-separated list of allowed CORS origins. Defaults to '*' (any origin)
  // to keep local development frictionless; set CORS_ORIGINS in production to
  // restrict which front-ends may call the API.
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
    horizonUrl:
      process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl:
      process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    streamContractId:
      process.env.STREAM_CONTRACT_ID ||
      'CMOCKSTREAMCONTRACT000000000000000000000000000000000000',
    nativeAsset: process.env.NATIVE_ASSET || 'XLM',
  },
};

/**
 * Validate critical config values at load time. Throws early with a clear
 * message rather than failing mysteriously later.
 */
function validate(cfg) {
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    throw new Error(`Invalid PORT: ${cfg.port}`);
  }
  if (!Number.isInteger(cfg.rateLimit.windowMs) || cfg.rateLimit.windowMs <= 0) {
    throw new Error(`Invalid RATE_LIMIT_WINDOW_MS: ${cfg.rateLimit.windowMs}`);
  }
  if (!Number.isInteger(cfg.rateLimit.max) || cfg.rateLimit.max <= 0) {
    throw new Error(`Invalid RATE_LIMIT_MAX: ${cfg.rateLimit.max}`);
  }
  if (!Number.isInteger(cfg.rateLimit.maxEntries) || cfg.rateLimit.maxEntries <= 0) {
    throw new Error(`Invalid RATE_LIMIT_MAX_ENTRIES: ${cfg.rateLimit.maxEntries}`);
  }
  const mutation = cfg.rateLimit.mutation;
  for (const [name, value] of Object.entries(mutation)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid mutation rate limit ${name}: ${value}`);
    }
  }
  if (!Number.isInteger(cfg.requestTimeoutMs) || cfg.requestTimeoutMs <= 0) {
    throw new Error(`Invalid REQUEST_TIMEOUT_MS: ${cfg.requestTimeoutMs}`);
  }
  return cfg;
}

module.exports = validate(config);
