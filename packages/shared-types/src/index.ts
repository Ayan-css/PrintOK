/**
 * PrintOk Domain Types & Contracts
 */

/**
 * Payment state model (completely independent from PrintState)
 */
export enum PaymentState {
  Pending = 'Pending',
  Processing = 'Processing',
  Paid = 'Paid',
  Failed = 'Failed',
  Cancelled = 'Cancelled',
  RefundPending = 'RefundPending',
  Refunded = 'Refunded',
  PartiallyRefunded = 'PartiallyRefunded',
}

/**
 * Print job execution state model
 */
export enum PrintState {
  Created = 'Created',
  AwaitingPayment = 'AwaitingPayment',
  Queued = 'Queued',
  /// Paid for, but deliberately not queued: this shop releases each job by
  /// hand. Distinct from RequiresShopAction, which means something went wrong —
  /// a held job is working exactly as the shop configured it.
  HeldForRelease = 'HeldForRelease',
  /// Claimed by a specific agent device; no other device may pick it up.
  Assigned = 'Assigned',
  Downloading = 'Downloading',
  Printing = 'Printing',
  Printed = 'Printed',
  /// Physically printed and waiting at the counter for the customer.
  ReadyForCollection = 'ReadyForCollection',
  Completed = 'Completed',
  Failed = 'Failed',
  Cancelled = 'Cancelled',
  RequiresShopAction = 'RequiresShopAction',
  /// Held for human decision before any money moves (PRD 12, 17).
  RefundReview = 'RefundReview',
}

/**
 * Failure classification (PRD 12). Determines who can resolve a stuck job.
 */
export enum FailureCategory {
  CustomerResolvable = 'CustomerResolvable',
  ShopResolvable = 'ShopResolvable',
  PlatformResolvable = 'PlatformResolvable',
  SafetyCritical = 'SafetyCritical',
}

/**
 * Immutable record of how a job's price was derived (PRD 9).
 * Frozen at creation so later rate-card edits cannot restate a past quote.
 */
export interface PriceSnapshot {
  perPageRateCents: number;
  pages: number;
  copies: number;
  billableSheets: number;
  subtotalCents: number;
  bulkDiscountPercent: number;
  bulkDiscountCents: number;
  paperSizeMultiplier: number;
  totalPriceInCents: number;
  rateCard: MerchantPricingConfig;
  calculatedAt: string;

  // --- Grid pricing ---
  /** The cell used, so a dispute can be settled without guessing which applied. */
  appliedRate?: ShopRate;
  /** What the order would have cost at normal rates, before any discount. */
  normalValueCents?: number;
  /** Whether the order cleared the bulk threshold, and what it was at the time. */
  bulkApplied?: boolean;
  bulkThresholdCents?: number;
  /** Rate charged for copy 1, and for copies 2+. */
  firstCopyRateCents?: number;
  additionalCopyRateCents?: number;
  /** The whole rate card as it stood, so the quote is reproducible. */
  rateCardSnapshot?: ShopRateCard;
}

/**
 * Which way up the page is printed.
 *
 * `auto` means "whatever the document says" — a portrait PDF prints portrait, a
 * landscape one prints landscape — and is the default because it is what every
 * job did before the customer could choose. `portrait` and `landscape` override
 * the document, which is what someone printing a spreadsheet or a certificate
 * actually wants.
 */
export type PrintOrientation = 'auto' | 'portrait' | 'landscape';

export const PRINT_ORIENTATIONS: readonly PrintOrientation[] = ['auto', 'portrait', 'landscape'];

/** Reads an orientation off the wire, falling back to `auto` for anything else. */
export function parseOrientation(value: unknown): PrintOrientation {
  return PRINT_ORIENTATIONS.includes(value as PrintOrientation)
    ? (value as PrintOrientation)
    : 'auto';
}

/**
 * Turns "1-3, 5, 8-10" into the pages that will actually print.
 *
 * Shared rather than reimplemented per caller, because three separate readings
 * of the same string is how a customer comes to be shown one page count, billed
 * for a second and handed a third. The customer page uses it to quote, the API
 * to price and store, and the agent gets the resolved list.
 *
 * Pages outside the document are dropped rather than clamped: someone who typed
 * "1-3, 90" on a ten-page file meant the first three, and printing page ten
 * twice because 90 was clamped to it would be worse than ignoring it. Returns
 * null for "every page", which is not the same as an empty selection.
 */
export function parsePageRange(range: string | null | undefined, totalPages: number): number[] | null {
  if (!range || !range.trim()) return null;

  const pages = new Set<number>();
  for (const part of range.split(',')) {
    const piece = part.trim();
    if (!piece) continue;

    const span = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (span) {
      const from = Math.min(Number(span[1]), Number(span[2]));
      const to = Math.max(Number(span[1]), Number(span[2]));
      for (let i = from; i <= to; i++) {
        if (i >= 1 && i <= totalPages) pages.add(i);
      }
    } else if (/^\d+$/.test(piece)) {
      const n = Number(piece);
      if (n >= 1 && n <= totalPages) pages.add(n);
    }
  }

  return pages.size > 0 ? [...pages].sort((a, b) => a - b) : [];
}

/**
 * How many pages a job is billed and printed for.
 *
 * An unparseable or out-of-range selection bills the whole document, which is
 * the same thing the agent will print — the two must not disagree, whichever
 * way the disagreement falls.
 */
export function billablePages(range: string | null | undefined, totalPages: number): number {
  const selected = parsePageRange(range, totalPages);
  if (selected === null) return totalPages;
  return selected.length > 0 ? selected.length : totalPages;
}

/**
 * Immutable copy of the print configuration as submitted (PRD 9).
 */
export interface PrintConfigSnapshot {
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex: boolean;
  paperSize: string;
  pageRange?: string;
  /** Optional so a snapshot written before orientation existed still reads. */
  orientation?: PrintOrientation;
}

