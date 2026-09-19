/**
 * Structured logging for the things that cost money or stop a shop printing.
 *
 * The platform had no metrics, no tracing and no alerts, and the honest
 * observation in the project's own notes was that every defect found that week
 * was found by reading code rather than by anything telling anyone. This does
 * not fix that — an alert needs somewhere to go — but it makes the events that
 * matter greppable, machine-readable and consistent, which is the part that has
 * to exist before any alerting can be pointed at it.
 *
 * One JSON object per line, because that is what every log aggregator can read
 * without configuration, and because a log line split across several lines is a
 * log line nobody can match on.
 */

/**
 * Keys whose values never reach a log line, at any depth.
 *
 * An allowlist would be safer still, but it would also mean every new field
 * arriving as `undefined` in an incident — which is how people stop trusting
 * logs. So: a denylist of the things that are credentials, matched by name
 * rather than by value, plus a blanket rule that anything looking like a secret
 * is summarised rather than printed.
 */
const REDACTED_KEYS = new Set([
  'password', 'passwordhash', 'token', 'apikey', 'api_key', 'secret',
  'authorization', 'signature', 'devicetoken', 'tokenhash', 'filebase64',
  'fileurl', 'razorpaysignature', 'keysecret', 'webhooksecret', 'jwt',
  'customerphone', 'customername', 'email', 'upiid', 'bankaccountnumber',
]);

/** How deep to walk a detail object before giving up. */
const MAX_DEPTH = 4;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[deep]';

  if (Array.isArray(value)) {
    // Bounded: a log line is not a data export.
    return value.slice(0, 20).map((v) => redact(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key.toLowerCase())) {
        // Present, so an incident can see the field was set — never its value.
        out[key] = inner === undefined || inner === null ? null : '[redacted]';
        continue;
      }
      out[key] = redact(inner, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string') {
    // Long opaque strings are almost always a payload or a credential. Neither
    // belongs in a log line, and the length is the useful part.
    return value.length > 300 ? `[${value.length} chars]` : value;
  }

  return value;
}

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * The event names this codebase emits.
 *
 * A fixed set rather than free text, so a dashboard can be built against them
 * and a typo cannot silently create an event nobody is watching for.
 */
export type OpsEvent =
  | 'payment.confirmed'
  | 'payment.rejected'
  | 'payment.replay_blocked'
  | 'refund.requested'
  | 'refund.settled'
  | 'refund.failed'
  | 'refund.blocked'
  | 'storage.failed'
  | 'document.purged'
  | 'job.failed'
  | 'agent.rejected'
  | 'route.transfer_failed'
  | 'plan.limit_reached'
  | 'email.failed'
  // Publishing a build decides what executes on every shop's counter PC, so it
  // is logged at warn regardless of outcome: this is the line an incident
  // review looks for first.
  | 'agent.release_published';

/**
 * Emits one structured line.
 *
 * Deliberately on console: the host collects stdout, and adding a transport
 * would mean a dependency and a second place for logs to be lost. What matters
 * here is the shape, not the destination.
 */
export function logOps(
  level: LogLevel,
  event: OpsEvent,
  detail: Record<string, unknown> = {}
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(detail) as Record<string, unknown>),
  });

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
