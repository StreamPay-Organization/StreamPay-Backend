'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const createMutationRateLimiter = require('../src/middleware/mutationRateLimit').createMutationRateLimiter;
const createApp = require('../src/app');

function mockReqRes(overrides = {}) {
  const headers = {};
  const request = {
    ip: '127.0.0.1',
    path: '/api/streams',
    method: 'POST',
    get(name) {
      const wanted = name.toLowerCase();
      const key = Object.keys(this.headers || {}).find((header) => header.toLowerCase() === wanted);
      return key ? this.headers[key] : undefined;
    },
    headers: {},
    ...overrides,
  };
  const response = {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  return { request, response };
}

function run(middleware, request, response) {
  return new Promise((resolve) => {
    middleware(request, response, (error) => resolve({ error }));
  });
}

function makeLimiter(overrides = {}) {
  return createMutationRateLimiter({
    windowMs: 60_000,
    actorMax: 20,
    trustedClientMax: 20,
    routeMax: 20,
    maxEntries: 100,
    trustedClientIds: ['client-a', 'client-b'],
    ...overrides,
  });
}

async function request(limiter, route, overrides = {}) {
  const { request: req, response: res } = mockReqRes(overrides);
  const result = await run(limiter(route), req, res);
  return { ...result, req, res };
}

test('mutation limiter permits normal requests and emits actor and route budgets', async () => {
  const limiter = makeLimiter({ actorMax: 5, routeMax: 3 });
  const result = await request(limiter, 'stream.create');

  assert.equal(result.error, undefined);
  assert.equal(result.res.headers['X-Mutation-Actor-RateLimit-Limit'], 5);
  assert.equal(result.res.headers['X-Mutation-Actor-RateLimit-Remaining'], 4);
  assert.equal(result.res.headers['X-Mutation-Route-RateLimit-Limit'], 3);
  assert.equal(result.res.headers['X-Mutation-Route-RateLimit-Remaining'], 2);
  assert.ok(typeof result.res.headers['X-Mutation-Actor-RateLimit-Reset'] === 'number');
  assert.ok(typeof result.res.headers['X-Mutation-Route-RateLimit-Reset'] === 'number');
});

test('shared actor quota prevents route variation from bypassing a burst limit', async () => {
  const limiter = makeLimiter({ actorMax: 3, routeMax: 20 });

  assert.equal((await request(limiter, 'stream.create')).error, undefined);
  assert.equal((await request(limiter, 'stream.withdraw')).error, undefined);
  assert.equal((await request(limiter, 'stream.cancel')).error, undefined);

  const blocked = await request(limiter, 'stream.batch');
  assert.ok(blocked.error);
  assert.equal(blocked.error.statusCode, 429);
  assert.equal(blocked.error.code, 'RATE_LIMITED');
  assert.equal(blocked.res.headers['X-Mutation-Actor-RateLimit-Remaining'], 0);
  assert.ok(blocked.res.headers['Retry-After'] >= 1);
});

test('route-specific quota is independent for each mutation operation', async () => {
  const limiter = makeLimiter({ actorMax: 10, routeMax: 2 });

  assert.equal((await request(limiter, 'stream.withdraw')).error, undefined);
  assert.equal((await request(limiter, 'stream.withdraw')).error, undefined);
  const blockedWithdraw = await request(limiter, 'stream.withdraw');
  assert.equal(blockedWithdraw.error.statusCode, 429);

  const create = await request(limiter, 'stream.create');
  assert.equal(create.error, undefined);
  assert.equal(create.res.headers['X-Mutation-Route-RateLimit-Remaining'], 1);
});

test('actor identities receive isolated budgets', async () => {
  const limiter = makeLimiter({ actorMax: 2, routeMax: 20 });
  const actorA = { actorId: 'user-a' };
  const actorB = { actorId: 'user-b' };

  assert.equal((await request(limiter, 'stream.create', actorA)).error, undefined);
  assert.equal((await request(limiter, 'stream.withdraw', actorA)).error, undefined);
  assert.equal((await request(limiter, 'stream.cancel', actorA)).error.statusCode, 429);

  const isolated = await request(limiter, 'stream.cancel', actorB);
  assert.equal(isolated.error, undefined);
  assert.equal(isolated.res.headers['X-Mutation-Actor-RateLimit-Remaining'], 1);
});

test('authenticated actor identity takes precedence over the request IP', async () => {
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  const first = await request(limiter, 'stream.create', { ip: '10.0.0.1', actorId: 'same-actor' });
  const second = await request(limiter, 'stream.cancel', { ip: '10.0.0.2', actorId: 'same-actor' });

  assert.equal(first.error, undefined);
  assert.equal(second.error.statusCode, 429);
});

test('different socket identities do not share an actor bucket', async () => {
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  const first = await request(limiter, 'stream.create', { ip: '10.0.0.1' });
  const second = await request(limiter, 'stream.create', { ip: '10.0.0.2' });

  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
});

test('trusted client quota spans all actors using that client', async () => {
  const limiter = makeLimiter({ actorMax: 20, trustedClientMax: 2, routeMax: 20 });
  const common = { headers: { 'x-client-id': 'client-a' } };

  assert.equal((await request(limiter, 'stream.create', { ...common, actorId: 'actor-a' })).error, undefined);
  assert.equal((await request(limiter, 'stream.withdraw', { ...common, actorId: 'actor-b' })).error, undefined);
  const blocked = await request(limiter, 'stream.cancel', { ...common, actorId: 'actor-c' });

  assert.equal(blocked.error.statusCode, 429);
  assert.equal(blocked.res.headers['X-Mutation-Client-RateLimit-Remaining'], 0);
  assert.ok(blocked.res.headers['Retry-After'] >= 1);
});

test('a different trusted client has an independent client quota', async () => {
  const limiter = makeLimiter({ actorMax: 20, trustedClientMax: 1, routeMax: 20 });
  const exhausted = { headers: { 'x-client-id': 'client-a' }, actorId: 'actor-a' };
  assert.equal((await request(limiter, 'stream.create', exhausted)).error, undefined);
  assert.equal((await request(limiter, 'stream.create', exhausted)).error.statusCode, 429);

  const isolated = await request(limiter, 'stream.create', {
    headers: { 'x-client-id': 'client-b' },
    actorId: 'actor-a',
  });
  assert.equal(isolated.error, undefined);
});

test('unallowlisted client headers cannot create a trusted-client identity', async () => {
  const limiter = makeLimiter({ actorMax: 1, trustedClientMax: 1, routeMax: 20 });
  const first = await request(limiter, 'stream.create', {
    actorId: 'actor-a',
    headers: { 'x-client-id': 'forged-client' },
  });
  const second = await request(limiter, 'stream.cancel', {
    actorId: 'actor-a',
    headers: { 'x-client-id': 'another-forged-client' },
  });

  assert.equal(first.error, undefined);
  assert.equal(second.error.statusCode, 429);
  assert.equal(limiter.snapshot().trustedClients, 0);
});

test('forwarded address changes do not bypass a socket-derived identity', async () => {
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  const first = await request(limiter, 'stream.create', {
    ip: '10.0.0.5',
    headers: { 'x-forwarded-for': '198.51.100.10' },
  });
  const second = await request(limiter, 'stream.cancel', {
    ip: '10.0.0.5',
    headers: { 'x-forwarded-for': '198.51.100.11' },
  });

  assert.equal(first.error, undefined);
  assert.equal(second.error.statusCode, 429);
});

test('a trusted proxy can provide Express-resolved IPs without changing middleware keys', async () => {
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  const first = await request(limiter, 'stream.create', {
    ip: '198.51.100.10',
    headers: { 'x-forwarded-for': '10.0.0.1' },
  });
  const second = await request(limiter, 'stream.cancel', {
    ip: '198.51.100.11',
    headers: { 'x-forwarded-for': '10.0.0.1' },
  });

  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
});

test('429 responses expose retry metadata for actor exhaustion', async () => {
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  await request(limiter, 'stream.create');
  const blocked = await request(limiter, 'stream.withdraw');

  assert.equal(blocked.error.statusCode, 429);
  assert.equal(blocked.res.headers['Retry-After'], 60);
  assert.equal(blocked.res.headers['X-Mutation-Actor-RateLimit-Limit'], 1);
  assert.equal(blocked.res.headers['X-Mutation-Actor-RateLimit-Remaining'], 0);
});

test('429 responses expose retry metadata for route exhaustion', async () => {
  const limiter = makeLimiter({ actorMax: 20, routeMax: 1 });
  await request(limiter, 'stream.create');
  const blocked = await request(limiter, 'stream.create');

  assert.equal(blocked.error.statusCode, 429);
  assert.equal(blocked.res.headers['Retry-After'], 60);
  assert.equal(blocked.res.headers['X-Mutation-Route-RateLimit-Limit'], 1);
  assert.equal(blocked.res.headers['X-Mutation-Route-RateLimit-Remaining'], 0);
});

test('actor quota recovers after the fixed window', async () => {
  let now = 10_000;
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20, now: () => now });
  assert.equal((await request(limiter, 'stream.create')).error, undefined);
  assert.equal((await request(limiter, 'stream.create')).error.statusCode, 429);

  now += 60_000;
  const recovered = await request(limiter, 'stream.create');
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.res.headers['X-Mutation-Actor-RateLimit-Remaining'], 0);
});

