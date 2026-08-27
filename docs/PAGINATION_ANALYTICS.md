# Stream history and analytics contract

StreamPay list and analytics endpoints are designed for histories that grow
continuously. The service supports offset pagination for compatibility and
cursor pagination for stable traversal under concurrent inserts.

## Ordering

Records are ordered by `createdAt` descending, then `id` descending. The second
tie-breaker is mandatory: timestamps are second-based and multiple streams can
be created in the same second. Clients must not assume insertion order from a
Map or database result.

## Offset pagination

Offset requests accept `limit` and `offset`. The default limit is 50, the
maximum is 200, and offset values below zero are treated as zero. Offset pages
remain available for existing clients, but inserts before the current offset
can shift records between requests. Use a cursor when the caller needs a
complete stable traversal.

## Cursor pagination

The first request omits `cursor`. The response includes `nextCursor` when more
records are available. The opaque token contains a snapshot boundary and the
last record boundary, encoded as base64url JSON. Clients must treat it as an
opaque value and send it back unchanged:

```text
GET /api/streams?limit=50
GET /api/streams?limit=50&cursor=<nextCursor>
```

The snapshot boundary is the newest record in the first page. On continuation,
records newer than that boundary are ignored and records at or before the last
record are skipped. A stream inserted while the client is paging therefore
does not duplicate an existing record or change the page order.

Cursor tokens are validated for shape, numeric timestamps, and string IDs. A
malformed token returns a 400 error. Tokens are intentionally opaque and carry
no authorization decision; filters should be repeated with every request.

## Filters

The stream history endpoint supports exact participant and status filters plus
inclusive `from` and `to` creation timestamps. The controller validates that
timestamps are finite and ordered before invoking the service. Filters are
applied before the page budget so a small page never causes an unbounded result
scan at the HTTP boundary.

## Analytics budget

Protocol analytics accepts `windowSeconds` and `maxStreams`. A window is capped
at 365 days and the stream sample is capped at 10,000 records. Defaults use
those same maximums so existing callers retain a broad view without making an
unbounded request. The response reports the effective `windowSeconds` and
`maxStreams` values so dashboards can display the exact scope of a result.

The service filters by creation time, sorts deterministically, and applies the
sample limit before aggregating. This gives latency a predictable upper bound
and avoids aggregating stale history when a caller asks for a recent window.

## Race behavior

The in-memory store is single-process, but tests model the important race: a
new stream appears between page requests. Cursor traversal remains anchored to
the original snapshot. A record that is updated after the first page may still
appear according to the source's creation boundary; consumers that require
change feeds should use an event stream rather than pagination.

## Client guidance

- Prefer cursors for exports, reconciliation, and infinite scroll.
- Keep the cursor with the filter set that produced it.
- Restart traversal if filters change.
- Stop when `nextCursor` is null.
- Do not decode or edit tokens.
- Use `total` as informational because concurrent writes may change it.
- Treat 400 cursor errors as a request restart, not a retry loop.
- Record the effective analytics budget with dashboard snapshots.

## Compatibility and rollback

The `streams`, `count`, `total`, `limit`, and `offset` fields remain compatible
with the previous offset response. `nextCursor` is additive. The analytics
response adds effective-bound fields without changing existing aggregate names.
No migration is needed because ordering and cursors are derived from records.

To roll back, remove cursor query handling and the budget fields; stored streams
remain valid. A future persistent adapter must preserve the ordering tuple and
add indexes for sender, recipient, status, and creation time.

## Test checklist

- deterministic tie ordering;
- participant/status/time filter composition;
- offset compatibility;
- cursor continuation;
- insertion during traversal;
- malformed token rejection;
- complete no-duplicate traversal;
- default analytics bounds;
- oversized bound capping;
- malformed bound fallback; and
- max-sample ordering.

## Operational review notes

