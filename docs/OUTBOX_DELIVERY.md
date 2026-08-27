# StreamPay lifecycle event delivery

Stream lifecycle transitions produce downstream notifications through an
outbox handoff. The producer first commits the stream state in the local store,
then records an event keyed to the transition. A delivery worker can publish
the event and update its state independently of the request that performed the
mutation.

## Record contract

| Field | Meaning |
| --- | --- |
| `id` | Server-generated delivery record identifier. |
| `key` | Unique business deduplication key. |
| `type` | Stable event type such as `stream.created`. |
| `aggregateId` | Stream resource associated with the event. |
| `payload` | Bounded event data needed by consumers. |
| `status` | `pending`, `processing`, `delivered`, or `failed`. |
| `attempts` | Number of delivery attempts. |
| `nextAttemptAt` | Earliest timestamp at which a retry may be claimed. |
| `deliveredAt` | Completion timestamp, or null before delivery. |
| `lastError` | Bounded failure reason for operator inspection. |

## Producer ordering

Create, withdraw, and cancel operations enqueue after the stream record has
been inserted or updated. The event payload contains identifiers and outcome
values, not an entire mutable stream object. This makes the message stable for
consumers and prevents later in-memory mutations from changing an already
committed notification.

The event key is deterministic for a business transition. Creation uses the
stream ID and `created`; cancellation uses the stream ID and `cancelled`;
withdrawals include the provider transaction hash so separate partial
withdrawals remain distinct while a retry of the same committed transition is
deduplicated.

## State machine

```text
pending -> processing -> delivered
             |               |
             +-> pending      +-> (terminal)
             |
             +-> failed after the attempt limit
```

Workers claim only ready `pending` records. A successful publish changes the
record to `delivered` and adds it to the delivered-key index. A thrown publish
error returns a record to `pending` with exponential backoff until the bounded
attempt limit is reached. At that point it becomes `failed` and no longer
blocks healthy events.

## Retry policy

The mock uses a one-second base delay and doubles it for each attempt. The
attempt count is capped at five. A production worker should add jitter, use a
lease or visibility timeout for `processing`, and reclaim abandoned claims
after a worker crash. The same key must remain unique across workers.

Retrying an event is safe only when the consumer also honors the event key.
The producer cannot prevent duplicate side effects after a process crash if a
consumer publishes successfully but the acknowledgment is lost. Consumers
must therefore store a processed-key record or use an idempotent downstream
operation.

## Crash-window behavior

The request path has two local writes: the business state change and the
outbox record. The repository currently uses an in-memory store, so the
implementation documents this as a durable-handoff boundary rather than
claiming process-restart durability. A database adapter must place both writes
in one transaction or use a transactional outbox table.

On worker restart, `pending` records remain eligible in a durable adapter.
Records marked `processing` need a lease expiry so they can be safely reclaimed.
Records marked `delivered` must remain visible long enough for reconciliation.

## Poison isolation

One malformed event must not abort a delivery batch. The worker catches the
individual publish error, records it on that event, and continues to the next
ready record. Operators can inspect `lastError`, `attempts`, and `aggregateId`
to repair or quarantine a poison event without replaying the entire queue.

Consumers should validate `type`, `aggregateId`, and required payload fields
before applying side effects. Validation failures should be treated as poison
events and should not be retried forever.

## Observability

Production metrics should include pending depth, oldest pending age, processing
lease count, delivery latency, retry count, terminal failures, and duplicate
acknowledgments. Logs should include event key, event type, aggregate ID,
attempt number, and request correlation ID when it is available. Payloads must
not include credentials or provider secrets.

## Compatibility and migration

Outbox production is additive to stream responses. Existing callers do not
need to consume events immediately. A persistent adapter should preserve the
record fields and uniqueness semantics, add an index on `(status,
nextAttemptAt)`, and retain event type versioning if payloads evolve.

The in-memory implementation can be replaced behind `outboxService` without
changing stream producers or the consumer callback. Reverting the feature
removes the handoff but does not alter stored stream shapes. A production
rollback must first drain or explicitly quarantine pending records so clients
do not assume notifications were delivered.