test('route quota recovers after the fixed window', async () => {
  let now = 10_000;
  const limiter = makeLimiter({ actorMax: 20, routeMax: 1, now: () => now });
  assert.equal((await request(limiter, 'stream.cancel')).error, undefined);
  assert.equal((await request(limiter, 'stream.cancel')).error.statusCode, 429);

  now += 60_000;
  assert.equal((await request(limiter, 'stream.cancel')).error, undefined);
});

test('trusted client quota recovers after the fixed window', async () => {
  let now = 10_000;
  const limiter = makeLimiter({ actorMax: 20, trustedClientMax: 1, routeMax: 20, now: () => now });
  const options = { headers: { 'x-client-id': 'client-a' } };
  assert.equal((await request(limiter, 'stream.create', options)).error, undefined);
  assert.equal((await request(limiter, 'stream.create', options)).error.statusCode, 429);

  now += 60_000;
  assert.equal((await request(limiter, 'stream.create', options)).error, undefined);
});

test('expired entries are removed before a new identity is admitted', async () => {
  let now = 10_000;
  const limiter = makeLimiter({ actorMax: 5, routeMax: 5, maxEntries: 2, now: () => now });
  await request(limiter, 'stream.create', { actorId: 'actor-a' });
  await request(limiter, 'stream.create', { actorId: 'actor-b' });
  assert.equal(limiter.snapshot().actors, 2);

  now += 60_000;
  await request(limiter, 'stream.create', { actorId: 'actor-c' });
  assert.equal(limiter.snapshot().actors, 1);
});