/**
 * Append-only job lifecycle entry (PRD 9, 22).
 */
export interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  fromState?: string;
  toState?: string;
  /** customer | agent:<deviceId> | shop:<userId> | system | webhook */
  actor?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Shop entity definition
 */
/**
 * Contact and registered address for a shop.
 *
 * Razorpay requires a phone number to create a Route linked account and refuses
 * the call without one, and stalls KYC on an incomplete address. Collected at
 * signup so a shop is not chased for it later, at the moment it is trying to
 * get paid.
 */
export interface ShopContactDetails {
  contactPhone?: string;
  addressStreet1?: string;
  addressStreet2?: string;
  addressCity?: string;
  addressState?: string;
  addressPostalCode?: string;
  /** ISO country code; India unless stated otherwise. */
  addressCountry?: string;
  /** GST registration number, where the shop has one. Shape-checked only. */
  gstin?: string;
}

export interface Shop extends ShopContactDetails {
  id: string;
  name: string;
  ownerEmail: string;
  upiId?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
  payoutStatus?: string;
  /** Razorpay Route linked account, when the shop settles automatically. */
  razorpayAccountId?: string;
  /**
   * Razorpay's own status, verbatim: not_linked before any account exists,
   * created once the account exists, then the Route product's activation_status
   * (requested | needs_clarification | under_review | activated | suspended, or
   * any further value Razorpay sends). Legacy rows may read needs_kyc.
   */
  razorpayAccountStatus?: string;
  razorpayLinkedAt?: string;
  razorpayAccountError?: string;
  razorpayStakeholderId?: string;
  razorpayProductId?: string;
  /** What Razorpay still needs before activating the account, as it reported it. */
  razorpayAccountRequirements?: unknown;
  razorpayStatusUpdatedAt?: string;
  createdAt: string;
}

/**
 * Printer entity definition linked to a Shop
 */
export interface Printer {
  id: string;
  shopId: string;
  printerName: string;
  qrTargetUrl: string;
  qrCodeDataUrl: string; // Base64 PNG/SVG Data URI for rendering QR code
  apiKey: string; // Authentication key for Windows Print Agent
  status: 'online' | 'offline' | 'busy' | 'error';
  createdAt: string;
}

export interface PrinterTelemetry {
  printerId: string;
  lastHeartbeat: string;
  isOnline: boolean;
  paperStatus?: string;
}

/**
 * A print capability a shop can offer.
 *
 * The catalogue is code and the shop's selection is data — a list of keys — so
 * adding a capability is a deploy rather than a migration, and a key left
 * behind by a rename is ignored on read rather than breaking a portal.
 */
export interface ServiceCapability {
  key: string;
  label: string;
  /** Which section of the setup screen it sits in. */
  group: 'popular' | 'advanced' | 'physical';
  /** Shown under the label where the name alone is not enough. */
  hint?: string;
  /**
   * Whether a shop that has never configured anything offers it.
   *
   * This is not a judgement about what a shop *should* sell — it is a
   * statement of what the customer page already offered before this catalogue
   * existed. Anything the portal showed yesterday defaults on, or a shop that
   * has never opened the setup screen would quietly stop accepting orders it
   * accepted the day before.
   *
   * Capabilities the portal never had (photo sizes, glossy, stapling,
   * pages-per-sheet) default off, because nothing is lost by them being off
   * and a shop promising them on hardware that cannot do them has to refund.
   */
  defaultOn: boolean;
}

export const SERVICE_CATALOGUE: readonly ServiceCapability[] = [
  // --- Popular: what nearly every counter does ---
  { key: 'bw',              label: 'Black & white',       group: 'popular', defaultOn: true },
  { key: 'colour',          label: 'Colour',              group: 'popular', defaultOn: true,  hint: 'Turn off if this printer is mono only' },
  { key: 'single-sided',    label: 'Single-sided',        group: 'popular', defaultOn: true },
  { key: 'duplex-auto',     label: 'Back-to-back',        group: 'popular', defaultOn: true,  hint: 'Automatic — the printer turns the page itself' },
  { key: 'duplex-manual',   label: 'Back-to-back',        group: 'popular', defaultOn: true, hint: 'Manual — two passes on a single-sided printer' },
  { key: 'paper-a4',        label: 'A4',                  group: 'popular', defaultOn: true },
  { key: 'paper-a3',        label: 'A3',                  group: 'popular', defaultOn: true },
  { key: 'paper-letter',    label: 'Letter',              group: 'popular', defaultOn: true },
  { key: 'multiple-copies', label: 'Multiple copies',     group: 'popular', defaultOn: true },
  { key: 'page-selection',  label: 'Page selection',      group: 'popular', defaultOn: true, hint: 'Customer picks a page range' },

  // --- Advanced: layout the customer chooses ---
  { key: 'auto-orientation', label: 'Auto orientation',   group: 'advanced', defaultOn: true },
  { key: 'portrait',         label: 'Portrait',           group: 'advanced', defaultOn: true },
  { key: 'landscape',        label: 'Landscape',          group: 'advanced', defaultOn: true },
  { key: 'fit-to-page',      label: 'Fit to page',        group: 'advanced', defaultOn: true },
  { key: 'actual-size',      label: 'Actual size',        group: 'advanced', defaultOn: true },
  { key: 'pages-per-sheet',  label: 'Pages per sheet',    group: 'advanced', defaultOn: false, hint: 'Two or four pages on one side' },
  { key: 'collated',         label: 'Collated printing',  group: 'advanced', defaultOn: true },

  // --- Physical: media and finishing the hardware or staff must do ---
  { key: 'paper-plain',   label: 'Plain paper',    group: 'physical', defaultOn: true },
  { key: 'paper-glossy',  label: 'Glossy paper',   group: 'physical', defaultOn: false },
  { key: 'photo-4x6',     label: '4×6 photo',      group: 'physical', defaultOn: false },
  { key: 'photo-5x7',     label: '5×7 photo',      group: 'physical', defaultOn: false },
  { key: 'stapling',      label: 'Stapling',       group: 'physical', defaultOn: false, hint: 'Someone has to staple it' },
];

