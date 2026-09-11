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

  // ===========================================================================
  // CONTACT EMAIL — PLACEHOLDER, REPLACE BEFORE LAUNCH
  //
  // Shown on the page and used as the fallback if the API is unreachable. It is
  // deliberately an example.com address: a made-up address on a real domain
  // would look genuine while silently dropping every message sent to it.
  //
  // Set CONTACT_EMAIL_IS_PLACEHOLDER to false once this is a real inbox.
  // Enquiries are stored by the API regardless, so nothing is lost meanwhile.
  // ===========================================================================
  const CONTACT_EMAIL = 'your-support-address@example.com';
  const CONTACT_EMAIL_IS_PLACEHOLDER = true;

  const API_BASE = window.PRINTOK_API_BASE
    || (location.hostname === 'localhost' ? 'http://localhost:4000' : 'https://prinok-api.onrender.com');

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
        <div class="plan-price">
          <span class="plan-figure">${escapeHtml(plan.price)}</span>
          <span class="plan-cadence">${escapeHtml(plan.cadence)}</span>
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
    renderPricing();
    wireAnchors();
    wireHeroRotator();
    wireHeroFlow();
    wireCounters();
    wireReveals();
    renderContactEmail();
    wireContactForm();
  });
})();
