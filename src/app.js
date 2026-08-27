'use strict';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

const config = require('./config');
const routes = require('./routes');
const requestId = require('./middleware/requestId');
const requestTimeout = require('./middleware/requestTimeout');
const requestLogger = require('./middleware/requestLogger');
const createRateLimiter = require('./middleware/rateLimit');
const noCache = require('./middleware/noCache');
const securityHeaders = require('./middleware/securityHeaders');
const jsonBodyGuard = require('./middleware/jsonBodyGuard');
const notFound = require('./middleware/notFound');
const methodNotAllowed = require('./middleware/methodNotAllowed');
const errorHandler = require('./middleware/errorHandler');

/**
 * Resolve CORS options from config. An origins list of `*` keeps CORS fully
 * open; otherwise only the explicitly allowed origins are permitted.
 */
function corsOptions() {
  const origins = config.corsOrigins;
  if (origins.length === 1 && origins[0] === '*') {
    return {};
  }
  return { origin: origins };
}

/**
 * Build and configure the Express application. Kept separate from the server
 * bootstrap so it can be imported by tests without binding a port.
 */
function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);

  app.use(compression());
  app.use(cors(corsOptions()));
  app.use(securityHeaders);
  app.use(requestId);
  app.use(requestTimeout(config.requestTimeoutMs));
  app.use(express.json({ limit: '100kb' }));
  app.use(jsonBodyGuard);
  app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));
  app.use(requestLogger);

  // Friendly root response.
  app.route('/')
    .get((req, res) => {
      res.json({ name: 'streampay-backend', docs: '/api/health' });
    })
    .all(methodNotAllowed);

  // Health checks and version probes are exempt from rate limiting so
  // orchestrators and monitoring tools can poll freely.
  const healthPaths = ['/api/health', '/api/health/live', '/api/health/ready', '/api/version'];
  const skipHealth = (req) => healthPaths.includes(req.path);
  app.use('/api', noCache, createRateLimiter({ skip: skipHealth }), routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