test('identity churn is bounded by maxEntries', async () => {
  const limiter = makeLimiter({ actorMax: 5, routeMax: 5, maxEntries: 3 });
  for (let index = 0; index < 100; index += 1) {
    const result = await request(limiter, 'stream.create', { actorId: `actor-${index}` });
    assert.equal(result.error, undefined);
  }

  const snapshot = limiter.snapshot();
  assert.ok(snapshot.actors <= 3);
  assert.ok(snapshot.routes.every((route) => route.entries <= 3));
});

test('route state is bounded independently for every named route', async () => {
  const limiter = makeLimiter({ actorMax: 1000, routeMax: 5, maxEntries: 2 });
  for (let index = 0; index < 20; index += 1) {
    await request(limiter, `stream.operation-${index}`, { actorId: `actor-${index}` });
  }

  assert.equal(limiter.snapshot().actors, 2);
  assert.ok(limiter.snapshot().routes.every((route) => route.entries <= 2));
});

test('state reset clears actors, clients, and route buckets', async () => {
  const limiter = makeLimiter({ trustedClientIds: ['client-a'] });
  await request(limiter, 'stream.create', {
    actorId: 'actor-a',
    headers: { 'x-client-id': 'client-a' },
  });
  assert.equal(limiter.snapshot().actors, 1);
  assert.equal(limiter.snapshot().trustedClients, 1);
  assert.equal(limiter.snapshot().routes[0].entries, 1);

  limiter.reset();
  assert.deepEqual(limiter.snapshot(), {
    actors: 0,
    trustedClients: 0,
    routes: [{ route: 'stream.create', entries: 0 }],
  });
});

test('route names are required so accidental unscoped middleware is rejected', () => {
  const limiter = makeLimiter();
  assert.throws(() => limiter(), /routeName is required/);
  assert.throws(() => limiter(''), /routeName is required/);
  assert.throws(() => limiter(null), /routeName is required/);
});

