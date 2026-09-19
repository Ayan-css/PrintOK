/**
 * Sending email, of which this platform could previously do none.
 *
 * Not a missing template — there was no library, no provider and no
 * configuration. Two things were broken by that, both live: a contact enquiry
 * was stored and reached nobody, and a shop owner who forgot their password was
 * locked out permanently, because there was no way to prove who they were.
 *
 * Deliberately built on `fetch` against an HTTP provider rather than SMTP. SMTP
 * would mean adding a dependency and credentials for a protocol that is blocked
 * on most managed hosts anyway; every provider worth using has an HTTP API, and
 * Node has had `fetch` built in since 18.
 *
 * Nothing here decides *whether* mail is configured — that is an operator's
 * decision, expressed in environment variables. What it guarantees is that the
 * rest of the codebase can ask for an email to be sent and find out honestly
 * whether it was.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. Deliberately the only body format: see the note on HTML below. */
  text: string;
}

export type EmailResult =
  | { ok: true; provider: string; id?: string }
  | { ok: false; provider: string; error: string };

/**
 * Which provider is in use, and whether it can actually deliver.
 *
 * `none` is the honest default: with nothing configured, the platform does not
 * pretend to send. Callers are told so, and the one place it matters — a
 * password reset — refuses to claim an email is on its way when it is not.
 */
export type EmailProviderName = 'none' | 'log' | 'resend' | 'brevo';

/**
 * Providers that actually put a message on the wire, and what each needs.
 *
 * The difference that matters commercially, not technically: Resend will only
 * send from a domain you have verified by DNS, while Brevo will also send from
 * a single address you have confirmed by clicking a link in it. Before there is
 * a domain to verify, Brevo is the one that can send to a stranger — which is
 * the whole requirement, because a password reset that only reaches your own
 * inbox resets nobody's password.
 *
 * Both are HTTP APIs called with `fetch`, so supporting the second costs a
 * different endpoint and body shape rather than a dependency.
 */
const HTTP_PROVIDERS = new Set<EmailProviderName>(['resend', 'brevo']);

/**
 * Splits `PrintOk <noreply@example.com>` into its parts.
 *
 * Resend takes that whole string as-is; Brevo wants the name and the address in
 * separate fields and silently sends from nothing useful if handed the raw
 * form. One env var, two shapes, parsed in one place.
 */