The effective bounds are part of the response because a capped result is not
the same as a result over the caller's requested scope. Monitoring should track
the number of requests that hit either cap and alert when capping becomes a
normal dashboard pattern. That is a capacity signal, not a reason to remove the
bound.

The in-memory implementation calculates the cursor after filtering and sorting
the matching records. A persistent implementation must use the same logical
predicate in its query rather than fetching an arbitrary page and filtering in
application memory. The index strategy should mirror the most common filter
sets:

| Query | Useful index shape |
| --- | --- |
| recipient + status + createdAt | `(recipient, status, createdAt, id)` |
| sender + status + createdAt | `(sender, status, createdAt, id)` |
| status + createdAt | `(status, createdAt, id)` |
| createdAt only | `(createdAt, id)` |

Indexes are an implementation detail, but the ordering tuple is an API
correctness requirement. If an adapter cannot guarantee the tuple, it must not
issue a cursor token that claims snapshot stability.

## Export behavior

An export worker should persist the filter set, effective budget, first snapshot
boundary, last cursor, and count of records written. If the worker restarts, it
can resume with the same cursor and produce a deterministic continuation. It
must not silently switch to offset paging after a cursor failure because that
can duplicate records.

If a cursor expires in a future persistent implementation, return a distinct
machine-readable error rather than silently starting over. The current mock has
no expiry, so a token remains valid for the lifetime of the process and the
underlying records.

## Analytics interpretation

`totalStreamed`, `totalLocked`, and `totalWithdrawable` are point-in-time
quantities computed at one `nowSeconds()` sample. They should be interpreted as
a bounded snapshot, not as a ledger statement. Consumers comparing two samples
should retain the effective window, stream limit, generation timestamp, and
network/asset fields.

The `streams` count reflects the records included in the bounded sample. It is
not necessarily the total number of streams in storage when a window or sample
cap excludes older records. Existing dashboards that need the all-time count
should use the default budget and display the returned effective values.

## Failure handling

Malformed `from` or `to` values are rejected before any storage work. An
inverted range is also rejected because silently swapping it hides a caller
bug. A malformed cursor is a client request error and should be logged with
the request ID, but it should not trigger a server retry loop.

If a storage adapter becomes unavailable during analytics, the normal service
error contract should be returned. The bound remains in force for retries; an
upstream retry must not turn a bounded request into an unbounded fallback.

## Change checklist

Any future pagination change should answer these questions in its PR:

1. What is the deterministic order?
2. What is the snapshot boundary?
3. How are ties handled?
4. Can inserts duplicate or reorder a page?
5. Are filters applied before the budget?
6. What is the maximum storage work?
7. How is a malformed token reported?
8. What does `total` mean under concurrent writes?
9. Does offset compatibility remain intact?
10. Are query-plan and large-fixture tests included?
11. Can a worker resume after interruption?
12. Is the effective budget observable to consumers?

This checklist keeps performance work focused on correctness as well as speed.

## Maintainer acceptance

Reviewers should inspect the cursor payload handling, filter validation, and
analytics caps together. A locally passing unit test is not sufficient if a
route can bypass the service budget or if a response omits the effective scope.
The complete test command must run without disabled checks, skipped suites, or
generated fixtures that conceal the race behavior.

The implementation should remain readable enough that a maintainer can trace a
record from filter input, through ordering, to the cursor returned to the
client.

When adding a new filter, include it in the cursor's repeated request contract
and add a race test proving that the filter does not widen between pages.

If the new filter changes the meaning of a snapshot, document that behavior in
the response contract and in the operational dashboards.

This keeps pagination semantics explicit for both current and future adapters.

It also makes performance regressions visible during review.

The cursor contract is therefore part of the public API, not a private query
optimization.

Changes to its ordering or bounds require a compatibility note and regression
coverage.

Maintainers can use the documented checklist as the acceptance record.

It should be updated with any future pagination implementation.

This preserves a clear review trail for race-sensitive API behavior.

The same record supports maintainer sign-off and future adapter migration.

It remains intentionally bounded and deterministic.
