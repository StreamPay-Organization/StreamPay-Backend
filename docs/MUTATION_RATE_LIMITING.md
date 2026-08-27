# Mutation rate-limiting contract

Stream mutations can trigger provider calls and alter balances. The API now
applies coordinated fixed-window quotas to every mutation route so a caller
cannot move a burst from one endpoint to another to avoid protection.

## Covered routes

The current mutation surface is:

| Route | Limiter name | Operation |
| --- | --- | --- |
| `POST /api/streams` | `stream.create` | create a stream and lock funds |
| `POST /api/streams/batch` | `stream.batch` | withdraw/cancel multiple streams |
| `POST /api/streams/:id/withdraw` | `stream.withdraw` | release streamed funds |
| `POST /api/streams/:id/cancel` | `stream.cancel` | refund the unstreamed remainder |

The batch route is mounted before the parameterized stream route so it cannot
be shadowed by `/:id`. It receives its own route quota and the same shared
actor quota as the direct endpoints.

## Three coordinated budgets

Each mutation first consumes one token from the following applicable buckets:

1. **Actor budget** — shared across all mutation routes. The authenticated
   actor is read from `req.actorId`, `req.auth.actorId`, `req.user.id`, or the
   repository's mock `X-Actor-Id` boundary. Requests without an actor identity
   use the socket-derived `req.ip`.
2. **Trusted-client budget** — shared across all actors using an allowlisted
   client identity. `X-Client-Id` is eligible only when its value is listed in
   `TRUSTED_RATE_LIMIT_CLIENTS`; arbitrary client headers never create a
   trusted bucket.
3. **Route budget** — keyed by actor and the operation name. It prevents one
   expensive operation from consuming the entire per-route capacity while the
   shared actor budget still prevents route variation from bypassing the
   overall cap.

The defaults are 20 actor mutations per minute, 200 mutations per minute per
trusted client, and 10 calls per minute per actor per route. These are
configuration defaults, not a promise that every deployment has the same
capacity; tune them against provider limits and normal client behavior.

## Response contract

Successful responses include the actor and route remaining counts:

```text
X-Mutation-Actor-RateLimit-Limit
X-Mutation-Actor-RateLimit-Remaining
X-Mutation-Actor-RateLimit-Reset
X-Mutation-Route-RateLimit-Limit
X-Mutation-Route-RateLimit-Remaining
X-Mutation-Route-RateLimit-Reset
```

Trusted-client requests also receive the corresponding
`X-Mutation-Client-RateLimit-*` headers. A blocked request is a `429` with the
existing `RATE_LIMITED` error envelope and a positive `Retry-After` value in
seconds. The reset timestamp is the end of the current fixed window.

Clients should stop sending mutations until `Retry-After` has elapsed, then
retry with bounded exponential backoff and jitter. A retry is not guaranteed
to succeed if another request consumes the bucket first.

## Proxy and identity safety

Express proxy trust defaults to `false`. In that mode the limiter uses the
socket-derived `req.ip`, not arbitrary `X-Forwarded-For` input. A deployment
may set `TRUST_PROXY=true` only when its edge proxy overwrites forwarding
headers and the application can trust the hop. Express then resolves `req.ip`
before the limiter runs.

The identity header is a boundary for the repository's mock authentication
setup, not a substitute for authentication. Production authentication must
overwrite or populate the actor context after verifying the caller. Actor and
client values are length- and character-bounded before entering a key.

## Bounded state and recovery

The implementation is intentionally dependency-free for the current single-
process service. Every bucket has a maximum number of entries. Expired entries
are removed on each request; when a new identity arrives at capacity, the
oldest reset window is evicted. This bounds memory under identity churn. A
multi-process deployment must replace the in-memory state with an atomic shared
store before relying on limits across replicas.

When a window expires, the first request creates a fresh bucket and receives
the full quota. The test suite uses an injected clock to verify recovery
without sleeping.

## Configuration

| Variable | Default | Meaning |
| --- | ---: | --- |
| `TRUST_PROXY` | `false` | Enable Express proxy IP resolution only for a trusted edge |
| `RATE_LIMIT_MAX_ENTRIES` | `10000` | Maximum entries in each in-memory limiter map |
| `MUTATION_RATE_LIMIT_WINDOW_MS` | `60000` | Shared mutation window |
| `MUTATION_RATE_LIMIT_ACTOR_MAX` | `20` | Actor budget across all mutation routes |
| `MUTATION_RATE_LIMIT_CLIENT_MAX` | `200` | Allowlisted trusted-client budget |
| `MUTATION_RATE_LIMIT_ROUTE_MAX` | `10` | Actor budget for one mutation route |
| `TRUSTED_RATE_LIMIT_CLIENTS` | empty | Comma-separated allowlist for `X-Client-Id` |

The general `/api` IP limiter remains in place for broad abuse protection;
mutation quotas are an additional control and do not exempt a request from the
general limit.

## Validation strategy

`test/mutationRateLimit.test.js` covers direct burst behavior, route variation,
actor and trusted-client isolation, proxy-header handling, 429 headers,
window recovery, bounded state under churn, injected identity contexts, batch
coverage, and application proxy defaults. Keep these tests when changing
limits or identity resolution. Add a regression test for every bypass or
provider-cost failure before changing the policy.
