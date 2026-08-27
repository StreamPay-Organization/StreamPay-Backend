# Vesting math property contract

This document describes the invariants enforced by the streaming projection
tests. It is deliberately written as a contract for future changes: a new
vesting rule must either preserve these properties or document why the rule
changes the accounting model.

## Model

A stream has a funded `total` amount and a time window `[startTime, endTime]`.
For a valid, non-empty window, the projected amount is the linear interpolation
between zero at `startTime` and `total` at `endTime`. Values outside that
window are clamped to the nearest boundary. The implementation performs the
interpolation in Stellar's seven-decimal smallest units and converts back to
asset units only at the API boundary.

The integer-unit rule is important. Repeated binary floating-point operations
can otherwise produce a value which is a fraction of a smallest unit, or make
an apparently later projection differ from an earlier projection by a unit.
The property suite covers tiny amounts, large amounts, awkward durations, and
timestamps on both sides of the window.

## Required invariants

### Bounds

For every valid stream and every timestamp `t`:

```text
0 <= streamed(t) <= total
0 <= withdrawable(t) <= streamed(t)
0 <= locked(t) <= total
0 <= progress(t) <= 1
remainingSeconds(t) >= 0
```

All five values must be finite. A provider or system clock failure must not
turn a response into JSON `null` through an intermediate `NaN`.

### Monotonicity

If `t1 <= t2`, then `streamed(t1) <= streamed(t2)` and
`locked(t2) <= locked(t1)`. This remains true when timestamps are generated
out of order; `vestingProjection` preserves the caller's order and each point
is evaluated independently.

### Lifecycle accounting

For an active stream whose `withdrawn` value is not greater than the amount
already streamed:

```text
withdrawn + withdrawable(t) + locked(t) == total
```

The equality is evaluated at seven-decimal precision. A cancelled stream has
no locked balance because its unstreamed remainder has been refunded. A
completed stream has no withdrawable or locked balance because the total has
already been withdrawn.

### Clock anomalies

The pure math functions accept a timestamp supplied by a caller, so they must
be safe when that value is missing or malformed:

- `NaN`, `undefined`, `null`, and non-numeric strings map to `startTime`.
- `-Infinity` maps to `startTime`.
- `Infinity` maps to `endTime`.

Malformed stream boundaries are also normalized to a finite degenerate window
at zero. This is a defensive boundary for reporting code; request validation
still rejects malformed create requests.

## Test strategy

`test/streamMath.property.test.js` uses a deterministic linear-congruential
generator. It generates hundreds of streams with valid totals, durations and
start times, then checks timestamp samples before, inside and after each
window. There is no random state shared between tests, so a failure can be
replayed from the seed printed in the test source and the case description
includes the generated stream and timestamp.

The suite also contains focused regression fixtures for:

- timestamps immediately before and far after a stream;
- seven-decimal totals and sub-unit interpolation;
- zero-length windows;
- partial withdrawals and an already-settled stream;
- cancelled-stream refund semantics;
- invalid clock and boundary values;
- projection order and deterministic repeated calls.

When adding a production regression, prefer a small fixed fixture in the
regression section and add the same shape to the generated property when the
failure represents a general invariant. Do not weaken a property assertion to
make a failing implementation pass.

## Running the contract

Run the complete repository suite with:

```bash
npm test
```

The property tests intentionally use the built-in Node test runner and no
network service. They should run in CI alongside the existing unit tests and
should remain deterministic across machines and time zones.
