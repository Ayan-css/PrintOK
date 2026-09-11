(function () {
  'use strict';

  // ===========================================================================
  // PRICING — PLACEHOLDER VALUES, NOT YET AGREED
  //
  // PRD section 41 leaves the commercial model explicitly undecided ("per-print
  // platform fee; percentage transaction fee; shop subscription; hybrid model...
  // remains a business decision"). The numbers below are illustrative so the
  // page renders, and MUST be replaced with real figures before this site is
  // promoted publicly. They are gathered here, in one block, so changing them
  // is a single edit and never a hunt through markup.
  //
  // The admin console is the source of truth for what a shop is actually
  // charged: tier and commission are set per shop there. Keep these in step.
  // ===========================================================================
  const PRICING_IS_PLACEHOLDER = true;

  const PRICING = [
    {
      tier: 'free',
      name: 'Free',
      price: '₹0',
      cadence: 'per month',
      tagline: 'Get your counter online.',
      commission: '8% per paid job',
      features: [
        '1 printer',
        'QR poster for your counter',
        'Customer pays by UPI or card',
        'Live job queue',
        'Email support',
      ],
      cta: 'Start free',
      highlighted: false,
    },
    {
      tier: 'starter',
      name: 'Starter',
      price: '₹299',
      cadence: 'per month',
      tagline: 'For a shop printing every day.',
      commission: '5% per paid job',
      features: [
        'Up to 3 printers',
        'Custom rate card per shop',
        'Bulk and duplex pricing',
        'Revenue analytics',
        'Instant payouts',
      ],
      cta: 'Choose Starter',
      highlighted: true,
    },
    {
      tier: 'pro',
      name: 'Pro',
      price: '₹799',
      cadence: 'per month',
      tagline: 'For multi-counter and multi-branch shops.',
      commission: '2.5% per paid job',
      features: [
        'Unlimited printers',
        'Multiple connected PCs',
        'Staff accounts',
        'Priority support',
        'Onboarding help',
      ],
      cta: 'Choose Pro',
      highlighted: false,
    },
  ];

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderPricing() {
    const grid = document.getElementById('pricingGrid');
    if (!grid) return;

    grid.innerHTML = PRICING.map((plan) => `
      <article class="price-card${plan.highlighted ? ' price-card--featured' : ''}">
        ${plan.highlighted ? '<div class="price-badge">Most popular</div>' : ''}
        <h3>${escapeHtml(plan.name)}</h3>
        <p class="price-tagline">${escapeHtml(plan.tagline)}</p>
        <div class="price-amount">
          <span class="price-figure">${escapeHtml(plan.price)}</span>
          <span class="price-cadence">${escapeHtml(plan.cadence)}</span>
        </div>
        <div class="price-commission">+ ${escapeHtml(plan.commission)}</div>
        <ul class="price-features">
          ${plan.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}
        </ul>
        <a href="/register?plan=${encodeURIComponent(plan.tier)}"
           class="btn ${plan.highlighted ? 'btn-primary' : 'btn-outline'} btn-block">
          ${escapeHtml(plan.cta)}
        </a>
      </article>
    `).join('');

    const footnote = document.getElementById('pricingFootnote');
    if (footnote) {
      footnote.textContent = PRICING_IS_PLACEHOLDER
        ? 'Indicative pricing — final plans and commission rates are being confirmed.'
        : 'Commission is charged only on jobs a customer actually pays for.';
    }
  }

  // Smooth in-page navigation, without breaking the back button.
  function wireAnchors() {
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
      anchor.addEventListener('click', (event) => {
        const id = anchor.getAttribute('href').slice(1);
        const target = document.getElementById(id);
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', `#${id}`);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderPricing();
    wireAnchors();
  });
})();
