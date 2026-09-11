import { FailureCategory, PrintState } from '@printok/shared-types';

/**
 * Failure classification and stale-job recovery (PRD 12, 13).
 *
 * The governing rule comes from PRD 11: where the printer's state is ambiguous,
 * prefer controlled human resolution over blindly printing again. A job that was
 * claimed but never started can be safely returned to the queue. A job that was
 * already being printed when the agent disappeared may or may not have produced
 * physical paper, and no amount of backend logic can tell which — so it goes to
 * a human rather than being reprinted at the customer's expense.
 */

/** An agent claimed the job but never reported progress. Nothing was printed. */
export const ASSIGNED_STALE_MS = 5 * 60 * 1000;

/** The agent was fetching the document. Still safe to retry. */
export const DOWNLOADING_STALE_MS = 10 * 60 * 1000;

/**
 * The agent had already handed pages to the spooler. Whether paper came out is
 * unknowable from here, so this is escalated, never requeued.
 */
export const PRINTING_STALE_MS = 20 * 60 * 1000;

/** States a stale job can be safely returned to the queue from. */
export const SAFELY_REQUEUEABLE: ReadonlySet<PrintState> = new Set([
  PrintState.Assigned,
  PrintState.Downloading,
]);

/** States where a stall is ambiguous and must go to a human. */
export const AMBIGUOUS_ON_STALL: ReadonlySet<PrintState> = new Set([
  PrintState.Printing,
]);

export function staleThresholdFor(state: PrintState): number | undefined {
  switch (state) {
    case PrintState.Assigned:
      return ASSIGNED_STALE_MS;
    case PrintState.Downloading:
      return DOWNLOADING_STALE_MS;
    case PrintState.Printing:
      return PRINTING_STALE_MS;
    default:
      return undefined;
  }
}

/**
 * Whether a job has been sitting in a transient state long enough to be
 * considered abandoned by its agent.
 */
export function isStale(state: PrintState, since: Date | undefined, now: Date): boolean {
  const threshold = staleThresholdFor(state);
  if (threshold === undefined || !since) return false;
  return now.getTime() - since.getTime() >= threshold;
}

/**
 * Decides what to do with an abandoned job.
 *
 * Requeue only when the work demonstrably never reached paper and the job has
 * retries left. Everything else is escalated so a person decides, which is the
 * only safe answer when reprinting could double-charge or double-print.
 */
export function recoveryActionFor(
  state: PrintState,
  attemptCount: number,
  maxAttempts: number
): { action: 'requeue' | 'escalate'; reason: string } {
  if (AMBIGUOUS_ON_STALL.has(state)) {
    return {
      action: 'escalate',
      reason:
        'The agent stopped responding while printing. Whether the document reached paper ' +
        'cannot be determined automatically, so a person must confirm before any reprint.',
    };
  }

  if (!SAFELY_REQUEUEABLE.has(state)) {
    return { action: 'escalate', reason: `State ${state} cannot be recovered automatically.` };
  }

  if (attemptCount >= maxAttempts) {
    return {
      action: 'escalate',
      reason: `Job failed ${attemptCount} times (limit ${maxAttempts}). Escalating instead of retrying again.`,
    };
  }

  return {
    action: 'requeue',
    reason: `Agent abandoned the job in ${state} without printing. Returning it to the queue.`,
  };
}

/**
 * Classifies a failure so the right person is asked to fix it (PRD 12).
 *
 * Matching is on the agent's own error text, which is why the patterns are
 * deliberately broad; an unrecognised failure is treated as platform-owned
 * rather than blamed on the customer or the shop.
 */
export function classifyFailure(errorMessage?: string): FailureCategory {
  const text = (errorMessage || '').toLowerCase();

  if (!text) return FailureCategory.PlatformResolvable;

  // The customer supplied something we cannot print.
  if (
    text.includes('unsupported') ||
    text.includes('corrupt') ||
    text.includes('password') ||
    text.includes('encrypted') ||
    text.includes('invalid page range') ||
    text.includes('checksum')
  ) {
    return FailureCategory.CustomerResolvable;
  }

  // Something physical at the shop needs attention.
  if (
    text.includes('paper') ||
    text.includes('jam') ||
    text.includes('toner') ||
    text.includes('ink') ||
    text.includes('offline') ||
    text.includes('printer not found') ||
    text.includes('no application is registered') ||
    text.includes('spooler')
  ) {
    return FailureCategory.ShopResolvable;
  }

  // Ambiguity about physical output is never auto-resolved.
  if (text.includes('ambiguous') || text.includes('partially printed')) {
    return FailureCategory.SafetyCritical;
  }

  return FailureCategory.PlatformResolvable;
}