export const SERVICE_GROUPS: ReadonlyArray<{ id: ServiceCapability['group']; label: string; blurb: string }> = [
  { id: 'popular',  label: 'Popular services',  blurb: 'What most counters do. Turn off anything this shop cannot.' },
  { id: 'advanced', label: 'Advanced services', blurb: 'Layout choices the customer makes before paying.' },
  { id: 'physical', label: 'Physical services', blurb: 'Media and finishing that the printer or a person has to handle.' },
];

/** The selection a shop starts with, in catalogue order. */
export function defaultEnabledServices(): string[] {
  return SERVICE_CATALOGUE.filter((c) => c.defaultOn).map((c) => c.key);
}

/**
 * The shop's selection, resolved against the catalogue.
 *
 * An empty stored list means "never configured", not "offers nothing" — a shop
 * that has not opened the setup screen must still be able to sell. Unknown keys
 * are dropped, so a renamed capability degrades instead of breaking the portal.
 */
export function resolveEnabledServices(stored: string[] | undefined | null): string[] {
  if (!stored || stored.length === 0) return defaultEnabledServices();
  const known = new Set(SERVICE_CATALOGUE.map((c) => c.key));
  return stored.filter((k) => known.has(k));
}

/**
 * What a customer may actually choose at one shop.
 *
 * Derived from two independent things: the services the shop says it offers,
 * and whether a priced, enabled rate exists for the combination. Both have to
 * agree — a shop that ticks "colour" but has disabled every colour rate is not
 * offering colour, and showing the option would sell something it then has to
 * refund.
 *
 * Shared by three callers that must not disagree: the customer page decides
 * what to render, the setup screen previews the same thing before saving, and
 * the API refuses a job that asks for something not on this list. Hiding a
 * control is presentation; the refusal is the enforcement.
 */
export interface PortalOptions {
  colourModes: Array<'bw' | 'colour'>;
  sidedModes: Array<'single' | 'duplex'>;
  paperSizes: string[];
  /** Orientations this shop lets a customer choose, in the order shown. */
  orientations: PrintOrientation[];
  allowMultipleCopies: boolean;
  allowPageSelection: boolean;
  /**
   * The exact (paper x colour x sides) combinations this shop will actually
   * sell, rather than the dimensions it will sell along.
   *
   * The three lists above are per-dimension, and a customer's order is one
   * specific cell. A shop that switches off A4-colour-duplex while keeping
   * A4-colour-single and A3-colour-duplex on still offers 'A4', 'colour' and
   * 'duplex' on those lists — so the combination it disabled passed every
   * per-dimension check and was sold at whatever stale rate was left on the
   * disabled cell.
   *
   * `sidedModes` in particular never consulted the rate grid at all: it is
   * derived from the service toggles alone.
   */
  sellableCombinations: Array<{ paperSize: string; isColor: boolean; isDuplex: boolean }>;
}

/** Which capability key gates a given paper size. */
const PAPER_SERVICE_KEYS: Record<string, string> = {
  A4: 'paper-a4',
  A3: 'paper-a3',
  Letter: 'paper-letter',
};

export function derivePortalOptions(
  enabledServices: string[],
  card: ShopRateCard
): PortalOptions {
  const offers = new Set(resolveEnabledServices(enabledServices));

  /** A combination is sellable only if its rate row exists and is switched on. */
  const sellable = (paperSize: string, isColor: boolean, isDuplex: boolean): boolean => {
    const rate = findRate(card, paperSize, isColor, isDuplex);
    return !!rate && rate.enabled && rate.perPageCents >= 0;
  };

  const paperSizes = Object.keys(PAPER_SERVICE_KEYS).filter((size) => {
    if (!offers.has(PAPER_SERVICE_KEYS[size])) return false;
    // At least one combination on this paper has to be sellable, or the size
    // is a dead end the customer can select and then not proceed from.
    return [false, true].some((c) => [false, true].some((d) => sellable(size, c, d)));
  });

  const colourModes: Array<'bw' | 'colour'> = [];
  if (offers.has('bw') && paperSizes.some((p) => [false, true].some((d) => sellable(p, false, d)))) {
    colourModes.push('bw');
  }
  if (offers.has('colour') && paperSizes.some((p) => [false, true].some((d) => sellable(p, true, d)))) {
    colourModes.push('colour');
  }

  const sidedModes: Array<'single' | 'duplex'> = [];
  if (offers.has('single-sided')) sidedModes.push('single');
  if (offers.has('duplex-auto') || offers.has('duplex-manual')) sidedModes.push('duplex');

  // Orientation costs the same on every rate, so unlike colour and paper it is
  // gated on the service toggles alone — there is no grid cell to consult.
  const orientations: PrintOrientation[] = [];
  if (offers.has('auto-orientation')) orientations.push('auto');
  if (offers.has('portrait')) orientations.push('portrait');
  if (offers.has('landscape')) orientations.push('landscape');

  // Every cell the shop both offers along each dimension *and* has priced and
  // switched on. This is what an order is actually checked against.
  const sellableCombinations: Array<{ paperSize: string; isColor: boolean; isDuplex: boolean }> = [];
  for (const paperSize of paperSizes) {
    for (const isColor of [false, true]) {
      if (!colourModes.includes(isColor ? 'colour' : 'bw')) continue;
      for (const isDuplex of [false, true]) {
        if (!sidedModes.includes(isDuplex ? 'duplex' : 'single')) continue;
        if (!sellable(paperSize, isColor, isDuplex)) continue;
        sellableCombinations.push({ paperSize, isColor, isDuplex });
      }
    }
  }

  return {
    colourModes,
    sidedModes,
    paperSizes,
    // A shop that has switched off all three still prints: `auto` is what every
    // job did before this choice existed, and refusing the lot would take a
    // working shop offline over a setting it never knew was load-bearing.
    orientations: orientations.length > 0 ? orientations : ['auto'],
    allowMultipleCopies: offers.has('multiple-copies'),
    allowPageSelection: offers.has('page-selection'),
    sellableCombinations,
  };
}

