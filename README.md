# StreamPay Backend

StreamPay is a real-time payment-streaming application built on top of the
Stellar / Soroban network. This repository contains the backend REST API.

A payment stream locks a `total` amount from a sender and releases it linearly
to a recipient over a time window (`startTime` to `endTime`). The recipient can
withdraw whatever has streamed so far at any moment, and the sender can cancel
to reclaim the unstreamed remainder.

> Note: the Stellar / Soroban layer is mocked in this project. No real on-chain
> transactions are submitted. The streaming math, balances and analytics are
> computed in-memory.

## Stack

- Node.js + Express
- In-memory store (no database)
- `compression`, `cors`, `dotenv`, `morgan`, `uuid`

## Getting started

```bash
npm install
cp .env.example .env
npm start
```

The server listens on `PORT` (default `4000`).

## API

All endpoints are mounted under `/api`.

### Health

`GET /api/health` — health probe with runtime context.

`GET /api/health/live` — liveness probe; confirms the process is up.

`GET /api/health/ready` — readiness probe; confirms the app can serve traffic.

`GET /api/version` — service name, version and Node runtime, for deploy checks.

### Streams

`POST /api/streams` — create a stream.

```json
{
  "sender": "GALICE...",
  "recipient": "GBOB...",
  "total": 1000,
  "startTime": 1700000000,
  "endTime": 1700003600
}
```

`startTime` is optional (defaults to now). `endTime` is required and must be
after `startTime`; the window must be at least 60 seconds and at most 10 years.
`total` must be a positive number not exceeding 1e12.

`GET /api/streams` — list streams. Optional query filters: `sender`,
`recipient`, `status` (`active` | `completed` | `cancelled`), `from` and `to`.
Paginated via `limit` (default 50, max 200) and `offset` (default 0). For
stable traversal, use the returned `nextCursor` as `cursor`; cursor pages use a
snapshot boundary so streams inserted during traversal are not duplicated or
reordered.

`GET /api/streams/:id` — fetch a single stream.

`GET /api/streams/:id/schedule` — the stream's vesting schedule: window,
duration, per-second release rate and projected milestones (0/25/50/75/100%).

`GET /api/streams/:id/stats` — live point-in-time figures: streamed, withdrawn,
withdrawable and locked amounts plus the percentage streamed/withdrawn.

`POST /api/streams/:id/withdraw` — release streamed-so-far to the recipient.
Optional body `{ "amount": 100 }` for a partial withdrawal; omitting it
withdraws the full available balance.

`POST /api/streams/:id/cancel` — sender cancels and reclaims the remainder.

`POST /api/streams/batch` — apply up to 25 withdraw/cancel actions in a single
request:

```json
{
  "updates": [
    { "id": "stream_abc", "action": "withdraw", "amount": 100 },
    { "id": "stream_def", "action": "cancel" }
  ]
}
```

`amount` is optional on `withdraw` (omitting it withdraws the full available
balance, same as the single-stream endpoint) and not allowed on `cancel`.
Each item is applied independently and best-effort: one item failing (stream
not found, already cancelled, nothing withdrawable, etc.) does not stop the
rest of the batch. The response reports a per-item outcome rather than a
single pass/fail for the whole request:

```json
{
  "results": [
    { "id": "stream_abc", "action": "withdraw", "ok": true, "stream": { "...": "..." }, "amount": 100, "txHash": "tx_..." },
    { "id": "stream_def", "action": "cancel", "ok": false, "error": { "message": "Stream stream_def not found", "code": "NOT_FOUND", "statusCode": 404 } }
  ],
  "count": 2,
  "succeeded": 1,
  "failed": 1
}
```

Validation happens up front and rejects the whole request if malformed: an
empty or oversized batch, an unknown `id`/`action` shape, or the same `id`
appearing twice in one batch (which would otherwise let a single request
apply an action to the same stream more than once).

### Balances & analytics

`GET /api/balances?user=GBOB...` — total withdrawable for a user across streams.

`GET /api/withdrawable` — protocol-wide withdrawable balances grouped by
recipient, sorted from largest to smallest.

`GET /api/analytics` — protocol-wide totals: total streamed, active streams,
total locked. Optional `windowSeconds` and `maxStreams` parameters are capped
to protect aggregation latency.

### Event delivery

Stream lifecycle mutations enqueue a deduplicated event after the state change.
The outbox state machine is `pending` → `processing` → `delivered`, with
bounded exponential retry and a terminal `failed` state for poison events.
The current mock keeps these records in its process store; a production adapter
can map the same records to a database-backed outbox without changing delivery.

## Errors

Errors use a consistent JSON envelope:

```json
{
  "error": {
    "message": "Stream stream_x not found",
    "status": 404,
    "code": "NOT_FOUND"
  }
}
```

`code` is a stable, machine-readable identifier (`BAD_REQUEST`, `FORBIDDEN`,
`NOT_FOUND`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `UNPROCESSABLE_ENTITY`, `RATE_LIMITED`,
`SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`) that clients can switch on
independently of the human-readable `message`. Every response also carries an
`X-Request-Id` header (echoed from the request when supplied) for log
correlation, and `/api` responses are returned with `Cache-Control: no-store`
since the figures are time-sensitive.

## Configuration

All settings are read from environment variables (see `.env.example`):

- `PORT`, `NODE_ENV`, `LOG_LEVEL` — server basics.
- `REQUEST_TIMEOUT_MS` — deadline after which a request is failed with
  `503 SERVICE_UNAVAILABLE` (default: 15000).
- `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` — fixed-window rate limit applied to
  `/api` per client IP (defaults: 60s / 120 requests). Responses include
  `X-RateLimit-*` headers; exceeding the limit returns `429 RATE_LIMITED`.
  Health check and version endpoints (`/api/health`, `/api/health/live`,
  `/api/health/ready`, `/api/version`) are exempt from rate limiting so
  orchestrators and monitoring tools can poll freely.
- `TRUST_PROXY` — set to `true` only behind a proxy that overwrites forwarded
  address headers; defaults to `false`.
- `MUTATION_RATE_LIMIT_*` — coordinated actor, trusted-client, and per-route
  mutation quotas. Defaults are 20 actor mutations/minute across all routes,
  200/minute per allowlisted trusted client, and 10/minute per actor per route.
  `TRUSTED_RATE_LIMIT_CLIENTS` is a comma-separated allowlist for
  `X-Client-Id`. Mutation `429` responses include `Retry-After` plus the
  `X-Mutation-*-RateLimit-*` headers. See `docs/MUTATION_RATE_LIMITING.md`.
- `CORS_ORIGINS` — comma-separated list of allowed origins, or `*` for any.
- `STELLAR_*` / `NATIVE_ASSET` — mock Stellar / Soroban settings.

## Tests

Unit tests use the built-in Node test runner (no extra dependencies):

```bash
npm test
```

## License

MIT
