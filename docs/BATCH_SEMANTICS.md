# Batch stream mutation semantics

`POST /api/streams/batch` is a partial-commit endpoint. It deliberately does
not pretend that several independent provider transactions form one atomic
ledger transaction. The API makes that boundary visible and gives callers the
information needed to reconcile a mixed result.

## Contract at a glance

| Property | Contract |
| --- | --- |
| Execution order | Items execute sequentially in the order received. |
| Atomicity | `partial`: a successful item is committed even if a later item fails. |
| Rollback | There is no cross-item rollback. Each item owns its own mutation. |
| Item identity | `index` and `itemCorrelationId` remain stable for a request shape. |
| Batch identity | `operationId` and `correlationId` identify the whole operation. |
| Retry key | `Idempotency-Key` binds retries to one normalized request. |
| Success retry | A previously successful item is returned from the operation record and is not submitted again. |
| Failed retry | A failed item may be attempted again; previously successful items remain untouched. |
| Error shape | Every failed item includes `message`, machine-readable `code`, and `statusCode`. |
| Duplicate IDs | Rejected during validation before any provider call. |

## Why partial commit is explicit

Withdraw and cancel actions are separate provider operations. The backend can
serialize them and report their local state transitions, but it cannot turn a
set of separate external transactions into one all-or-nothing transaction.
Calling the endpoint atomic would make a failed later item look like an
instruction to reverse earlier ledger work, which is unsafe.

The partial contract gives a caller two useful facts:

1. Every `ok: true` item has a committed local state transition and an event
   payload associated with that transition.
2. Every `ok: false` item has an actionable error and can be retried without
   replaying the successful items in the same request.

The top-level `succeeded`, `failed`, and `retryableFailures` counts are derived
from the returned item list. The list is always in input order, including when
some items fail.

## Correlation IDs

The server generates an `operationId` such as `batch_550e8400-e29b-41d4-a716-
446655440000`. `correlationId` is an alias for this value at the response
level, so clients can use either conventional name in logs and tracing.

Each item receives `batch-id:item:N`, where `N` is one-based. The item ID does
not depend on a stream's mutable state or on a transaction hash. It therefore
remains useful when comparing the original response with a replay response.

For example, a three-item request always has item IDs ending in `:item:1`,
`:item:2`, and `:item:3`, even if the second item fails. The `index` field uses
zero-based indexing for direct array correlation.

## Idempotency-Key behavior

Clients should generate one stable key for one logical batch and send it with
every retry. Keys are trimmed and limited to 128 characters. An empty key is
treated as absent; an overlong key is rejected before provider work begins.

The in-memory store records the key, the normalized request fingerprint, the
operation ID, and each item outcome. Reusing a key with a different item list,
action, order, or amount returns `409 CONFLICT`. This prevents a caller from
accidentally attaching a new business operation to an old retry record.

The first request processes every item in order. It saves each outcome after
the item finishes, rather than waiting for the whole batch. If the request is
repeated after a response was returned, successful outcomes are replayed from
the record and no provider call is made for those items.

Failed outcomes are retained for diagnostics but are eligible for another
attempt. This is important for transient provider failures: a retry can make
progress on the failed item while still protecting successful items from
duplicate release or refund calls. A retry response sets `replayed` to false
when it had to execute at least one failed item.

Concurrent requests using the same key are serialized by the store. The first
request creates the operation record and the second request waits. After the
first request commits its success, the second request reads and replays that
success instead of entering the provider again.

This implementation's record is process-local because the repository uses an
in-memory store. A production deployment must persist the operation record and
item outcomes in a shared database or idempotency service before relying on
the contract across workers or restarts.

## Error handling

Errors remain item-scoped and use the same stable codes as direct mutation
endpoints:

| Situation | Code | Retry guidance |
| --- | --- | --- |
| Stream does not exist | `NOT_FOUND` | Correct the item; retrying unchanged will fail again. |
| Stream is already terminal | `CONFLICT` | Refresh state; do not retry as a new mutation. |
| Nothing is withdrawable | `BAD_REQUEST` | Wait for vesting or adjust the request. |
| Provider or unexpected service failure | `INTERNAL_ERROR` or service code | Retry with the same key after checking provider status. |
| Key reused for another request | `CONFLICT` | Generate a new key only for the genuinely new request. |

The server always continues to the next item after an item-scoped failure.
Validation errors are different: malformed batches, unsupported actions,
duplicate stream IDs, and invalid amounts reject the entire request before any
item is executed. This prevents a request from having a partially applied
interpretation of malformed input.

## Ordering and duplicate protection

The validator trims stream IDs before producing the cleaned request. It rejects
the same cleaned ID more than once, even when the actions differ. For example,
one request cannot withdraw and then cancel the same stream in a chosen order.
That restriction removes an otherwise confusing dependency on which action
happened to run first.

Distinct streams execute in array order. This makes provider call order,
outbox order, response order, and retry reconciliation deterministic. The
service does not use `Promise.all` for item execution because parallel calls
would make partial failure ordering and accounting harder to explain.

## Rollback boundary

An individual stream transition follows the existing provider-then-local-write
sequence. If the provider rejects before returning a transaction, the stream
record and its outbox event remain unchanged. The next batch item can still
run. If the provider commits but the process fails before the local write, the
provider transaction identity must be reconciled by the production adapter;
the in-memory mock cannot provide crash recovery.

Consequently, a caller should reconcile the `results` array, not infer state
from the top-level HTTP status alone. For every success, retain the returned
transaction hash and item correlation ID. For every failure, retain the error
code and retry the same key only when the error is operationally retryable.

## Client algorithm

1. Build and validate the complete ordered update list.
2. Generate one idempotency key for the logical batch.
3. Submit the list with the `Idempotency-Key` header.
4. Persist `operationId`, every item correlation ID, transaction hash, and
   outcome.
5. On a timeout or transient failure, repeat the identical request and key.
6. Treat successful replayed items as already committed.
7. Investigate non-retryable item codes instead of changing the request under
   the old key.

Do not generate a new key merely because the HTTP response was lost. A new key
would intentionally create a new operation and could submit the same provider
mutation again.

## Test coverage

`test/batchSemantics.test.js` covers:

- mixed success and failure with stable order and correlation IDs;
- duplicate-ID rejection before item execution;
- no provider repetition for a fully successful replay;
- retrying a failed item while preserving an earlier success;
- concurrent same-key requests and operation-level serialization;
- key fingerprint conflicts;
- provider failure without rolling back a prior successful item; and
- idempotency-key length validation before provider work.

The existing batch service and validator tests remain in place. Together they
cover the prior per-item behavior as well as the new explicit contract.