/**
 * Whether a submitted job configuration is one this shop actually sells.
 *
 * Returns the reason it is not, so the customer is told which choice is
 * unavailable rather than being handed a generic refusal.
 */
export function checkJobAgainstPortal(
  options: PortalOptions,
  job: {
    isColor: boolean;
    isDuplex: boolean;
    paperSize: string;
    copies: number;
    pageRange?: string | null;
    orientation?: PrintOrientation;
  }
): string | undefined {
  const wantedColour = job.isColor ? 'colour' : 'bw';
  if (!options.colourModes.includes(wantedColour)) {
    return job.isColor
      ? 'This shop does not print in colour.'
      : 'This shop does not offer black and white printing.';
  }

  const wantedSided = job.isDuplex ? 'duplex' : 'single';
  if (!options.sidedModes.includes(wantedSided)) {
    return job.isDuplex
      ? 'This shop does not print back-to-back.'
      : 'This shop does not offer single-sided printing.';
  }

  if (!options.paperSizes.includes(job.paperSize)) {
    return `This shop does not stock ${job.paperSize} paper.`;
  }

  // The exact combination, not the three dimensions separately. A shop can
  // switch off one specific cell — A4 colour double-sided, say — while keeping
  // its siblings on, and each per-dimension check above would still pass it.
  const offered = options.sellableCombinations;
  if (
    offered &&
    offered.length > 0 &&
    !offered.some(
      (c) =>
        c.paperSize === job.paperSize &&
        c.isColor === job.isColor &&
        c.isDuplex === job.isDuplex
    )
  ) {
    return (
      `This shop does not offer ${job.paperSize} ` +
      `${job.isColor ? 'colour' : 'black and white'} ` +
      `${job.isDuplex ? 'double-sided' : 'single-sided'}. Try another combination.`
    );
  }

  if (job.copies > 1 && !options.allowMultipleCopies) {
    return 'This shop prints one copy at a time.';
  }

  if (job.pageRange && !options.allowPageSelection) {
    return 'This shop prints whole documents only.';
  }

  const wantedOrientation = job.orientation ?? 'auto';
  if (!options.orientations.includes(wantedOrientation)) {
    return wantedOrientation === 'auto'
      ? 'This shop needs you to choose portrait or landscape.'
      : `This shop does not print in ${wantedOrientation}.`;
  }

  return undefined;
}

/**
 * How a merchant thinks about their queue.
 *
 * Print states are the machine's vocabulary — a shop owner does not distinguish
 * Assigned from Downloading, they just want to know it is on its way. These
 * buckets are that translation, defined once so the tab a merchant clicks and
 * the count above it cannot disagree.
 */
export type JobBucket = 'pending' | 'processing' | 'printing' | 'done' | 'failed' | 'rejected';

const BUCKET_STATES: Record<JobBucket, PrintState[]> = {
  // Nothing is happening yet, and something is expected of someone.
  pending: [PrintState.Created, PrintState.AwaitingPayment, PrintState.HeldForRelease],
  // Accepted and on its way to a printer.
  processing: [PrintState.Queued, PrintState.Assigned, PrintState.Downloading],
  printing: [PrintState.Printing],
  done: [PrintState.Printed, PrintState.ReadyForCollection, PrintState.Completed],
  // Needs a person: a failure, or a job the agent could not resolve.
  failed: [PrintState.Failed, PrintState.RequiresShopAction],
  // The shop said no, or the money is going back.
  rejected: [PrintState.Cancelled, PrintState.RefundReview],
};

export const JOB_BUCKETS: ReadonlyArray<{ id: JobBucket; label: string }> = [
  { id: 'pending',    label: 'Pending' },
  { id: 'processing', label: 'Processing' },
  { id: 'printing',   label: 'Printing' },
  { id: 'failed',     label: 'Needs attention' },
  { id: 'rejected',   label: 'Rejected' },
  { id: 'done',       label: 'Done' },
];

export function bucketForState(state: PrintState | string): JobBucket | undefined {
  for (const [bucket, states] of Object.entries(BUCKET_STATES)) {
    if (states.includes(state as PrintState)) return bucket as JobBucket;
  }
  return undefined;
}

/**
 * Tallies every bucket, so a tab showing zero is a fact rather than an absence.
 *
 * Also returns the sheets actually printed, because the dashboard tile that
 * reports it must describe the shop rather than whatever the queue is filtered
 * to — counting rows on screen makes it fall to zero the moment someone
 * searches for a customer.
 */
export function countJobBuckets(
  jobs: Array<{ printState: PrintState | string; pageCount?: number; copies?: number }>
): Record<JobBucket, number> & { all: number; pagesDone: number } {
  const counts = {
    pending: 0, processing: 0, printing: 0, done: 0, failed: 0, rejected: 0,
    all: jobs.length, pagesDone: 0,
  };

  for (const job of jobs) {
    const bucket = bucketForState(job.printState);
    if (bucket) counts[bucket] += 1;
    if (bucket === 'done') {
      counts.pagesDone += (job.pageCount || 0) * (job.copies || 1);
    }
  }

  return counts;
}

/**
 * Whether a job matches what the merchant typed.
 *
 * Searches the things a shop actually has to hand when someone is standing at
 * the counter: the token they were given, their name, their number, or the name
 * of the file. Case and spacing in a phone number are ignored, because nobody
 * writes one the same way twice.
 */
