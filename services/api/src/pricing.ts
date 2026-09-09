import { MerchantPricingConfig } from '@printok/shared-types';

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

