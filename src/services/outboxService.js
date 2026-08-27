'use strict';

const store = require('../store');
const { newTxHash } = require('../utils/ids');

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;

/**
 * In-memory durable-handoff boundary for this mock backend. A real adapter can
 * replace the Maps with a database table while retaining the same state
 * machine: pending -> processing -> delivered, with failed retries.
 */
function enqueue({ key, type, aggregateId, payload }) {
  const existing = store.outbox.get(key);
  if (existing) return existing;
  const event = {
    id: newTxHash(),
    key,
    type,
    aggregateId,
    payload: JSON.parse(JSON.stringify(payload)),
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    nextAttemptAt: Date.now(),
    deliveredAt: null,
    lastError: null,
  };
  store.outbox.set(key, event);
  return event;
}

function list({ status } = {}) {
  return Array.from(store.outbox.values()).filter((event) => !status || event.status === status);
}

/** Deliver at most `limit` ready events, isolating poison events. */
async function deliverPending(publish, { now = Date.now(), limit = 100 } = {}) {
  const delivered = [];
  const failed = [];
  const ready = list({ status: 'pending' })
    .filter((event) => event.nextAttemptAt <= now)
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 100)));

  for (const event of ready) {
    event.status = 'processing';
    event.attempts += 1;
    try {
      await publish(event);
      event.status = 'delivered';
      event.deliveredAt = new Date(now).toISOString();
      event.lastError = null;
      store.deliveredEvents.set(event.key, event);
      delivered.push(event);
    } catch (error) {
      event.lastError = String(error.message || error);
      if (event.attempts >= MAX_ATTEMPTS) {
        event.status = 'failed';
      } else {
        event.status = 'pending';
        event.nextAttemptAt = now + BASE_BACKOFF_MS * (2 ** (event.attempts - 1));
      }
      failed.push(event);
    }
  }
  return { delivered, failed };
}

module.exports = { enqueue, list, deliverPending, MAX_ATTEMPTS, BASE_BACKOFF_MS };