## Review checklist

- State is committed before an event is enqueued.
- Event keys are deterministic for the same transition.
- Event payloads are cloned and bounded.
- Healthy events continue after a poison failure.
- Backoff and attempts are finite.
- Delivered keys are not selected again.
- Abandoned processing claims can be recovered by a durable worker.
- Consumers have a deduplication strategy.
- Metrics expose pending age and terminal failures.
- Tests cover the crash window, retry, ordering, and end-to-end handoff.

## Consumer contract

Consumers should treat the event key as the idempotency identity, not the
delivery record ID. A redelivery may have the same key and a new attempt, while
the business transition remains one logical event. The recommended handling is:

1. Validate the event envelope and payload shape.
2. Check the processed-key store for `key`.
3. If the key is already complete, acknowledge without side effects.
4. Otherwise apply the side effect in a transaction.
5. Record the key as complete in the same transaction when possible.
6. Acknowledge only after both the side effect and key record succeed.

If the consumer cannot atomically record the side effect and key, it should use
an idempotent provider operation or a reconciliation ledger. A simple in-memory
boolean is not sufficient after a consumer restart.

## Ordering

Events for one aggregate are produced in transition order by the request path,
but independent workers may deliver them out of order. Consumers that require
ordering should compare the stream transition metadata or use a per-aggregate
partition. The outbox itself guarantees deduplication keys, not global ordering.

An event that arrives after a later state can be safely ignored only when the
consumer has a monotonic version or transition sequence. The current mock
payloads are intentionally small; a production schema should add such a
sequence before consumers depend on ordering.

## Repair procedure

An operator repairing a failed event should capture the event key, failure
message, attempts, and downstream response. The repair must be idempotent and
must not edit the original payload in place. If the payload is wrong, create a
new corrective event with a new key and retain the original failure for audit.

After repair, verify the downstream processed-key record, the stream state, and
the consumer acknowledgment. Do not reset all failed events as a shortcut; a
poison event can otherwise create a repeat incident.

## Capacity guardrails

The delivery worker accepts a per-run limit so a backlog cannot monopolize the
event loop. A production adapter should also cap payload size, enforce a queue
retention policy, and expose backpressure when pending depth exceeds the
configured budget. Increasing the limit should be an operational decision
backed by latency measurements, not a code path that bypasses isolation.

## Test evidence

The contract tests cover initial pending records, immutable deduplication,
successful delivery, redelivery suppression, retry timing, terminal failure,
poison isolation, delivery limits, status filtering, and payload cloning.
Integration tests should additionally exercise a process crash between the
state write and outbox write once a durable adapter exists.

The test suite should never disable the poison or retry cases simply because a
provider mock is slow. Those cases are the regression protection for the
original failure mode.

Reviewers should retain the test output in the PR so delivery guarantees are
visible alongside the implementation.

The final delivery decision belongs to the consumer transaction boundary. The
outbox guarantees a durable opportunity to deliver and a stable deduplication
identity; it cannot make a non-idempotent external system atomic by itself.

That limitation is explicit so deployment owners can choose the right durable
consumer strategy before enabling financial or accounting notifications.

For this repository, the documented in-memory boundary keeps local development
simple while preserving the contracts required by a future persistent worker.

Maintainers should not remove the state fields merely because the current
adapter is a Map; they are the compatibility surface for that replacement.

The resulting PR evidence covers both the current mock behavior and the
requirements a production persistence adapter must satisfy.

This keeps the implementation reviewable without overstating process-local
durability.

It is safe to migrate the record shape later because producers depend on this
contract rather than on the storage implementation.

Any adapter change should retain the unique event key and terminal states.

Consumers can then upgrade independently without changing delivery semantics.

That separation is the main reason the outbox record is versioned.

It protects both replay behavior and future schema evolution.

This boundary is covered by the outbox contract tests.

It should remain intact during future refactors.

Consumers can rely on the same deduplication identity.

This is part of the public event contract.

It must remain stable.
