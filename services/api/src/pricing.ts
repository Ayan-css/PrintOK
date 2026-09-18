import {
  MerchantPricingConfig, PriceSnapshot, ShopRate, ShopRateCard,
  rateGridKeys, findRate,
} from '@printok/shared-types';

export const DEFAULT_PRICING_CONFIG: MerchantPricingConfig = {
  bwSinglePerPageCents: 200,    // ₹2.00
  bwDuplexPerPageCents: 150,    // ₹1.50
  colorSinglePerPageCents: 1000,// ₹10.00
  colorDuplexPerPageCents: 800, // ₹8.00
  a3Multiplier: 2.0,
  bulkDiscountThreshold: 50,     // 50 pages
  bulkDiscountPercent: 10,       // 10%
  enableSeparatorPage: false,
  separatorMinPages: 5,
};

/**
 * Calculates total job price in cents based on page count, copies, color, duplex, paper size, and merchant pricing config.
 */
export function calculateJobPrice(
  pages: number,
  copies: number = 1,
  isColor: boolean = false,
  isDuplex: boolean = false,
  paperSize: string = 'A4',
  pricingConfig: MerchantPricingConfig = DEFAULT_PRICING_CONFIG
): number {
  const safePages = Math.max(1, pages);
  const safeCopies = Math.max(1, copies);

  let perPageRate: number;

  if (isColor) {
    perPageRate = isDuplex
      ? pricingConfig.colorDuplexPerPageCents
      : pricingConfig.colorSinglePerPageCents;
  } else {
    perPageRate = isDuplex
      ? pricingConfig.bwDuplexPerPageCents
      : pricingConfig.bwSinglePerPageCents;
  }

  // Paper size multiplier (e.g. A3 paper cost)
  if (paperSize === 'A3') {
    const mult = pricingConfig.a3Multiplier || 2.0;
    perPageRate = Math.round(perPageRate * mult);
  }

  let subtotal = safePages * safeCopies * perPageRate;

  // Apply bulk discount if threshold met
  const totalSheets = safePages * safeCopies;
  const threshold = pricingConfig.bulkDiscountThreshold || 50;
  if (threshold > 0 && totalSheets >= threshold) {
    const discountPct = pricingConfig.bulkDiscountPercent ?? 10;
    const discountFactor = (100 - discountPct) / 100;
    subtotal = Math.round(subtotal * discountFactor);
  }

  return subtotal;
}


/**
 * Computes the price and returns the full derivation alongside it (PRD 9).
 *
 * The snapshot is stored on the job so that a later edit to the shop's rate card
 * can never restate what a past customer was quoted, and so disputes can be
 * settled from the record rather than by recomputing against current rates.
 */