export function parseFromAddress(raw: string): { email: string; name?: string } {
  const angled = raw.match(/^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/);
  if (angled) {
    const name = angled[1].replace(/^["']|["']$/g, '').trim();
    return { email: angled[2], ...(name ? { name } : {}) };
  }
  return { email: raw.trim() };
}

export class EmailService {
  private readonly provider: EmailProviderName;
  private readonly apiKey: string;
  private readonly from: string;
  /** Where operator notifications go — enquiries, and anything else internal. */
  public readonly operatorAddress: string;

  constructor() {
    this.apiKey = process.env.EMAIL_API_KEY || '';
    this.from = process.env.EMAIL_FROM || '';
    this.operatorAddress = process.env.OPERATOR_EMAIL || '';

    const configured = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();

    if (HTTP_PROVIDERS.has(configured as EmailProviderName) && this.apiKey && this.from) {
      this.provider = configured as EmailProviderName;
    } else if (configured === 'log') {
      // Development: prints what would have been sent. Never in production —
      // an operator who thinks mail works because the log says "sent" is worse
      // off than one who knows it does not.
      this.provider = process.env.NODE_ENV === 'production' ? 'none' : 'log';
    } else {
      this.provider = 'none';

      if (HTTP_PROVIDERS.has(configured as EmailProviderName)) {
        console.error(
          `[Email] EMAIL_PROVIDER=${configured} but EMAIL_API_KEY or EMAIL_FROM is missing. ` +
          'No email will be sent.'
        );
      } else if (configured && configured !== 'log' && configured !== 'none') {
        // Named a provider that does not exist — almost always a typo, and
        // otherwise indistinguishable from having configured nothing at all.
        console.error(
          `[Email] EMAIL_PROVIDER='${configured}' is not a provider this build knows. ` +
          `Use one of: ${[...HTTP_PROVIDERS].join(', ')}, log. No email will be sent.`
        );
      }
    }

    if (this.provider === 'none' && process.env.NODE_ENV === 'production') {
      console.error(
        '[Email] No email provider is configured. Contact enquiries will reach nobody and ' +
        'password resets cannot be sent. Set EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM and ' +
        'OPERATOR_EMAIL.'
      );
    }
  }

  /** Whether a message sent now would actually leave the building. */
  public get canSend(): boolean {
    return HTTP_PROVIDERS.has(this.provider);
  }

  public get providerName(): EmailProviderName {
    return this.provider;
  }

  /**
   * Sends a message, reporting truthfully whether it went.
   *
   * Returns rather than throws: every caller here is doing something else as
   * well — resetting a password, recording an enquiry — and a mail failure must
   * not undo that work. What it must not do is let the caller believe a message
   * was delivered when it was not.
   */
  public async send(message: EmailMessage): Promise<EmailResult> {
    if (!message.to) {
      return { ok: false, provider: this.provider, error: 'No recipient address.' };
    }

    if (this.provider === 'none') {
      return {
        ok: false,
        provider: 'none',
        error: 'No email provider is configured.',
      };
    }

    if (this.provider === 'log') {
      console.log(
        `[Email:log] To: ${message.to}\n` +
        `[Email:log] Subject: ${message.subject}\n` +
        `[Email:log] ${message.text.split('\n').join('\n[Email:log] ')}`
      );
      return { ok: true, provider: 'log' };
    }

    try {
      // Plain text only, on purpose. An HTML body built by string concatenation
      // around a reset link is an injection waiting to happen, and none of these
      // messages needs formatting — they are a link and a sentence.
      //
      // The two providers disagree on every detail except that: the auth header,
      // the sender field, the body key for plain text, and the name of the id
      // they hand back. Building the request per provider rather than mapping a
      // common shape keeps each one readable against its own documentation.
      const request: { url: string; headers: Record<string, string>; body: unknown } =
        this.provider === 'brevo'
        ? {
            url: 'https://api.brevo.com/v3/smtp/email',
            // Brevo authenticates on its own header, NOT Bearer. Sent as Bearer
            // it answers 401 with a message about the key being missing, which
            // reads exactly like a wrong key rather than a wrong header.
            headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json' },
            body: {
              sender: parseFromAddress(this.from),
              to: [{ email: message.to }],
              subject: message.subject,
              textContent: message.text,
            },
          }
        : {
            url: 'https://api.resend.com/emails',
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: {
              from: this.from,
              to: [message.to],
              subject: message.subject,
              text: message.text,
            },
          };

      const res = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // The body may echo the address; the status and a trimmed reason are
        // enough to act on without putting a customer's email in the log.
        console.error(`[Email] Provider refused a message (${res.status}).`);

        // The one refusal worth naming, because the fix is not in the code and
        // the provider's own wording does not make that obvious: Brevo will not
        // send from an address until someone has clicked the link it emailed to
        // that address.
        const unverified = this.provider === 'brevo' && (res.status === 400 || res.status === 403)
          && /sender/i.test(detail)
          ? ' The sender address may not be verified in Brevo yet — check the inbox for its confirmation link.'
          : '';

        return {
          ok: false,
          provider: this.provider,
          error: `The email provider refused the message (${res.status}). ${detail.slice(0, 200)}${unverified}`,
        };
      }

      // Resend returns `id`, Brevo returns `messageId`.
      const body = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string };
      return { ok: true, provider: this.provider, id: body.id ?? body.messageId };
    } catch (err: any) {
      console.error('[Email] Could not reach the email provider:', err?.message || err);
      return {
        ok: false,
        provider: this.provider,
        error: 'The email provider could not be reached.',
      };
    }
  }
}
