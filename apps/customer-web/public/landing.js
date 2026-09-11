(function () {
  'use strict';

  const API_BASE = window.PRINTOK_API_BASE
    || (location.hostname === 'localhost' ? 'http://localhost:4000' : 'https://prinok-api.onrender.com');

  // ===========================================================================
  // CONTACT EMAIL — PLACEHOLDER, REPLACE BEFORE LAUNCH
  //
  // Deliberately an example.com address: a made-up address on a real domain
  // would look genuine while silently dropping every message sent to it.
  // Set CONTACT_EMAIL_IS_PLACEHOLDER to false once this is a real inbox.
  // Enquiries are stored by the API regardless, so nothing is lost meanwhile.
  // ===========================================================================
  const CONTACT_EMAIL = 'your-support-address@example.com';
  const CONTACT_EMAIL_IS_PLACEHOLDER = true;

  // ===========================================================================
  // PRICING
  //
  // Mirrors PLAN_CATALOGUE in @printok/shared-types, which is what the API
  // actually charges. The page fetches /api/plans and renders that; this copy
  // is the fallback for when the API is asleep or unreachable, so the pricing
  // section is never blank.
  //
  // A test asserts these figures match the catalogue, so the two cannot drift.
  // ===========================================================================
  const FALLBACK_PLANS = [
    {
      tier: 'start', name: 'Start', monthlyPriceCents: 0, commissionBps: 800,
      maxOrdersPerMonth: 100, maxPrinters: 1,
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
      tier: 'smart', name: 'Smart', monthlyPriceCents: 7900, commissionBps: 400,
      maxOrdersPerMonth: 500, maxPrinters: 2,
      tagline: 'For a shop printing every day.',
      features: ['Everything in Start', 'Bulk and duplex pricing', 'Revenue analytics', 'Instant payouts'],
    },
    {
      tier: 'business', name: 'Business', monthlyPriceCents: 24900, commissionBps: 200,
      maxOrdersPerMonth: 2500, maxPrinters: 5,
      tagline: 'For a busy counter running several printers.',
      features: ['Everything in Smart', 'Multiple connected PCs', 'Priority support', 'Onboarding help'],
      popular: true,
    },
    {
      tier: 'enterprise', name: 'Enterprise', monthlyPriceCents: 59900, commissionBps: 50,
      maxOrdersPerMonth: 10000, maxPrinters: 10,
      tagline: 'For print shops and multi-counter operations.',
      features: ['Everything in Business', 'Lowest service fee', 'Highest order volume', 'Dedicated support contact'],
    },
  ];

  const FALLBACK_GATEWAY = {
    label: 'Razorpay 2% + 18% GST',
    note: 'Charged by Razorpay and deducted before settlement. Separate from the PrintOk service fee.',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  const rupees = (cents) => '\u20B9' + (cents / 100).toLocaleString('en-IN');
  const percent = (bps) => {
    const value = bps / 100;
    return (Number.isInteger(value) ? value : value.toFixed(1)) + '%';
  };

  function planCardHtml(plan) {
    return `
      <article class="price-card${plan.popular ? ' price-card--featured' : ''}">
        ${plan.popular ? '<div class="price-badge">Most popular</div>' : ''}
        <h3>${escapeHtml(plan.name)}</h3>
        <p class="price-tagline">${escapeHtml(plan.tagline)}</p>

        <div class="plan-price">
          <span class="plan-figure">${escapeHtml(
            plan.monthlyPriceCents === 0 ? 'Free' : rupees(plan.monthlyPriceCents)
          )}</span>
          ${plan.monthlyPriceCents === 0
            ? '<span class="plan-cadence">forever</span>'
            : '<span class="plan-cadence">per month</span>'}
        </div>

        <div class="price-commission">
          ${escapeHtml(percent(plan.commissionBps))} PrintOk service fee per order
        </div>

        <dl class="plan-limits">
          <div><dt>Orders</dt><dd>${plan.maxOrdersPerMonth.toLocaleString('en-IN')}/month</dd></div>
          <div><dt>Printers</dt><dd>${plan.maxPrinters}</dd></div>
        </dl>

        <ul class="price-features">
          ${plan.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}
        </ul>

        <a href="/register?plan=${encodeURIComponent(plan.tier)}"
           class="btn ${plan.popular ? 'btn-primary' : 'btn-outline'} btn-block">
          ${escapeHtml(plan.monthlyPriceCents === 0 ? 'Start free' : `Choose ${plan.name}`)}
        </a>
      </article>`;
  }

  function renderPricing(plans, gateway) {
    const grid = document.getElementById('pricingGrid');
    if (!grid) return;

    grid.innerHTML = plans.map(planCardHtml).join('');

    const footnote = document.getElementById('pricingFootnote');
    if (footnote) {
      // Stated plainly: the gateway fee is not ours, and on Enterprise it is
      // several times larger than our own. A shop finding that out from its
      // payout instead of this page would rightly feel misled.
      footnote.textContent =
        `Payment gateway charges (${gateway.label}) are billed by Razorpay and deducted before ` +
        'settlement. They are separate from the PrintOk service fee. ' +
        'The service fee applies only to orders placed through PrintOk.';
    }
  }

  /** Prefers the live catalogue so the page can never show a stale price. */
  async function loadPricing() {
    try {
      const res = await fetch(`${API_BASE}/api/plans`);
      if (!res.ok) throw new Error('unavailable');
      const body = await res.json();
      renderPricing(body.plans, body.paymentGateway || FALLBACK_GATEWAY);
    } catch {
      renderPricing(FALLBACK_PLANS, FALLBACK_GATEWAY);
    }
  }

  /** Renders the contact address from the single constant above. */
  function renderContactEmail() {
    document.querySelectorAll('[data-contact-email]').forEach((el) => {
      el.textContent = CONTACT_EMAIL;
      if (el.tagName === 'A') el.setAttribute('href', `mailto:${CONTACT_EMAIL}`);
    });

    const note = document.getElementById('contactEmailNote');
    if (note && CONTACT_EMAIL_IS_PLACEHOLDER) {
      note.textContent = 'Placeholder address — messages sent here are not monitored. Use the form.';
      note.hidden = false;
    }
  }

  /**
   * Contact form.
   *
   * Posts to the API, which stores the enquiry. Storing rather than emailing
   * means a message cannot be lost to an unconfigured mail provider, and the
   * placeholder address above stays harmless until it is replaced.
   */
  function wireContactForm() {
    const form = document.getElementById('contactForm');
    if (!form) return;

    const status = document.getElementById('contactStatus');
    const button = document.getElementById('btnContactSubmit');

    const show = (kind, text) => {
      status.className = `alert alert-${kind}`;
      status.textContent = text;
      status.hidden = false;
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const payload = {
        name: document.getElementById('contactName').value.trim(),
        email: document.getElementById('contactEmail').value.trim(),
        phone: document.getElementById('contactPhone').value.trim(),
        shopName: document.getElementById('contactShop').value.trim(),
        message: document.getElementById('contactMessage').value.trim(),
        // Honeypot: hidden from people, tempting to bots.
        website: document.getElementById('contactWebsite').value,
      };

      if (!payload.name || !payload.email || !payload.message) {
        show('danger', 'Please fill in your name, email and message.');
        return;
      }

      button.disabled = true;
      const originalLabel = button.textContent;
      button.textContent = 'Sending...';

      try {
        const res = await fetch(`${API_BASE}/api/contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) throw new Error(body.error || 'Could not send your message.');

        form.reset();
        show('success', 'Thanks — your message reached us. We will reply by email.');
      } catch (err) {
        // Never leave someone with a message they think was sent.
        show('danger', `${err.message} You can also write to ${CONTACT_EMAIL}.`);
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });
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
    loadPricing();
    wireAnchors();
    wireHeroRotator();
    wireHeroFlow();
    wireCounters();
    wireReveals();
    renderContactEmail();
    wireContactForm();
  });
})();
