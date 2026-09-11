import { PaymentState, PrintState } from '@printok/shared-types';

/**
 * Job state machine (PRD 10).
 *
 * Payment state and print state are deliberately independent: a paid job is not
 * a printed job, and printing never implies payment. Each has its own transition
 * table, and neither is derived from the other.
 *
 * Transitions are validated centrally so that an agent, a webhook and an admin
 * action cannot each invent their own idea of a legal move.
 */

/** Print states from which no further transition is allowed. */
export const TERMINAL_PRINT_STATES: ReadonlySet<PrintState> = new Set([
  PrintState.Completed,
  PrintState.Cancelled,
]);

/** Print states that need a human before the job can move on (PRD 12). */
export const HELD_PRINT_STATES: ReadonlySet<PrintState> = new Set([
  PrintState.RequiresShopAction,
  PrintState.RefundReview,
]);

/**
 * States in which the stored document is still needed. Anything outside this set
 * is eligible for document purge (PRD 15).
 */
export const DOCUMENT_REQUIRED_STATES: ReadonlySet<PrintState> = new Set([
  PrintState.Created,
  PrintState.AwaitingPayment,
  PrintState.Queued,
  PrintState.Assigned,
  PrintState.Downloading,
  PrintState.Printing,
  PrintState.RequiresShopAction,
]);

const PRINT_TRANSITIONS: Readonly<Record<PrintState, readonly PrintState[]>> = {
  [PrintState.Created]: [
    PrintState.AwaitingPayment,
    PrintState.Queued,
    PrintState.Cancelled,
    PrintState.Failed,
  ],
  [PrintState.AwaitingPayment]: [
    PrintState.Queued,
    PrintState.Cancelled,
    PrintState.Failed,
  ],
  [PrintState.Queued]: [
    PrintState.Assigned,
    // An agent may report Downloading without a distinct assignment step.
    PrintState.Downloading,
    PrintState.Printing,
    PrintState.Cancelled,
    PrintState.Failed,
    PrintState.RequiresShopAction,
  ],
  [PrintState.Assigned]: [
    PrintState.Downloading,
    PrintState.Printing,
    // Intermediate agent reports can be lost to a network blip (PRD 11,
    // "acknowledgement loss"). The agent is the authority on what physically
    // happened, so a later report is accepted rather than stranding the job.
    PrintState.Printed,
    PrintState.Completed,
    // Agent lost or restarted before starting work: return to the pool.
    PrintState.Queued,
    PrintState.Failed,
    PrintState.Cancelled,
    PrintState.RequiresShopAction,
  ],
  [PrintState.Downloading]: [
    PrintState.Printing,
    PrintState.Printed,
    PrintState.Completed,
    PrintState.Queued,
    PrintState.Failed,
    PrintState.RequiresShopAction,
  ],
  [PrintState.Printing]: [
    PrintState.Printed,
    PrintState.Completed,
    PrintState.Failed,
    // Ambiguous spooler outcome must go to a human, never silently reprint.
    PrintState.RequiresShopAction,
  ],
  [PrintState.Printed]: [
    PrintState.ReadyForCollection,
    PrintState.Completed,
    PrintState.RequiresShopAction,
  ],
  [PrintState.ReadyForCollection]: [
    PrintState.Completed,
    PrintState.RequiresShopAction,
  ],
  [PrintState.Failed]: [
    // Operator-driven retry, or escalation to a refund decision.
    PrintState.Queued,
    PrintState.RequiresShopAction,
    PrintState.RefundReview,
    PrintState.Cancelled,
  ],
  [PrintState.RequiresShopAction]: [
    PrintState.Queued,
    PrintState.Printing,
    PrintState.Printed,
    PrintState.Completed,
    PrintState.Failed,
    PrintState.RefundReview,
    PrintState.Cancelled,
  ],
  [PrintState.RefundReview]: [
    PrintState.Cancelled,
    PrintState.Completed,
    PrintState.RequiresShopAction,
  ],
  [PrintState.Completed]: [],
  [PrintState.Cancelled]: [],
};

const PAYMENT_TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  [PaymentState.Pending]: [
    PaymentState.Processing,
    PaymentState.Paid,
    PaymentState.Failed,
    PaymentState.Cancelled,
  ],
  [PaymentState.Processing]: [
    PaymentState.Paid,
    PaymentState.Failed,
    PaymentState.Cancelled,
  ],
  [PaymentState.Paid]: [
    PaymentState.RefundPending,
    // Provider-initiated reversal can land without our refund request.
    PaymentState.Refunded,
    PaymentState.PartiallyRefunded,
  ],
  [PaymentState.Failed]: [
    // Customer retries payment on the same order.
    PaymentState.Pending,
    PaymentState.Processing,
    PaymentState.Cancelled,
  ],
  [PaymentState.Cancelled]: [],
  [PaymentState.RefundPending]: [
    PaymentState.Refunded,
    PaymentState.PartiallyRefunded,
    // Refund rejected by the provider; the payment stands.
    PaymentState.Paid,
  ],
  [PaymentState.PartiallyRefunded]: [
    PaymentState.RefundPending,
    PaymentState.Refunded,
  ],
  [PaymentState.Refunded]: [],
};

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Re-entering the same state is treated as allowed but is a no-op, so that a
 * duplicate agent report or a replayed webhook does not error (PRD 11).
 */
export function canTransitionPrintState(from: PrintState, to: PrintState): TransitionCheck {
  if (from === to) {
    return { allowed: true };
  }

  const allowedTargets = PRINT_TRANSITIONS[from];
  if (!allowedTargets) {
    return { allowed: false, reason: `Unknown print state '${from}'.` };
  }

  if (!allowedTargets.includes(to)) {
    if (TERMINAL_PRINT_STATES.has(from)) {
      return { allowed: false, reason: `Job is already ${from} and cannot change state.` };
    }
    return { allowed: false, reason: `Illegal print transition ${from} -> ${to}.` };
  }

  return { allowed: true };
}

export function canTransitionPaymentState(from: PaymentState, to: PaymentState): TransitionCheck {
  if (from === to) {
    return { allowed: true };
  }

  const allowedTargets = PAYMENT_TRANSITIONS[from];
  if (!allowedTargets) {
    return { allowed: false, reason: `Unknown payment state '${from}'.` };
  }

  if (!allowedTargets.includes(to)) {
    return { allowed: false, reason: `Illegal payment transition ${from} -> ${to}.` };
  }

  return { allowed: true };
}

export function isTerminalPrintState(state: PrintState): boolean {
  return TERMINAL_PRINT_STATES.has(state);
}

/**
 * Whether the stored document bytes may be deleted in this state (PRD 15).
 * Note that Failed is purgeable but RequiresShopAction is not: a job awaiting a
 * human decision may still need to be reprinted from the original document.
 */
export function isDocumentPurgeable(state: PrintState): boolean {
  return !DOCUMENT_REQUIRED_STATES.has(state);
}

/** Parses an arbitrary string into a PrintState, or undefined if unrecognised. */
export function parsePrintState(value: string): PrintState | undefined {
  return (Object.values(PrintState) as string[]).includes(value)
    ? (value as PrintState)
    : undefined;
}

export function parsePaymentState(value: string): PaymentState | undefined {
  return (Object.values(PaymentState) as string[]).includes(value)
    ? (value as PaymentState)
    : undefined;
}
