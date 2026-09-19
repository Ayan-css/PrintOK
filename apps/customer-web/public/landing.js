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
      tier: 'free', name: 'Free', monthlyPriceCents: 0, platformFeeBps: 200,
      maxOrdersPerMonth: 100, maxPrinters: 1, maxStaff: 1,
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
      tier: 'starter', name: 'Starter', monthlyPriceCents: 14900, platformFeeBps: 100,
      maxOrdersPerMonth: 1000, maxPrinters: 2, maxStaff: 3,
      tagline: 'For a shop printing every day.',
      features: ['Everything in Free', 'Bulk and duplex pricing', 'Revenue analytics', 'A second printer and three sign-ins'],
    },
    {
      tier: 'business', name: 'Business', monthlyPriceCents: 34900, platformFeeBps: 50,
      maxOrdersPerMonth: 4000, maxPrinters: 5, maxStaff: 8,
      tagline: 'For a busy counter running several printers.',
      features: ['Everything in Starter', 'Multiple connected PCs', 'Priority support', 'Onboarding help'],
      popular: true,
    },
    {
      tier: 'pro', name: 'Pro', monthlyPriceCents: 69900, platformFeeBps: 0,
      maxOrdersPerMonth: 10000, maxPrinters: 10, maxStaff: 15,
      tagline: 'For print shops and multi-counter operations.',
      features: ['Everything in Business', 'No PrintOk platform fee at all', 'Highest order volume', 'Dedicated support contact'],
    },
  ];

  const FALLBACK_GATEWAY = {
    label: 'Razorpay 2% + 18% GST',
    note: 'Charged by Razorpay and deducted before settlement. Separate from the PrintOk platform fee.',
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
          ${escapeHtml(percent(plan.platformFeeBps ?? plan.commissionBps))} PrintOk platform fee per order
        </div>

        <dl class="plan-limits">
          <div><dt>Orders</dt><dd>${plan.maxOrdersPerMonth.toLocaleString('en-IN')}/month</dd></div>
          <div><dt>Printers</dt><dd>${plan.maxPrinters}</dd></div>
          <div><dt>Staff</dt><dd>${plan.maxStaff ?? 1}</dd></div>
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
      // Stated plainly: the gateway fee is not ours, and on Pro — where our own
      // fee is zero — it is the only per-order charge there is. A shop finding
      // that out from its payout instead of this page would rightly feel misled,
      // and "0% platform fee" must never be read as "nothing is deducted".
      footnote.textContent =
        `Razorpay payment processing charges (${gateway.label}) are separate from the PrintOk ` +
        'platform fee. They are billed by Razorpay and deducted before settlement — PrintOk ' +
        'does not absorb them. The platform fee applies only to orders placed through PrintOk.';
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

  /**
   * Rotating phrase in the headline.
   *
   * Skipped entirely when the visitor has asked for reduced motion, and the
   * element keeps its initial text so the headline always reads as a sentence.
   */
  function wireHeroRotator() {
    const el = document.getElementById('heroRotator');
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const phrases = [
      'an instant print station',
      'a self-service counter',
      'a queue that runs itself',
      'a shop that never explains twice',
    ];

    let index = 0;
    setInterval(() => {
      index = (index + 1) % phrases.length;
      el.classList.add('is-swapping');
      setTimeout(() => {
        el.textContent = phrases[index];
        el.classList.remove('is-swapping');
      }, 260);
    }, 3200);
  }

  /** Steps in the hero flow light up in sequence, suggesting the job moving. */
  function wireHeroFlow() {
    const flow = document.getElementById('heroFlow');
    if (!flow || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const steps = [...flow.querySelectorAll('[data-flow-step]')];
    if (!steps.length) return;

    let active = 0;
    setInterval(() => {
      steps.forEach((s, i) => s.classList.toggle('is-active', i === active));
      active = (active + 1) % steps.length;
    }, 1400);
  }

  /** Counts the hero figures up once, the first time they are scrolled into view. */
  function wireCounters() {
    const counters = [...document.querySelectorAll('[data-count-to]')];
    if (!counters.length) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const run = (el) => {
      const target = Number(el.getAttribute('data-count-to')) || 0;
      if (reduced || target === 0) {
        el.textContent = String(target);
        return;
      }

      const duration = 900;
      const start = performance.now();
      const tick = (now) => {
        const progress = Math.min((now - start) / duration, 1);
        el.textContent = String(Math.round(target * progress));
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    if (typeof IntersectionObserver !== 'function') {
      counters.forEach(run);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        run(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.4 });

    counters.forEach((el) => observer.observe(el));
  }

  /** Reveals sections as they scroll into view. Purely decorative. */
  function wireReveals() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof IntersectionObserver !== 'function') return;

    const targets = document.querySelectorAll(
      '.feature-card, .benefit, .price-card, .arch-node, .faq-item, .contact-card'
    );

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12 });

    targets.forEach((el) => {
      el.classList.add('reveal');
      observer.observe(el);
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
