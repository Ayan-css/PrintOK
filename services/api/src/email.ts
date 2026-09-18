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
export type EmailProviderName = 'none' | 'log' | 'resend';

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

    if (configured === 'resend' && this.apiKey && this.from) {
      this.provider = 'resend';
    } else if (configured === 'log') {
      // Development: prints what would have been sent. Never in production —
      // an operator who thinks mail works because the log says "sent" is worse
      // off than one who knows it does not.
      this.provider = process.env.NODE_ENV === 'production' ? 'none' : 'log';
    } else {
      this.provider = 'none';

      if (configured === 'resend') {
        console.error(
          '[Email] EMAIL_PROVIDER=resend but EMAIL_API_KEY or EMAIL_FROM is missing. ' +
          'No email will be sent.'
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
    return this.provider === 'resend';
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
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // The body may echo the address; the status and a trimmed reason are
        // enough to act on without putting a customer's email in the log.
        console.error(`[Email] Provider refused a message (${res.status}).`);
        return {
          ok: false,
          provider: this.provider,
          error: `The email provider refused the message (${res.status}). ${detail.slice(0, 200)}`,
        };
      }

      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: true, provider: this.provider, id: body.id };
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