export function jobMatchesSearch(
  job: {
    orderId?: string; tokenNumber?: string; fileName?: string;
    customerName?: string; customerPhone?: string;
  },
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const digits = (v: string) => v.replace(/[^0-9]/g, '');
  const haystack = [job.orderId, job.tokenNumber, job.fileName, job.customerName]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());

  if (haystack.some((v) => v.includes(q))) return true;

  // A number typed as 98200 12345 must find one stored as +91 98200 12345.
  const queryDigits = digits(q);
  if (queryDigits.length >= 4 && job.customerPhone) {
    return digits(job.customerPhone).includes(queryDigits);
  }

  return false;
}

/** One cell of the rate grid: what this exact configuration costs. */
export interface ShopRate {
  paperSize: string;
  isColor: boolean;
  isDuplex: boolean;
  perPageCents: number;
  /** Rate once the order clears the bulk threshold. Null/undefined = no discount here. */
  bulkPerPageCents?: number | null;
  /** Rate for copies 2+. Null/undefined = same as copy 1. */
  additionalCopyPerPageCents?: number | null;
  /** Whether a customer may choose this combination. */
  enabled: boolean;
}

/**
 * Everything needed to price a job at one shop.
 *
 * The grid plus the two discount switches. Stored whole on each job, so a later
 * edit to a shop's rates can never restate what a past customer was quoted.
 */
export interface ShopRateCard {
  rates: ShopRate[];
  /** Lower rates once an order's normal value crosses the threshold. */
  bulkEnabled: boolean;
  bulkThresholdCents: number;
  /** Copy 1 at the normal rate, copies 2+ at the per-configuration rate. */
  additionalCopyEnabled: boolean;
}

/** Paper sizes the portal offers. A shop enables or prices the ones it stocks. */
export const PAPER_SIZES = ['A4', 'A3', 'Letter'] as const;

/** Every combination a rate grid covers, in the order a merchant reads them. */
export function rateGridKeys(): Array<{ paperSize: string; isColor: boolean; isDuplex: boolean }> {
  const keys: Array<{ paperSize: string; isColor: boolean; isDuplex: boolean }> = [];
  for (const paperSize of PAPER_SIZES) {
    for (const isColor of [false, true]) {
      for (const isDuplex of [false, true]) {
        keys.push({ paperSize, isColor, isDuplex });
      }
    }
  }
  return keys;
}

export function findRate(
  card: ShopRateCard,
  paperSize: string,
  isColor: boolean,
  isDuplex: boolean
): ShopRate | undefined {
  return card.rates.find(
    (r) => r.paperSize === paperSize && r.isColor === isColor && r.isDuplex === isDuplex
  );
}

export interface MerchantPricingConfig {
  bwSinglePerPageCents: number;
  bwDuplexPerPageCents: number;
  colorSinglePerPageCents: number;
  colorDuplexPerPageCents: number;
  a3Multiplier?: number;
  bulkDiscountThreshold?: number;
  bulkDiscountPercent?: number;
  enableSeparatorPage?: boolean;
  separatorMinPages?: number;
}

export interface MerchantStats {
  shopId: string;
  todayRevenueCents: number;
  todayJobsCount: number;
  completedJobsCount: number;
  pendingJobsCount: number;
}


/**
 * Print Job definition
 */
export interface PrintJob {
  id: string;
  /** Customer-facing order reference, stable across job retries. */
  orderId: string;
  shopId: string;
  printerId: string;
  /** Agent device that claimed the job; unset until assignment. */
  deviceId?: string;
  tokenNumber?: string;
  /** The day that token belongs to, as YYYY-MM-DD. Tokens restart each morning. */
  tokenDay?: string;

  /**
   * Customer identity, present only when the shop asked for it.
   *
   * Undefined is the normal case: collection is opt-in per shop, because the
   * published privacy policy promises anonymity by default.
   */
  customerName?: string;
  customerPhone?: string;

  // Document reference
  fileName: string;
  /**
   * A usable link to the document, minted on demand for a caller already
   * authorised to have it — empty on a stored job.
   *
   * It used to be generated once at upload and persisted: a one-hour presigned
   * URL, or on the local-disk fallback the entire document inlined as a base64
   * data URI. Either way the job row carried a standing bearer token for a
   * customer's file, and the row reported the document purged while still
   * serving it.
   */
  fileUrl: string;
  /** Where the document is stored. Server-side only; never sent to a customer. */
  s3Key?: string;
  fileChecksum: string;
  fileSizeBytes?: number;

  // Print configuration
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex?: boolean;
  paperSize?: string;
  pageRange?: string;
  /** Undefined on jobs created before the customer could choose; means `auto`. */
  orientation?: PrintOrientation;
  printConfig?: PrintConfigSnapshot;

  // Price
  totalPriceInCents: number;
  priceSnapshot?: PriceSnapshot;

  // Payment
  paymentState: PaymentState;
  paymentProvider?: string;
  paymentRef?: string;
  /**
   * The gateway's own order id, and what it was opened for.
   *
   * A browser-reported payment is bound to the job through these: the checkout
   * signature proves Razorpay issued a given (order, payment) pair, and the
   * stored order id proves that order belongs to this job. Neither alone is
   * enough, which is why both are kept.
   */
  razorpayOrderId?: string;
  razorpayOrderAmountCents?: number;
  /** The gateway payment that settled this job. Unique across the platform. */
  razorpayPaymentId?: string;

  /**
   * What this order's money actually did, frozen at confirmation.
   *
   * Recorded once rather than recomputed, because recomputing means a shop that
   * upgrades mid-month sees last week's orders restated at its new rate, and it
   * means the gateway fee is always the published estimate rather than what was
   * charged. `feesAreActual` says which of those two the figures are.
   */
  grossCents?: number;
  gatewayFeeCents?: number;
  gatewayTaxCents?: number;
  commissionBpsUsed?: number;
  /** Razorpay's fee for the Route transfer itself, absorbed by PrintOk. */
  routeFeeCents?: number;
  feesAreActual?: boolean;

