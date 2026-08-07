// Detached work, made observable.
//
// Two paths deliberately do not block their caller: invoice intake (a webhook
// must not wait on a fourteen-second vision call) and the inbound-email sweep
// nudge (latency only — the interval sweep is the guarantee). Both are correct
// designs and neither changes here.
//
// What they lacked was any way to ask "is anything still running?". Without it
// a test would finish, the next one would truncate the database, and the
// previous test's work would still be executing against tables vanishing
// underneath it. That produced failures that looked like several different
// bugs — deadlocks one run, wrong row states the next — because the collision
// landed somewhere new each time. The software was fine; the harness was
// measuring a race.
//
// Production never calls drain. It exists so tests can be honest.
const inFlight = new Set<Promise<unknown>>();

/** Register detached work so tests can wait for it. Never blocks the caller. */
export function trackBackgroundWork(work: Promise<unknown>): void {
  inFlight.add(work);
  void work.catch(() => {}).finally(() => inFlight.delete(work));
}

/**
 * Resolve once all registered work has settled. Loops, because finishing one
 * piece of work can start another.
 */
export async function drainBackgroundWork(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}