test('actor IDs are normalized but malformed values fall back safely', async () => {
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  const valid = await request(limiter, 'stream.create', { actorId: ' actor-a ' });
  const invalid = await request(limiter, 'stream.cancel', { actorId: 'actor with spaces' });

  assert.equal(valid.error, undefined);
  assert.equal(invalid.error, undefined);
  assert.equal(limiter.snapshot().actors, 2);
});

test('request user and auth objects can provide actor identity', async () => {
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  const user = await request(limiter, 'stream.create', { user: { id: 'user-object' } });
  const auth = await request(limiter, 'stream.cancel', { auth: { actorId: 'auth-object' } });

  assert.equal(user.error, undefined);
  assert.equal(auth.error, undefined);
  assert.equal(limiter.snapshot().actors, 2);
});

test('trusted client identity can come from an injected gateway context', async () => {
  const limiter = makeLimiter({ actorMax: 20, trustedClientMax: 1, routeMax: 20 });
  const first = await request(limiter, 'stream.create', { trustedClientId: 'client-a', actorId: 'one' });
  const second = await request(limiter, 'stream.cancel', { trustedClientId: 'client-a', actorId: 'two' });

  assert.equal(first.error, undefined);
  assert.equal(second.error.statusCode, 429);
});

test('batch route receives the same shared actor budget as direct mutations', async () => {
  const limiter = makeLimiter({ actorMax: 2, routeMax: 20 });
  assert.equal((await request(limiter, 'stream.batch', { actorId: 'batch-user' })).error, undefined);
  assert.equal((await request(limiter, 'stream.create', { actorId: 'batch-user' })).error, undefined);
  assert.equal((await request(limiter, 'stream.batch', { actorId: 'batch-user' })).error.statusCode, 429);
});

test('separate limiter factories do not share state', async () => {
  const firstLimiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  const secondLimiter = makeLimiter({ actorMax: 1, routeMax: 20 });
  await request(firstLimiter, 'stream.create', { actorId: 'same' });

  const isolated = await request(secondLimiter, 'stream.create', { actorId: 'same' });
  assert.equal(isolated.error, undefined);
});

test('application explicitly defaults proxy trust to false', () => {
  const app = createApp();
  assert.equal(app.get('trust proxy'), false);
});

test('all exposed mutation route names can be independently represented', async () => {
  const limiter = makeLimiter({ actorMax: 100, routeMax: 1 });
  const routes = ['stream.create', 'stream.batch', 'stream.withdraw', 'stream.cancel'];
  for (const route of routes) {
    const result = await request(limiter, route, { actorId: route });
    assert.equal(result.error, undefined, route);
  }
  assert.deepEqual(
    limiter.snapshot().routes.map((route) => route.route),
    routes,
  );
});

test('successful requests consume one actor and one route token', async () => {
  const limiter = makeLimiter({ actorMax: 3, routeMax: 2 });
  const first = await request(limiter, 'stream.create', { actorId: 'account' });
  const second = await request(limiter, 'stream.create', { actorId: 'account' });

  assert.equal(first.res.headers['X-Mutation-Actor-RateLimit-Remaining'], 2);
  assert.equal(first.res.headers['X-Mutation-Route-RateLimit-Remaining'], 1);
  assert.equal(second.res.headers['X-Mutation-Actor-RateLimit-Remaining'], 1);
  assert.equal(second.res.headers['X-Mutation-Route-RateLimit-Remaining'], 0);
});

test('a client limit is not created for ordinary IP-only traffic', async () => {
  const limiter = makeLimiter({ actorMax: 5, routeMax: 5 });
  await request(limiter, 'stream.create');
  const snapshot = limiter.snapshot();
  assert.equal(snapshot.trustedClients, 0);
  assert.equal(snapshot.actors, 1);
});

test('retry metadata never reports a zero-second retry window', async () => {
  let now = 10_000;
  const limiter = makeLimiter({ actorMax: 1, routeMax: 20, windowMs: 1, now: () => now });
  await request(limiter, 'stream.create');
  now += 0.1;
  const blocked = await request(limiter, 'stream.create');
  assert.equal(blocked.error.statusCode, 429);
  assert.equal(blocked.res.headers['Retry-After'], 1);
});