  // Print lifecycle
  printState: PrintState;

  // Idempotency & retries (PRD 11)
  idempotencyKey?: string;
  attemptCount?: number;
  maxAttempts?: number;
  lastAttemptAt?: string;

  // Failure handling (PRD 12)
  errorMessage?: string;
  failureCategory?: FailureCategory;

  // Lifecycle timestamps
  queuedAt?: string;
  assignedAt?: string;
  printedAt?: string;
  completedAt?: string;
  documentDeletedAt?: string;

  /** Set when the shop declined the job, with the reason it gave. */
  declineReason?: string;
  /** Razorpay refund id (rfnd_...) once the money has been sent back. */
  refundId?: string;
  refundAmountCents?: number;
  refundedAt?: string;

  /**
   * Razorpay Route settlement for this job. Empty on every order taken while
   * Route is off. See the PrintJob model in schema.prisma for each field.
   */
  payeeAccountId?: string;
  transferId?: string;
  transferStatus?: string;
  transferSettlementStatus?: string;
  transferOnHold?: boolean;
  transferReleasedAt?: string;
  transferReversalId?: string;
  transferReversedAt?: string;
  transferFailureReason?: string;
  settledAt?: string;
  transferAmountCents?: number;
  serviceFeeCents?: number;

  createdAt: string;
  updatedAt: string;
}

/**
 * DTO: Shop & Printer Registration Input
 */
export interface RegisterShopDto {
  shopName: string;
  ownerEmail: string;
  printerName: string;
  upiId?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
}

/**
 * DTO: Shop & Printer Registration Output
 */
export interface RegisterShopResponse {
  shop: Shop;
  printer: Printer;
}

/**
 * DTO: Create Print Job Input
 */
export interface CreatePrintJobDto {
  printerId: string;
  fileName: string;
  fileBase64: string; // Temporary payload for MVP
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex?: boolean;
  paperSize?: string;
  orientation?: PrintOrientation;
  /** Sent only when the shop's portal asks for them. */
  customerName?: string;
  customerPhone?: string;
}

/**
 * What the customer portal asks for, decided by the shop.
 *
 * Every field defaults to false. A shop that has not opted in collects nothing,
 * which is what the privacy policy tells its customers.
 */
/**
 * When a job actually reaches the printer.
 *
 * `after-payment` is what PrintOk has always done and stays the default, so no
 * existing shop changes behaviour by upgrading.
 */
export type AutoPrintMode = 'after-payment' | 'all' | 'off';

/** What, if anything, is printed between jobs on a busy counter. */
export type SeparatorMode = 'none' | 'blank' | 'invoice';

export interface ShopPortalConfig {
  collectCustomerName: boolean;
  customerNameRequired: boolean;
  collectCustomerPhone: boolean;
  customerPhoneRequired: boolean;
  /** Capability keys offered, in display order. Empty means the defaults. */
  enabledServices: string[];

  autoPrintMode: AutoPrintMode;
  separatorMode: SeparatorMode;
  /** How many waiting jobs counts as a backlog worth separating. */
  separatorMinQueue: number;
}

export const AUTO_PRINT_MODES: readonly AutoPrintMode[] = ['after-payment', 'all', 'off'];
export const SEPARATOR_MODES: readonly SeparatorMode[] = ['none', 'blank', 'invoice'];

/**
 * Whether this job should be preceded by a separator sheet.
 *
 * Only when a real backlog exists. A separator between every job in a quiet
 * hour is one wasted sheet per order, which is how a shop decides the feature
 * is not worth having and turns it off for the busy hour too.
 */
export function shouldPrintSeparator(
  config: Pick<ShopPortalConfig, 'separatorMode' | 'separatorMinQueue'>,
  jobsWaiting: number
): boolean {
  if (config.separatorMode === 'none') return false;
  return jobsWaiting >= Math.max(1, config.separatorMinQueue);
}

export const DEFAULT_PORTAL_CONFIG: ShopPortalConfig = {
  collectCustomerName: false,
  customerNameRequired: false,
  collectCustomerPhone: false,
  customerPhoneRequired: false,
  enabledServices: [],
  autoPrintMode: 'after-payment',
  separatorMode: 'none',
  separatorMinQueue: 3,
};

/** Longest we will store for either field, so a paste of a whole address is refused. */
export const CUSTOMER_NAME_MAX = 80;
export const CUSTOMER_PHONE_MAX = 20;

/**
 * DTO: Create Print Job Output
 */
export interface CreatePrintJobResponse {
  job: PrintJob;
}

/**
 * DTO: Agent Pending Jobs Response
 */
export interface AgentPollResponse {
  jobs: PrintJob[];
  /**
   * A sheet to print before this batch, or 'none'.
   *
   * Sent with the batch rather than per job: the decision is about how busy the
   * counter is, and the agent needs it before it starts printing the first one.
   * Older agents ignore the field and behave exactly as they did.
   */
  separator?: SeparatorMode;
}

/**
 * DTO: Agent Update Status Input
 */
export interface AgentUpdateStatusDto {
  jobId: string;
  printState: PrintState;
  errorMessage?: string;
}

/**
 * DTO: Payment Webhook Input
 */
export interface PaymentWebhookDto {
  paymentId: string;
  jobId: string;
  amountInCents: number;
  signature: string;
}

/**
 * DTO: WebSocket Event Messages for Agent
 */
export interface AgentWsMessage {
  type: 'PING' | 'PONG' | 'JOB_QUEUED' | 'AUTH_SUCCESS' | 'AUTH_ERROR';
  payload?: any;
}

export interface JobQueuedEvent {
  jobId: string;
  printerId: string;
  tokenNumber?: string;
  fileName: string;
  fileUrl: string;
  fileChecksum: string;
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex?: boolean;
  paperSize?: string;
  orientation?: PrintOrientation;
}



