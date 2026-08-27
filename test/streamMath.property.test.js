'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const streamMath = require('../src/services/streamMath');
const money = require('../src/utils/money');
const { STREAM_STATUS } = require('../src/constants/streamStatus');

/*
 * This file intentionally uses a small local generator instead of a third-
 * party property-testing package. The test suite must remain runnable with
 * the repository's documented `npm test` command and without downloading a
 * mutable generator version in CI.
 */
class DeterministicRandom {
  constructor(seed) {
    this.seed = seed >>> 0;
  }

  next() {
    // Numerical Recipes LCG: deterministic on every supported Node version.
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  integer(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick(values) {
    return values[this.integer(0, values.length - 1)];
  }
}

const UNIT_FACTOR = 10 ** money.DECIMALS;
const BASE_TIME = 1_700_000_000;
const MAX_DURATION = 10 * 365 * 24 * 3600;

function generatedStream(random, index) {
  const startTime = BASE_TIME + random.integer(-365 * 24 * 3600, 365 * 24 * 3600);
  const duration = random.integer(60, MAX_DURATION);
  const totalUnits = random.integer(1, 5_000_000_000);
  return {
    id: `stream_property_${index}`,
    total: totalUnits / UNIT_FACTOR,
    startTime,
    endTime: startTime + duration,
    withdrawn: 0,
    status: STREAM_STATUS.ACTIVE,
  };
}

function timestampSamples(stream, random) {
  const { startTime, endTime } = stream;
  const duration = endTime - startTime;
  const samples = [
    startTime - duration - 1,
    startTime - 1,
    startTime,
    startTime + 1,
    startTime + duration / 4,
    startTime + duration / 2,
    startTime + (duration * 3) / 4,
    endTime - 1,
    endTime,
    endTime + 1,
    endTime + duration + 1,
  ];

  for (let i = 0; i < 9; i += 1) {
    samples.push(startTime + random.integer(-duration, duration * 2));
  }
  return samples;
}

function describe(stream, time) {
  return JSON.stringify({
    id: stream.id,
    total: stream.total,
    startTime: stream.startTime,
    endTime: stream.endTime,
    withdrawn: stream.withdrawn,
    status: stream.status,
    time,
  });
}

function assertProperty(condition, message, stream, time) {
  assert.ok(condition, `${message}; case=${describe(stream, time)}`);
}

function runWithSeed(seed, count, property) {
  const random = new DeterministicRandom(seed);
  for (let index = 0; index < count; index += 1) {
    const stream = generatedStream(random, index);
    const times = timestampSamples(stream, random);
    property(stream, times, random, index);
  }
}

function roundedEqual(left, right) {
  return money.round(left) === money.round(right);
}

test('generated valid streams always start with a zero projection and end at total', () => {
  runWithSeed(0x77a11ce, 750, (stream) => {
    assert.equal(streamMath.streamedAmount(stream, stream.startTime), 0, describe(stream, stream.startTime));
    assert.equal(
      streamMath.streamedAmount(stream, stream.endTime),
      stream.total,
      describe(stream, stream.endTime),
    );
  });
});

test('streamed amount is monotonic over generated timestamp sequences', () => {
  runWithSeed(0x77b01, 600, (stream, times) => {
    const sorted = [...times].sort((a, b) => a - b);
    let previous = 0;
    for (const time of sorted) {
      const current = streamMath.streamedAmount(stream, time);
      assertProperty(current >= previous, 'streamed amount moved backwards', stream, time);
      previous = current;
    }
  });
});

test('streamed amount is always bounded by the funded total', () => {
  runWithSeed(0x77b02, 600, (stream, times) => {
    for (const time of times) {
      const streamed = streamMath.streamedAmount(stream, time);
      assertProperty(streamed >= 0, 'streamed amount was negative', stream, time);
      assertProperty(streamed <= stream.total, 'streamed amount exceeded total', stream, time);
      assertProperty(Number.isFinite(streamed), 'streamed amount was not finite', stream, time);
    }
  });
});

test('generated projection points agree with direct evaluation', () => {
  runWithSeed(0x77b03, 500, (stream, times) => {
    const projection = streamMath.vestingProjection(stream, times);
    assert.equal(projection.length, times.length, describe(stream, times[0]));
    projection.forEach((point, index) => {
      assert.equal(point.time, times[index], describe(stream, point.time));
      assert.equal(
        point.streamed,
        streamMath.streamedAmount(stream, point.time),
        describe(stream, point.time),
      );
    });
  });
});

test('progress is bounded and agrees with stream boundary behavior', () => {
  runWithSeed(0x77b04, 600, (stream, times) => {
    assert.equal(streamMath.progress(stream, stream.startTime - 1), 0, describe(stream, stream.startTime - 1));
    assert.equal(streamMath.progress(stream, stream.endTime + 1), 1, describe(stream, stream.endTime + 1));
    for (const time of times) {
      const progress = streamMath.progress(stream, time);
      assertProperty(progress >= 0 && progress <= 1, 'progress left [0, 1]', stream, time);
      assertProperty(Number.isFinite(progress), 'progress was not finite', stream, time);
    }
  });
});

test('withdrawable plus withdrawn plus locked conserves the funded total', () => {
  runWithSeed(0x77b05, 600, (stream, times, random) => {
    for (const time of times) {
      const streamed = streamMath.streamedAmount(stream, time);
      const streamedUnits = Math.round(streamed * UNIT_FACTOR);
      stream.withdrawn = random.integer(0, streamedUnits) / UNIT_FACTOR;
      const withdrawn = money.round(stream.withdrawn);
      const withdrawable = streamMath.withdrawableAmount(stream, time);
      const locked = streamMath.lockedAmount(stream, time);
      assertProperty(
        roundedEqual(withdrawn + withdrawable + locked, stream.total),
        'active balance did not conserve total',
        stream,
        time,
      );
      assertProperty(withdrawable >= 0, 'withdrawable amount was negative', stream, time);
      assertProperty(locked >= 0, 'locked amount was negative', stream, time);
    }
  });
});

test('withdrawable never exceeds the streamed amount after partial withdrawals', () => {
  runWithSeed(0x77b06, 600, (stream, times, random) => {
    for (const time of times) {
      const streamed = streamMath.streamedAmount(stream, time);
      stream.withdrawn = random.integer(0, Math.round(streamed * UNIT_FACTOR)) / UNIT_FACTOR;
      const withdrawable = streamMath.withdrawableAmount(stream, time);
      assertProperty(withdrawable <= streamed, 'withdrawable exceeded streamed', stream, time);
      assertProperty(withdrawable >= 0, 'withdrawable was negative', stream, time);
    }
  });
});

test('remaining time is non-negative and reaches zero at the end', () => {
  runWithSeed(0x77b07, 600, (stream, times) => {
    assert.equal(streamMath.remainingSeconds(stream, stream.endTime), 0, describe(stream, stream.endTime));
    for (const time of times) {
      const remaining = streamMath.remainingSeconds(stream, time);
      assertProperty(remaining >= 0, 'remaining seconds was negative', stream, time);
      assertProperty(Number.isFinite(remaining), 'remaining seconds was not finite', stream, time);
    }
  });
});

test('time moving forward cannot increase the locked amount', () => {
  runWithSeed(0x77b08, 600, (stream) => {
    const times = [
      stream.startTime - 1,
      stream.startTime,
      stream.startTime + (stream.endTime - stream.startTime) / 3,
      stream.startTime + ((stream.endTime - stream.startTime) * 2) / 3,
      stream.endTime,
      stream.endTime + 1,
    ];
    let previous = stream.total;
    for (const time of times) {
      const locked = streamMath.lockedAmount(stream, time);
      assertProperty(locked <= previous, 'locked amount increased', stream, time);
      previous = locked;
    }
  });
});

test('all generated timestamps are safe to use in projection APIs', () => {
  runWithSeed(0x77b09, 500, (stream) => {
    const values = [NaN, Infinity, -Infinity, undefined, null, 'not-a-time'];
    for (const value of values) {
      const streamed = streamMath.streamedAmount(stream, value);
      const progress = streamMath.progress(stream, value);
      const remaining = streamMath.remainingSeconds(stream, value);
      assert.equal(Number.isFinite(streamed), true, `${value} streamed ${describe(stream, value)}`);
      assert.equal(Number.isFinite(progress), true, `${value} progress ${describe(stream, value)}`);
      assert.equal(Number.isFinite(remaining), true, `${value} remaining ${describe(stream, value)}`);
      assert.equal(streamed >= 0 && streamed <= stream.total, true, `${value} bounds ${describe(stream, value)}`);
    }
  });
});

test('explicit infinite clock sentinels resolve to stream boundaries', () => {
  runWithSeed(0x77a0a, 300, (stream) => {
    assert.equal(streamMath.streamedAmount(stream, -Infinity), 0, describe(stream, -Infinity));
    assert.equal(streamMath.streamedAmount(stream, Infinity), stream.total, describe(stream, Infinity));
    assert.equal(streamMath.progress(stream, -Infinity), 0, describe(stream, -Infinity));
    assert.equal(streamMath.progress(stream, Infinity), 1, describe(stream, Infinity));
    assert.equal(streamMath.remainingSeconds(stream, Infinity), 0, describe(stream, Infinity));
  });
});

test('fractional asset totals use smallest-unit interpolation', () => {
  const stream = {
    total: 0.0000003,
    startTime: 100,
    endTime: 103,
    withdrawn: 0,
    status: STREAM_STATUS.ACTIVE,
  };
  assert.equal(streamMath.streamedAmount(stream, 100), 0);
  assert.equal(streamMath.streamedAmount(stream, 101), 0.0000001);
  assert.equal(streamMath.streamedAmount(stream, 102), 0.0000002);
  assert.equal(streamMath.streamedAmount(stream, 103), 0.0000003);
});

test('repeated calls are deterministic for the same stream and time', () => {
  runWithSeed(0x77a0b, 500, (stream, times) => {
    for (const time of times) {
      const first = {
        streamed: streamMath.streamedAmount(stream, time),
        withdrawable: streamMath.withdrawableAmount(stream, time),
        locked: streamMath.lockedAmount(stream, time),
        progress: streamMath.progress(stream, time),
        remaining: streamMath.remainingSeconds(stream, time),
      };
      const second = {
        streamed: streamMath.streamedAmount(stream, time),
        withdrawable: streamMath.withdrawableAmount(stream, time),
        locked: streamMath.lockedAmount(stream, time),
        progress: streamMath.progress(stream, time),
        remaining: streamMath.remainingSeconds(stream, time),
      };
      assert.deepEqual(second, first, describe(stream, time));
    }
  });
});

test('projection preserves caller order for chart consumers', () => {
  const stream = {
    total: 100,
    startTime: 10,
    endTime: 110,
    withdrawn: 0,
    status: STREAM_STATUS.ACTIVE,
  };
  const times = [110, 10, 60, 0];
  assert.deepEqual(streamMath.vestingProjection(stream, times), [
    { time: 110, streamed: 100 },
    { time: 10, streamed: 0 },
    { time: 60, streamed: 50 },
    { time: 0, streamed: 0 },
  ]);
});

test('zero-length windows have explicit boundary semantics', () => {
  const stream = {
    total: 12.3456789,
    startTime: 100,
    endTime: 100,
    withdrawn: 0,
    status: STREAM_STATUS.ACTIVE,
  };
  assert.equal(streamMath.streamedAmount(stream, 99), 0);
  assert.equal(streamMath.streamedAmount(stream, 100), stream.total);
  assert.equal(streamMath.streamedAmount(stream, 101), stream.total);
  assert.equal(streamMath.progress(stream, 99), 0);
  assert.equal(streamMath.progress(stream, 100), 1);
  assert.equal(streamMath.remainingSeconds(stream, 99), 1);
  assert.equal(streamMath.remainingSeconds(stream, 100), 0);
});

test('cancelled streams release the locked remainder without reporting a lock', () => {
  runWithSeed(0x77a0c, 500, (stream, times, random) => {
    stream.status = STREAM_STATUS.CANCELLED;
    for (const time of times) {
      const streamed = streamMath.streamedAmount(stream, time);
      stream.withdrawn = random.integer(0, Math.round(streamed * UNIT_FACTOR)) / UNIT_FACTOR;
      assert.equal(streamMath.lockedAmount(stream, time), 0, describe(stream, time));
      assertProperty(
        streamMath.withdrawableAmount(stream, time) <= streamed,
        'cancelled withdrawable exceeded streamed',
        stream,
        time,
      );
    }
  });
});

test('completed streams retain a bounded final balance view', () => {
  runWithSeed(0x77a0d, 400, (stream, times) => {
    stream.status = STREAM_STATUS.COMPLETED;
    stream.withdrawn = stream.total;
    for (const time of times) {
      assert.equal(streamMath.withdrawableAmount(stream, time), 0, describe(stream, time));
      assert.equal(streamMath.lockedAmount(stream, time), 0, describe(stream, time));
    }
  });
});

test('regression: a timestamp before start never produces a negative amount', () => {
  const stream = {
    total: 999999.9999999,
    startTime: 2_000_000_000,
    endTime: 2_000_000_060,
    withdrawn: 0,
    status: STREAM_STATUS.ACTIVE,
  };
  assert.equal(streamMath.streamedAmount(stream, 1_999_999_999), 0);
  assert.equal(streamMath.withdrawableAmount(stream, 1_999_999_999), 0);
  assert.equal(streamMath.lockedAmount(stream, 1_999_999_999), stream.total);
});

test('regression: a timestamp after end never releases more than total', () => {
  const stream = {
    total: 123.4567891,
    startTime: 10,
    endTime: 70,
    withdrawn: 0,
    status: STREAM_STATUS.ACTIVE,
  };
  assert.equal(streamMath.streamedAmount(stream, 70 + Number.MAX_SAFE_INTEGER), stream.total);
  assert.equal(streamMath.withdrawableAmount(stream, 70 + Number.MAX_SAFE_INTEGER), stream.total);
  assert.equal(streamMath.lockedAmount(stream, 70 + Number.MAX_SAFE_INTEGER), 0);
});

test('regression: a withdrawn amount cannot make withdrawable negative', () => {
  const stream = {
    total: 10,
    startTime: 0,
    endTime: 100,
    withdrawn: 10,
    status: STREAM_STATUS.ACTIVE,
  };
  assert.equal(streamMath.withdrawableAmount(stream, 50), 0);
  assert.equal(streamMath.withdrawableAmount(stream, 100), 0);
});

test('regression: an invalid stream shape returns finite bounded projections', () => {
  const stream = {
    total: 10,
    startTime: 'not-a-time',
    endTime: NaN,
    withdrawn: 0,
    status: STREAM_STATUS.ACTIVE,
  };
  assert.equal(streamMath.streamedAmount(stream, 100), 10);
  assert.equal(streamMath.progress(stream, 100), 1);
  assert.equal(streamMath.remainingSeconds(stream, 100), 0);
});

test('generator seeds remain reproducible for future counterexamples', () => {
  const seed = 0x12345678;
  const first = [];
  const second = [];
  const one = new DeterministicRandom(seed);
  const two = new DeterministicRandom(seed);
  for (let index = 0; index < 50; index += 1) {
    first.push(generatedStream(one, index));
    second.push(generatedStream(two, index));
  }
  assert.deepEqual(second, first);
});

test('unit conversion round-trips supported monetary precision', () => {
  runWithSeed(0x77a0e, 500, (stream) => {
    const units = streamMath.amountToUnits(stream.total);
    assert.equal(streamMath.unitsToAmount(units), stream.total, describe(stream, 0));
  });
});

test('safeTime maps every supported clock anomaly to a finite boundary', () => {
  const start = 100;
  const end = 200;
  assert.equal(streamMath.safeTime(NaN, start, end), start);
  assert.equal(streamMath.safeTime(undefined, start, end), start);
  assert.equal(streamMath.safeTime(null, start, end), start);
  assert.equal(streamMath.safeTime('bad', start, end), start);
  assert.equal(streamMath.safeTime(-Infinity, start, end), start);
  assert.equal(streamMath.safeTime(Infinity, start, end), end);
  assert.equal(streamMath.safeTime(150, start, end), 150);
});
