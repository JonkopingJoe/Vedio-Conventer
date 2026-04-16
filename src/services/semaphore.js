'use strict';

/**
 * Promise-based counting semaphore.
 * Limits the number of FFmpeg processes that can run simultaneously.
 * Callers await acquire() before starting a conversion and call
 * release() when done (in a finally block).
 */

const MAX = parseInt(process.env.MAX_CONCURRENT_JOBS || '3', 10);

let running = 0;
const waiters = []; // resolve callbacks of pending acquire() calls

function acquire() {
  return new Promise((resolve) => {
    if (running < MAX) {
      running++;
      return resolve();
    }
    waiters.push(resolve);
  });
}

function release() {
  if (waiters.length > 0) {
    // Hand the slot directly to the next waiter — running count stays the same
    const next = waiters.shift();
    next();
  } else {
    running--;
  }
}

/** How many callers are currently waiting for a slot. */
function pendingCount() {
  return waiters.length;
}

/** How many slots are actively in use. */
function activeCount() {
  return running;
}

module.exports = { acquire, release, pendingCount, activeCount };