/* ===========================================================================
 * Plan catalogue (PRD 41)
 *
 * The single source of truth for tiers, prices, service fees and limits. The
 * API prices from it, the admin console edits against it, and the landing page
 * renders it — so the figures a shop is shown are the figures it is charged.
 * Anything duplicating these numbers elsewhere is a bug waiting to happen.
 * =========================================================================== */

export type PlanTier = 'free' | 'starter' | 'business' | 'pro';

/**
 * Tier ids as they were published before 19 Sep 2026, and what each became.
 *
 * Kept because shop rows written before the migration carry the old id, and a
 * row that has not been migrated yet must still resolve to a plan rather than
 * to `undefined` — which would silently disable every limit for that shop.
 * `getPlan` accepts either spelling for exactly that reason.
 */
export const LEGACY_PLAN_TIERS: Readonly<Record<string, PlanTier>> = {
  start: 'free',
  smart: 'starter',
  business: 'business',
  enterprise: 'pro',
};

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  /** Subscription price in paise. */
  monthlyPriceCents: number;
  /**
   * PrintOk's own platform fee, in basis points (200 = 2.00%).
   *
   * Deliberately NOT the payment gateway's fee. Razorpay's charge is
   * PAYMENT_GATEWAY_FEE_BPS, is deducted by Razorpay rather than by us, and is
   * reported to the shop on its own line. Conflating the two is how a shop ends
   * up billed twice for one order, so they never share a field.
   */
  platformFeeBps: number;
  /** Orders included per calendar month. */
  maxOrdersPerMonth: number;
  maxPrinters: number;
  /** Sign-in accounts for this shop, owner included. */
  maxStaff: number;
  tagline: string;
  features: string[];
  /** Exactly one tier carries this. */
  popular?: boolean;
}

/**
 * Razorpay's charge, deducted by Razorpay before settlement — not by PrintOk.
 * 2% plus 18% GST on that fee. Shown separately so a shop is never surprised
 * by the difference between its order total and its payout, which matters most
 * on Enterprise where our own fee is smaller than the gateway's.
 */
export const PAYMENT_GATEWAY_FEE_BPS = 236;
export const PAYMENT_GATEWAY_LABEL = 'Razorpay 2% + 18% GST';

/**
 * The edition of the Terms & Conditions a shop owner accepts at signup — the
 * "Last updated" date printed at the top of /terms. Stored with the acceptance,
 * so it stays provable which wording someone agreed to after the terms change.
 * Change it whenever terms.html changes materially.
 */
export const TERMS_VERSION = '2026-09-25';

export const PLAN_CATALOGUE: readonly PlanDefinition[] = [
  {
    tier: 'free',
    name: 'Free',
    monthlyPriceCents: 0,
    platformFeeBps: 200,
    maxOrdersPerMonth: 100,
    maxPrinters: 1,
    maxStaff: 1,
    tagline: 'Put your counter online and see if it works for you.',
    features: [
      'QR poster for your counter',
      'Customer pays by UPI or card',
      'Live job queue and tokens',
      'Your own per-page rates',
      'Email support',
    ],
  },
  {
    tier: 'starter',
    name: 'Starter',
    monthlyPriceCents: 14900,
    platformFeeBps: 100,
    maxOrdersPerMonth: 1000,
    maxPrinters: 2,
    maxStaff: 3,
    tagline: 'For a shop printing every day.',
    features: [
      'Everything in Free',
      'Bulk and duplex pricing',
      'Revenue analytics',
      'A second printer and three sign-ins',
    ],
  },
  {
    tier: 'business',
    name: 'Business',
    monthlyPriceCents: 34900,
    platformFeeBps: 50,
    maxOrdersPerMonth: 4000,
    maxPrinters: 5,
    maxStaff: 8,
    tagline: 'For a busy counter running several printers.',
    features: [
      'Everything in Starter',
      'Multiple connected PCs',
      'Priority support',
      'Onboarding help',
    ],
    popular: true,
  },
  {
    tier: 'pro',
    name: 'Pro',
    monthlyPriceCents: 69900,
    platformFeeBps: 0,
    maxOrdersPerMonth: 10000,
    maxPrinters: 10,
    maxStaff: 15,
    tagline: 'For print shops and multi-counter operations.',
    features: [
      'Everything in Business',
      'No PrintOk platform fee at all',
      'Highest order volume',
      'Dedicated support contact',
    ],
  },
];

/**
 * Finds a plan by tier id, accepting the pre-19-Sep-2026 spellings.
 *
 * A shop row written before the migration still says 'start'. Returning
 * undefined for it would not merely mislabel the plan — every limit is skipped
 * when the definition is missing, so an unmigrated shop would silently become
 * unlimited. Accepting the old id fails safe instead.
 */
export function getPlan(tier: string): PlanDefinition | undefined {
  const canonical = LEGACY_PLAN_TIERS[tier] ?? tier;
  return PLAN_CATALOGUE.find((p) => p.tier === canonical);
}

export const PLAN_TIERS: readonly PlanTier[] = PLAN_CATALOGUE.map((p) => p.tier);

/**
 * The tier a shop is on before anyone chooses one.
 *
 * Named rather than written as a literal in each caller, because the previous
 * arrangement spelled 'start' and 800 into a dozen `??` fallbacks — so a plan
 * rename left those fallbacks quietly pointing at a tier that no longer
 * existed, and every one of them had to be found by hand.
 */
export const DEFAULT_PLAN_TIER: PlanTier = 'free';

/** The platform fee a shop pays before anyone changes it. Derived, never typed twice. */
export const DEFAULT_PLATFORM_FEE_BPS: number =
  PLAN_CATALOGUE.find((p) => p.tier === DEFAULT_PLAN_TIER)!.platformFeeBps;