export function calculateJobPriceBreakdown(
  pages: number,
  copies: number = 1,
  isColor: boolean = false,
  isDuplex: boolean = false,
  paperSize: string = 'A4',
  pricingConfig: MerchantPricingConfig = DEFAULT_PRICING_CONFIG
): PriceSnapshot {
  const safePages = Math.max(1, pages);
  const safeCopies = Math.max(1, copies);

  const baseRate = isColor
    ? (isDuplex ? pricingConfig.colorDuplexPerPageCents : pricingConfig.colorSinglePerPageCents)
    : (isDuplex ? pricingConfig.bwDuplexPerPageCents : pricingConfig.bwSinglePerPageCents);

  const paperSizeMultiplier = paperSize === 'A3' ? (pricingConfig.a3Multiplier || 2.0) : 1;
  const perPageRateCents = paperSize === 'A3'
    ? Math.round(baseRate * paperSizeMultiplier)
    : baseRate;

  const billableSheets = safePages * safeCopies;
  const subtotalCents = billableSheets * perPageRateCents;

  const threshold = pricingConfig.bulkDiscountThreshold || 50;
  const qualifiesForBulk = threshold > 0 && billableSheets >= threshold;
  const bulkDiscountPercent = qualifiesForBulk ? (pricingConfig.bulkDiscountPercent ?? 10) : 0;
  const totalPriceInCents = qualifiesForBulk
    ? Math.round(subtotalCents * ((100 - bulkDiscountPercent) / 100))
    : subtotalCents;

  return {
    perPageRateCents,
    pages: safePages,
    copies: safeCopies,
    billableSheets,
    subtotalCents,
    bulkDiscountPercent,
    bulkDiscountCents: subtotalCents - totalPriceInCents,
    paperSizeMultiplier,
    totalPriceInCents,
    rateCard: { ...pricingConfig },
    calculatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- grid pricing ---

/**
 * Prices a job from the shop's rate grid.
 *
 * The grid replaces four global rates and an A3 multiplier. Two discounts sit
 * on top, and the order they apply in is the part worth being precise about:
 *
 *   1. **Bulk** is tested against the order's *normal* value — what it would
 *      cost at undiscounted rates. Testing it against the discounted value
 *      would make the discount self-triggering near the threshold, where a
 *      cheaper rate drops the total back under the bar it just cleared.
 *   2. **Additional copies** then apply to copies 2 and beyond. Copy 1 always
 *      pays the rate the bulk test settled on, which is what "copy 1 uses the
 *      normal price" means once bulk is also in play.
 *
 * A missing cell falls back to the legacy flat calculation rather than
 * refusing: a shop whose grid has not been seeded must still be able to sell.
 */
export function calculateGridPriceBreakdown(
  pages: number,
  copies: number,
  isColor: boolean,
  isDuplex: boolean,
  paperSize: string,
  card: ShopRateCard,
  legacy: MerchantPricingConfig = DEFAULT_PRICING_CONFIG
): PriceSnapshot {
  const safePages = Math.max(1, pages);
  const safeCopies = Math.max(1, copies);

  const cell = findRate(card, paperSize, isColor, isDuplex);

  // A cell the shop has switched off is treated as one it never priced.
  //
  // This used to read `enabled` nowhere, so a disabled combination was charged
  // at whatever stale rate was left on it — including a near-zero one left
  // behind by an earlier edit. The API refuses such an order before reaching
  // here; this is the second line, for a caller that does not.
  if (!cell || cell.enabled === false) {
    return calculateJobPriceBreakdown(safePages, safeCopies, isColor, isDuplex, paperSize, legacy);
  }

  const normalRate = cell.perPageCents;
  const billableSheets = safePages * safeCopies;
  const normalValueCents = billableSheets * normalRate;

  const bulkAvailable =
    card.bulkEnabled &&
    cell.bulkPerPageCents !== null &&
    cell.bulkPerPageCents !== undefined;
  const bulkApplied = bulkAvailable && normalValueCents >= card.bulkThresholdCents;

  const firstCopyRateCents = bulkApplied ? cell.bulkPerPageCents! : normalRate;

  const additionalCopyRateCents =
    card.additionalCopyEnabled &&
    cell.additionalCopyPerPageCents !== null &&
    cell.additionalCopyPerPageCents !== undefined
      ? cell.additionalCopyPerPageCents
      : firstCopyRateCents;

  const rawTotalCents =
    safePages * firstCopyRateCents + safePages * (safeCopies - 1) * additionalCopyRateCents;

  // A larger order must never cost less than a smaller one.
  //
  // Crossing the bulk threshold steps the first-copy rate down while the
  // additional-copy rate stays put, so the total is not monotonic in copies
  // whenever the step is bigger than the additional-copy rate. Worked example
  // from a perfectly valid rate card: 10 pages at 10 paise, bulk 5,
  // additional-copy 3, threshold 900 — eight copies cost 310 and nine cost
  // 290. Any customer triggers it by choosing a quantity.
  //
  // Rate cards are validated on write to reject that relationship, but a card
  // stored before that validation existed is still out there, so the
  // calculation defends itself: the price is the highest that any smaller
  // quantity would have cost. Bounded by the copy limit and pure arithmetic.
  const totalFor = (copies: number): number => {
    const value = safePages * copies * normalRate;
    const bulkHere = bulkAvailable && value >= card.bulkThresholdCents;
    const first = bulkHere ? cell.bulkPerPageCents! : normalRate;
    const additional =
      card.additionalCopyEnabled &&
      cell.additionalCopyPerPageCents !== null &&
      cell.additionalCopyPerPageCents !== undefined
        ? cell.additionalCopyPerPageCents
        : first;
    return safePages * first + safePages * (copies - 1) * additional;
  };

  let totalPriceInCents = rawTotalCents;
  for (let fewer = safeCopies - 1; fewer >= 1; fewer--) {
    const atFewer = totalFor(fewer);
    if (atFewer > totalPriceInCents) totalPriceInCents = atFewer;
  }

  const discountCents = Math.max(0, normalValueCents - totalPriceInCents);

  return {
    // Kept for every existing reader of a snapshot. It reports the rate copy 1
    // paid, which is the one a customer sees quoted.
    perPageRateCents: firstCopyRateCents,
    pages: safePages,
    copies: safeCopies,
    billableSheets,
    subtotalCents: normalValueCents,
    bulkDiscountPercent:
      normalValueCents > 0 ? Math.round((discountCents / normalValueCents) * 100) : 0,
    bulkDiscountCents: discountCents,
    // The grid prices A3 directly, so nothing is multiplied any more.
    paperSizeMultiplier: 1,
    totalPriceInCents,
    rateCard: legacy,
    calculatedAt: new Date().toISOString(),

    appliedRate: cell,
    normalValueCents,
    bulkApplied,
    bulkThresholdCents: card.bulkThresholdCents,
    firstCopyRateCents,
    additionalCopyRateCents,
    rateCardSnapshot: card,
  };
}

/**
 * The grid a shop starts with, derived from a flat rate card.
 *
 * Used to seed a new shop and to answer for one whose grid predates this, and
 * it reproduces the old calculator exactly — A4 and Letter at the stated rate,
 * A3 multiplied and rounded the same way the old code rounded it.
 */
export function buildDefaultRateCard(
  config: MerchantPricingConfig = DEFAULT_PRICING_CONFIG
): ShopRateCard {
  const rates: ShopRate[] = rateGridKeys().map(({ paperSize, isColor, isDuplex }) => {
    const base = isColor
      ? (isDuplex ? config.colorDuplexPerPageCents : config.colorSinglePerPageCents)
      : (isDuplex ? config.bwDuplexPerPageCents : config.bwSinglePerPageCents);

    const perPageCents =
      paperSize === 'A3' ? Math.round(base * (config.a3Multiplier || 2)) : base;

    const percent = config.bulkDiscountPercent ?? 0;

    return {
      paperSize,
      isColor,
      isDuplex,
      perPageCents,
      bulkPerPageCents: percent > 0 ? Math.round((perPageCents * (100 - percent)) / 100) : null,
      additionalCopyPerPageCents: null,
      enabled: true,
    };
  });

  const threshold = config.bulkDiscountThreshold ?? 0;
  const percent = config.bulkDiscountPercent ?? 0;

  // Derived from the cheapest rate in the grid, not an arbitrary one. Any
  // dearer basis would put the threshold beyond the reach of the cheapest
  // configurations, so an order that qualified for a discount under the old
  // sheet-count rule would quietly cost more under this one.
  const cheapestRate = rates.reduce((min, r) => Math.min(min, r.perPageCents), Infinity);

  return {
    rates,
    bulkEnabled: percent > 0 && threshold > 0,
    bulkThresholdCents: Math.max(1, threshold * (Number.isFinite(cheapestRate) ? cheapestRate : config.bwSinglePerPageCents)),
    additionalCopyEnabled: false,
  };
}
