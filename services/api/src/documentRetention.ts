import { PrintState } from '@printok/shared-types';
import { UNPAID_RESTING_STATES, PAID_RESTING_STATES } from './jobStateMachine';

/**
 * How long a customer's document is kept once its job has stopped moving.
 *
 * Two windows, not one, because a single figure is wrong in one direction or
 * the other:
 *
 *   * An **unpaid** job holds a document nobody has bought. The customer
 *     uploaded a file and left. A short window here is pure privacy gain — the
 *     only cost is a customer who wanders back after hours and has to upload
 *     again.
 *
 *   * A **paid** job holds a document the shop owes the customer. Purging it on
 *     a short timer means a counter PC switched off overnight, or a job the shop
 *     has not released yet, loses the file it was paid to print. The customer is
 *     then out of pocket with nothing to collect, which is worse for them than
 *     the retention is.
 *
 * PRD 15 states a ~10 minute target. That figure is right for the case it was
 * written about — a document whose job has finished printing, which is purged
 * on the state transition itself and never waits for this sweep at all. Applied
 * to a paid job still waiting for a printer it would destroy deliverable work,
 * so it is deliberately not used as a single global window here.
 *
 * Both are overridable, so retention can be tightened without a deploy.
 */
export const UNPAID_RETENTION_MINUTES =
  Number(process.env.DOCUMENT_RETENTION_UNPAID_MINUTES) || 120;

export const PAID_RETENTION_HOURS =
  Number(process.env.DOCUMENT_RETENTION_PAID_HOURS) || 168; // 7 days

/**
 * Whether a resting job's document is past its window.
 *
 * States that are still in flight — Assigned, Downloading, Printing — are in
 * neither set and so never expire here; `reclaimStaleJobs` owns those, and
 * sweeping them by age as well would fight it. Terminal states are also absent,
 * because their documents are purged on the transition that made them terminal.
 */
export function isDocumentExpired(
  printState: PrintState | string,
  createdAtIso: string,
  now: Date = new Date()
): boolean {
  const createdAt = new Date(createdAtIso).getTime();
  if (!Number.isFinite(createdAt)) return false;

  const ageMs = now.getTime() - createdAt;
  const state = printState as PrintState;

  if (UNPAID_RESTING_STATES.has(state)) {
    return ageMs > UNPAID_RETENTION_MINUTES * 60_000;
  }

  if (PAID_RESTING_STATES.has(state)) {
    return ageMs > PAID_RETENTION_HOURS * 3_600_000;
  }

  return false;
}

/** The oldest creation time that is still inside each window, for a DB query. */
export function retentionCutoffs(now: Date = new Date()): {
  unpaidBefore: Date;
  paidBefore: Date;
} {
  return {
    unpaidBefore: new Date(now.getTime() - UNPAID_RETENTION_MINUTES * 60_000),
    paidBefore: new Date(now.getTime() - PAID_RETENTION_HOURS * 3_600_000),
  };
}
