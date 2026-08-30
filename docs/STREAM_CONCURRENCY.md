# Stream transition concurrency contract

Withdrawals and cancellations are balance-affecting transitions. They must
not be implemented as an unguarded read, provider call, and write because the
provider call yields the event loop while another request can inspect the same
stream.

## Failure mode

The old flow was effectively:

```text
request A: read withdrawn=0, calculate 1000 available
request B: read withdrawn=0, calculate 1000 available
request A: release 1000, write withdrawn=1000
request B: release 1000, write withdrawn=1000
```

The stored record looked plausible while the underlying funds were released
twice. A cancellation racing with a withdrawal could also refund locked funds
after the recipient had already received them.

## Transition protocol

Every stream has a monotonic integer `version`. New streams begin at version
one. A transition captures the version before awaiting the provider and writes
through `updateStreamIfVersion`. The write succeeds only if the stored version
is still the captured value; a successful write increments it exactly once.

The service also uses `withStreamLock(streamId)` to serialize transitions for
the same stream across the provider await. This is the in-process guard for the
current service. The compare-and-swap method remains necessary as a persistence
boundary and documents the contract a future database-backed store must retain.

```text
withStreamLock(id)
  read state and capture version
  validate status and available amount
  await provider transaction
  compare-and-swap expected version
  increment version and publish outbox event
release lock
```

The lock is keyed by stream ID, so unrelated streams continue concurrently.
An exception from the provider always releases the lock and leaves stream
state, version, and outbox unchanged.

## State rules

| Current state | Operation | Result |
| --- | --- | --- |
| Active with available amount | Withdraw | Provider release, version increment |
| Active with no locked amount | Withdraw | 400; no provider call |
| Active | Cancel | Provider refund, status becomes cancelled |
| Completed | Cancel | 409; no refund |
| Cancelled | Cancel | 409; no refund |
| Any state after a newer write | Stale update | 409; newer state is preserved |

Full withdrawal can move an active stream directly to `completed`. Once that
transition wins, a queued cancellation observes the terminal state and cannot
issue a second provider operation. Conversely, a cancellation that wins first
prevents a queued withdrawal from releasing funds.

## Compatibility

The store accepts legacy records without a version and treats them as version
one for the first guarded transition. Existing public views omit the version
for those legacy records so callers that persist or compare old fixture shapes
do not break. New records and all successfully transitioned records expose the
version, allowing clients and operators to detect stale responses.

Outbox payloads for balance-affecting events include the resulting version.
The existing event keys and status values remain unchanged. Outbox delivery is
still responsible for downstream retries; the stream mutation itself is not
marked complete until the provider call has succeeded and the versioned state
write has completed.

## Operational guidance

Provider calls should remain idempotent by transaction identity in a real
Soroban integration. This service's lock prevents duplicate local transitions,
while the version guard prevents stale persistence. If a process crashes after
the provider commits but before the local write, reconciliation must use the
provider transaction hash before retrying. The transition design deliberately
surfaces that recovery boundary instead of claiming local memory can provide
cross-process atomicity.

Do not remove the lock because Node is single-threaded: asynchronous provider
calls still interleave. Do not replace the conditional write with an
unconditional map assignment. Any future shared store must provide equivalent
row-level compare-and-swap or an atomic transaction around the state change.

## Test matrix

`test/streamConcurrency.test.js` covers:

- two full withdrawals racing for the same stream;
- withdrawal versus cancellation ordering;
- provider failure and retry after lock release;
- stale compare-and-swap writers;
- terminal-state replay protection;
- independent progress for different stream IDs;
- version one compatibility for newly created records; and
- resulting versions on outbox-facing transition results.

These tests use deferred provider promises to force the exact interleaving
that caused the original failure. They do not rely on timing sleeps, making
the race assertions deterministic and fast in CI.

## Deployment checklist

Before enabling a real provider adapter:

1. Persist the stream version in the same database row as `withdrawn` and
   `status`.
2. Implement `updateStreamIfVersion` as a database conditional update and
   treat zero affected rows as a conflict.
3. Include the provider transaction identity in the transition record before
   acknowledging a successful request.
4. Reconcile provider transactions that have no matching local completion.
5. Keep the per-stream lock for duplicate work within one process, but do not
   treat it as a cross-process lock.
6. Alert on repeated version conflicts, provider failures, and reconciliation
   gaps; each indicates a different recovery path.

The in-memory implementation is deliberately small, but its observable
contract is explicit: one winning transition per observed version, no
terminal-state replay, and no state mutation when the provider fails.

## Observability and support guidance

Every successful balance-affecting response includes the stream version that
was committed. This lets a client or support operator compare a response with
a later `GET /streams/:id` result without guessing which request wrote state.

Conflict responses are expected control-flow responses when a terminal state
is reached or when a stale writer loses a compare-and-set race. They should be
reported separately from provider outages. A rising conflict rate can indicate
duplicate client submissions, an overly aggressive retry policy, or a caller
using an old stream representation.

Provider errors do not advance the stream version. The failed request can be
retried after the provider is healthy, and the next successful transition will
still use the version that was current before the failed attempt. Operators
should therefore avoid manually editing stream state to recover from a
transient provider error.

The lock is scoped to a stream ID, so unrelated streams remain independent. A
slow provider call for stream A must not delay a withdrawal for stream B. The
lock is released in a `finally` path, including when the provider rejects, so
one failed request cannot permanently block later work.

This release provides process-local serialization for the current in-memory
store. Deployments that move stream state to a shared database must retain the
version predicate in the database update and coordinate provider side effects
with an outbox or idempotency mechanism. A process-local lock alone is not
sufficient once multiple workers can write the same stream.