/**
 * Whether an order's money came through the payment gateway at all.
 *
 * A job paid in cash at the counter never touched Razorpay, so no MDR was
 * charged on it and none may be deducted from what the shop keeps.
 *
 * The two paths are distinguishable by what they record: an online payment
 * carries a gateway payment id — `razorpayPaymentId` since the payment-binding
 * change, `paymentRef` on older rows — while the counter-cash path confirms
 * through `manual-override`, which passes no payment reference because there
 * is no payment to reference.
 */
export function wasPaidThroughGateway(job: {
  razorpayPaymentId?: string;
  paymentRef?: string;
}): boolean {
  return Boolean(job.razorpayPaymentId || job.paymentRef);
}

/**
 * PrintOk's own platform fee on an order, in paise.
 *
 * The one place this arithmetic lives. Every caller — settlement, the Route
 * transfer, the plan screen, the earnings table — goes through here, so a
 * rounding change cannot apply to the money a shop is paid but not to the
 * figure it is shown.
 *
 * **Rounding: `Math.round`, half away from zero, at the order level.** A ₹40.10
 * order at 0.5% is 20.05 paise and bills as 20. The fee is computed per order
 * and never on a running total, so a month's fees are the sum of what each
 * order was actually charged, which is what makes the ledger reconcilable
 * against the shop's own records.
 *
 * Rounds to at most a half-paise per order in our favour or theirs. The
 * alternative — rounding down always — was rejected because it makes a 0% tier
 * and a 0.004% tier indistinguishable, and Pro's 0% has to mean exactly zero.
 *
 * `platformFeeBps` is the shop's effective rate, which is normally its plan's
 * but may be a rate an operator negotiated. It is NOT the gateway fee; see
 * PAYMENT_GATEWAY_FEE_BPS.
 */
export function platformFeeFor(grossCents: number, platformFeeBps: number): number {
  if (!Number.isFinite(grossCents) || !Number.isFinite(platformFeeBps)) return 0;
  if (grossCents <= 0 || platformFeeBps <= 0) return 0;
  return Math.round((grossCents * platformFeeBps) / 10_000);
}

/**
 * What a shop actually keeps from an order.
 *
 * The gateway takes its cut before settlement and PrintOk's fee applies to the
 * order value, so the two are calculated independently rather than compounded.
 *
 * `gatewayFeeApplies` must be false for an order paid in cash. It used to be
 * unconditional, so every counter sale was shown with a "Razorpay 2% + 18% GST"
 * line deducted from it — understating the shop's earnings on money that never
 * left the till, and attributing the deduction to a company that charged
 * nothing for it. Defaulted to true because that is right for every online
 * order; pass `wasPaidThroughGateway(job)` rather than assuming.
 */
export function calculateShopNetCents(
  grossCents: number,
  platformFeeBps: number,
  options: { gatewayFeeApplies?: boolean } = {}
): {
  gatewayFeeCents: number;
  serviceFeeCents: number;
  netCents: number;
  /** False for counter cash, so a caller can label the row rather than infer. */
  gatewayFeeApplies: boolean;
} {
  const gatewayFeeApplies = options.gatewayFeeApplies !== false;

  const gatewayFeeCents = gatewayFeeApplies
    ? Math.round((grossCents * PAYMENT_GATEWAY_FEE_BPS) / 10_000)
    : 0;
  const serviceFeeCents = platformFeeFor(grossCents, platformFeeBps);

  return {
    gatewayFeeCents,
    serviceFeeCents,
    netCents: Math.max(0, grossCents - gatewayFeeCents - serviceFeeCents),
    gatewayFeeApplies,
  };
}

/* ============================================================================
 * Agent updates
 *
 * An update channel is a remote code execution channel: whatever the server
 * names here is what runs as a service on every shop's counter PC. Everything
 * in this section exists to make that channel narrow and legible rather than
 * convenient.
 * ========================================================================== */

/** What a device should do about a published release. */
export type AgentUpdateMode = 'notify' | 'auto';

export interface AgentUpdateManifest {
  /** True when the device is already on the published build, or none exists. */
  upToDate: boolean;
  /** The published version, absent when nothing has been published. */
  version?: string;
  downloadUrl?: string;
  /** Lowercase hex SHA-256 the agent must verify before executing anything. */
  sha256?: string;
  mode?: AgentUpdateMode;
  notes?: string;
}

/**
 * Compares two dotted version strings numerically.
 *
 * Returns > 0 when `a` is newer, < 0 when older, 0 when equivalent.
 *
 * String comparison is the obvious implementation and it is wrong in a way that
 * only appears after ten releases: "1.10.0" sorts before "1.9.0" because "1"
 * precedes "9". A fleet would stop upgrading at 1.9 and nothing would report an
 * error — every device would simply believe it was current.
 *
 * Missing components count as zero, so "1.4" and "1.4.0" are the same build.
 * Anything unparseable compares as older than everything, because a device that
 * cannot say what it is running is one that should be offered the update.
 */
export function compareAgentVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    String(v ?? '').trim().split('.').map((piece) => {
      const n = Number.parseInt(piece, 10);
      return Number.isFinite(n) && n >= 0 ? n : -1;
    });

  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** A SHA-256 as the agent requires it: 64 lowercase hex characters. */
export function isValidSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(String(value ?? '').trim().toLowerCase());
}

/**
 * Hosts the platform will publish an installer from.
 *
 * Checked when a release is published, so a typo or a pasted wrong link is
 * refused by the console rather than distributed to the fleet. It is NOT the
 * security boundary — the agent keeps its own download allowlist and refuses
 * anything outside it, because a server that has been compromised will happily
 * pass its own checks.
 */
export const AGENT_RELEASE_HOSTS: readonly string[] = [
  'github.com',
  'objects.githubusercontent.com',
];

/** Whether a URL is one the console will accept for a published release. */
export function isAllowedReleaseUrl(raw: string): boolean {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:') return false;
    return AGENT_RELEASE_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
