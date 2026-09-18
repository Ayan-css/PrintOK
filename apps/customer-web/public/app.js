/**
 * PrintOk Web Application Client
 * Multi-page support, Document Preview, Automatic Page Detection, Custom Page Ranges & Redirects.
 */

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = window.PRINTOK_API_BASE
    || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? 'http://localhost:4000'
      : 'https://prinok-api.onrender.com');

  /** A fresh idempotency key. crypto.randomUUID where available, else random. */
  function newSubmissionKey() {
    try {
      if (window.crypto?.randomUUID) return `job-${window.crypto.randomUUID()}`;
    } catch { /* fall through */ }
    return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // must match the "Max 25MB" promise in the drop zone

  // State Variables
  let selectedFile = null;
  let fileBase64 = null;
  let isColor = false;
  let isDuplex = false;
  let paperSize = 'A4';
  let copies = 1;
  let detectedTotalPages = 1;
  let pageCount = 1;
  let pageRangeMode = 'all'; // 'all' or 'custom'
  let customPageRange = '';
  let orientation = 'auto'; // 'auto' | 'portrait' | 'landscape'
  /**
   * Identifies this submission across retries.
   *
   * Regenerated whenever a different file is chosen, so a genuinely new order
   * is a new key, while every retry of the same order — a double tap, a
   * reconnect, a resubmit after a payment popup closed — carries the one the
   * server already knows.
   */
  let submissionKey = newSubmissionKey();
  let currentPrinterId = null;
  let currentShopId = null; // resolved from the printer, then used to price the order
  let pollingTimer = null;
  let healthCheckTimer = null;
  let previewObjectUrl = null;
  let rerenderPrice = null; // set by the customer screen so async pricing can refresh the quote

  // Detect current page route
  const pathname = window.location.pathname.toLowerCase();
  const isRegisterPage = pathname.includes('/register') || pathname.includes('/registration') || pathname.includes('register.html');
  const isDashboardPage = pathname.includes('/dashboard') || pathname.includes('dashboard.html');

  // ============================================================
  //  SHARED HELPERS
  // ============================================================

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatRupees(cents) {
    return `₹${((Number(cents) || 0) / 100).toFixed(2)}`;
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to the legacy path below
    }

    // Fallback for insecure origins / older mobile browsers
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Remembers which shop/printer this browser registered, so the dashboard
   * shows real data instead of a hardcoded placeholder shop.
   */
  /**
   * Merchant session.
   *
   * Shop endpoints now require a signed-in merchant, so the dashboard carries a
   * token rather than trusting a shop id held in browser storage. Kept in
   * sessionStorage so it dies with the tab.
   */
  /**
   * The merchant session.
   *
   * Kept in localStorage, not sessionStorage. sessionStorage dies with the
   * browser, which meant a shop owner signed in again every single morning
   * even though their token was usually still valid — the browser had simply
   * thrown it away.
   *
   * The counter-PC concern that motivated sessionStorage is real and is
   * answered differently: there is a sign-out button on every merchant screen
   * now, which is the deliberate way to hand the machine over, and the token
   * itself still expires twelve hours after it was last used. What changed is
   * that closing a browser is no longer treated as signing out, because nobody
   * means it that way.
   *
   * The admin console deliberately stays on sessionStorage: a token that shows
   * every shop's revenue should die with the tab.
   */
  const MerchantSession = {
    KEY: 'printok_merchant_token',
    get() {
      try {
        const stored = localStorage.getItem(this.KEY);
        if (stored) return stored;

        // Adopt a token left by the previous build, so upgrading does not sign
        // everyone out mid-shift.
        const legacy = sessionStorage.getItem(this.KEY);
        if (legacy) {
          this.set(legacy);
          return legacy;
        }
        return null;
      } catch { return null; }
    },
    set(token) {
      try {
        if (token) localStorage.setItem(this.KEY, token);
        else localStorage.removeItem(this.KEY);
        // Either way the old location must not keep a copy.
        sessionStorage.removeItem(this.KEY);
      } catch { /* private browsing */ }
    },
    /** Stores a token the server renewed on this request, if it sent one. */
    adopt(res) {
      try {
        const renewed = res.headers.get('x-printok-session-renewed');
        if (renewed) this.set(renewed);
      } catch { /* header unreadable; the existing token is still good */ }
    },
    headers(extra = {}) {
      const token = this.get();
      return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
    },
  };

  /**
   * Starts an agent-config download.
   *
   * The file carries the printer's agent API key, so the link cannot simply be
   * an href: a plain URL would be fetchable by anyone who knew the printer id,
   * and printer ids are public. Instead the session mints a short-lived,
   * single-use, printer-scoped token here and the browser then navigates to
   * that. The permanent key is never in a URL.
   */
  async function downloadAgentConfig(printerId, button) {
    if (!printerId) return;
    const label = button ? button.textContent : null;
    try {
      if (button) { button.disabled = true; button.textContent = 'Preparing…'; }

      const res = await shopFetch(`/api/printers/${encodeURIComponent(printerId)}/agent-config-token`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Could not authorise the download.');

      const { url } = await res.json();
      // Navigation rather than fetch+blob so the browser's own download UI
      // handles it, including the filename the server sets.
      window.location.assign(`${API_BASE}${url}`);
    } catch (err) {
      showToast('error', 'Download failed', err.message || 'Could not download the config file.');
    } finally {
      if (button) { button.disabled = false; if (label) button.textContent = label; }
    }
  }

  /** Shop-scoped fetch. A 401 drops straight back to sign-in. */
  async function shopFetch(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: MerchantSession.headers(options.headers || {}),
    });
    MerchantSession.adopt(res);
    if (res.status === 401) {
      MerchantSession.set(null);
      const login = document.getElementById('merchantLoginView');
      const dash = document.getElementById('dashboardView');
      if (login && dash) { login.hidden = false; dash.hidden = true; }
      throw new Error('Your session has ended. Sign in again.');
    }
    return res;
  }

  const ShopContext = {
    read() {
      let stored = { shopId: null, printerId: null };
      try {
        const raw = localStorage.getItem('printok.shopContext');
        if (raw) stored = { ...stored, ...JSON.parse(raw) };
      } catch {
        // localStorage can be unavailable (private mode / blocked cookies)
      }

      // The URL overrides what is stored, but only field by field. Opening the
      // dashboard with just ?printer=<id> used to discard the stored shop id
      // along with it, which left the whole dashboard in its no-shop state.
      const params = new URLSearchParams(window.location.search);
      return {
        shopId: params.get('shop') || stored.shopId || null,
        printerId: params.get('printer') || stored.printerId || null,
      };
    },
    write(ctx) {
      try {
        localStorage.setItem('printok.shopContext', JSON.stringify(ctx));
      } catch {
        // non-fatal: the dashboard just won't remember across reloads
      }
    },
  };

  /**
   * Who placed the order, when the shop asked.
   *
   * Absent for shops that collect nothing, which is most of them — so this
   * renders nothing at all rather than an empty row of dashes. The number is a
   * tel: link because the entire reason for collecting it is to ring someone
   * about an uncollected or wrong printout, usually from a phone.
   */
  function customerLine(job) {
    const name = job.customerName ? escapeHtml(job.customerName) : '';
    const phone = job.customerPhone ? escapeHtml(job.customerPhone) : '';
    if (!name && !phone) return '';

    const parts = [];
    if (name) parts.push(`<strong>${name}</strong>`);
    if (phone) parts.push(`<a href="tel:${encodeURIComponent(job.customerPhone)}">${phone}</a>`);

    return `<div class="queue-customer">${parts.join(' · ')}</div>`;
  }

  // Human-facing labels for the backend PrintState enum
  const PRINT_STATE_LABELS = {
    Created: 'Created',
    AwaitingPayment: 'Awaiting Payment',
    // Not an error: this shop releases each job by hand.
    HeldForRelease: 'Waiting for you',
    Queued: 'Queued',
    Downloading: 'Sent to Printer',
    Printing: 'Printing',
    Printed: 'Printed',
    Completed: 'Completed',
    Failed: 'Failed',
    Cancelled: 'Cancelled',
    RequiresShopAction: 'Needs Shop Action',
  };

  const PRINT_STATE_BADGES = {
    AwaitingPayment: 'badge-neutral',
    Queued: 'badge-queued',
    Downloading: 'badge-download',
    Printing: 'badge-printing',
    Printed: 'badge-success',
    Completed: 'badge-success',
    Failed: 'badge-danger',
    Cancelled: 'badge-danger',
    RequiresShopAction: 'badge-danger',
  };

  const TERMINAL_STATES = ['Completed', 'Failed', 'Cancelled'];

  // ============================================================
  //  TOAST NOTIFICATION SYSTEM
  // ============================================================
  const toastContainer = document.getElementById('toastContainer');

  function showToast(type, title, message, duration = 4000) {
    if (!toastContainer) return;
    const icons = {
      success: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="2 8 6 12 14 4"/></svg>`,
      warning: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2L15 14H1L8 2z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r="0.5" fill="currentColor"/></svg>`,
      danger:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>`,
      info:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/><line x1="8" y1="6" x2="8" y2="6"/><line x1="8" y1="9" x2="8" y2="12"/></svg>`,
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    // Titles/messages carry API errors and file names — escape before injecting.
    toast.innerHTML = `
      <div class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</div>
      <div class="toast-body">
        <div class="toast-title">${escapeHtml(title)}</div>
        ${message ? `<div class="toast-msg">${escapeHtml(message)}</div>` : ''}
      </div>
      <button class="toast-close" type="button" aria-label="Dismiss notification">&times;</button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
    toastContainer.appendChild(toast);

    const timer = setTimeout(() => dismissToast(toast), duration);
    toast._timer = timer;
  }

  function dismissToast(toast) {
    if (!toast) return;
    clearTimeout(toast._timer);
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }

  // ============================================================
  //  0. GLOBAL NAV — point "Customer View" at this browser's real shop
  // ============================================================
  // ============================================================
  //  1. SHOP REGISTRATION DRIVER (/register, /registration, register.html)
  // ============================================================
  if (isRegisterPage) {
    const btnNextStep1 = document.getElementById('btnNextStep1');
    const btnPrevStep2 = document.getElementById('btnPrevStep2');
    const btnNextStep2 = document.getElementById('btnNextStep2');
    const btnPrevStep3 = document.getElementById('btnPrevStep3');
    const btnSubmitRegister = document.getElementById('btnSubmitRegister');

    const formStep1 = document.getElementById('formStep1');
    const formStep2 = document.getElementById('formStep2');
    const formStep3 = document.getElementById('formStep3');
    const formStep4 = document.getElementById('formStep4');

    const stepNav1 = document.getElementById('stepNav1');
    const stepNav2 = document.getElementById('stepNav2');
    const stepNav3 = document.getElementById('stepNav3');
    const stepNav4 = document.getElementById('stepNav4');

    let selectedPlan = 'free';

    const planPills = [
      { id: 'planPillFree', val: 'free' },
      { id: 'planPillStarter', val: 'starter' },
      { id: 'planPillGrowth', val: 'growth' },
      { id: 'planPillScale', val: 'scale' }
    ];

    function selectPlan(pillId, value) {
      selectedPlan = value;
      planPills.forEach(other => {
        const oEl = document.getElementById(other.id);
        if (oEl) oEl.classList.toggle('active', other.id === pillId);
      });
    }

    planPills.forEach(p => {
      const el = document.getElementById(p.id);
      if (!el) return;
      el.addEventListener('click', () => selectPlan(p.id, p.val));
      // Keyboard users move between the radios with arrow keys; keep the pill in sync.
      const radio = el.querySelector('input[type="radio"]');
      if (radio) radio.addEventListener('change', () => selectPlan(p.id, p.val));
    });

    if (btnNextStep1) {
      btnNextStep1.addEventListener('click', () => {
        const shopName = document.getElementById('regShopName').value.trim();
        const ownerEmail = document.getElementById('regOwnerEmail').value.trim();
        const printerName = document.getElementById('regPrinterName').value.trim();

        if (!shopName || !ownerEmail || !printerName) {
          showToast('warning', 'Missing Details', 'Please fill in Shop Name, Email, and Printer Model.');
          return;
        }

        formStep1.hidden = true;
        formStep2.hidden = false;
        stepNav1.classList.remove('active');
        stepNav2.classList.add('active');
      });
    }

    if (btnPrevStep2) {
      btnPrevStep2.addEventListener('click', () => {
        formStep2.hidden = true;
        formStep1.hidden = false;
        stepNav2.classList.remove('active');
        stepNav1.classList.add('active');
      });
    }

    if (btnNextStep2) {
      btnNextStep2.addEventListener('click', () => {
        const upiId = document.getElementById('regUpiId').value.trim();
        if (!upiId) {
          showToast('warning', 'UPI Required', 'Please enter your Payout UPI ID.');
          return;
        }

        const missing = [
          ['regContactPhone', 'Contact phone'],
          ['regAddressStreet1', 'Street address'],
          ['regAddressCity', 'City'],
          ['regAddressState', 'State'],
          ['regAddressPostalCode', 'PIN code'],
        ].filter(([id]) => !(document.getElementById(id) || {}).value?.trim())
         .map(([, label]) => label);

        if (missing.length) {
          showToast('warning', 'Business details needed',
            `${missing.join(', ')} — Razorpay cannot settle payments to you without these.`);
          return;
        }

        formStep2.hidden = true;
        formStep3.hidden = false;
        stepNav2.classList.remove('active');
        stepNav3.classList.add('active');
      });
    }

    if (btnPrevStep3) {
      btnPrevStep3.addEventListener('click', () => {
        formStep3.hidden = true;
        formStep2.hidden = false;
        stepNav3.classList.remove('active');
        stepNav2.classList.add('active');
      });
    }

    if (btnSubmitRegister) {
      btnSubmitRegister.addEventListener('click', async () => {
        const shopName = document.getElementById('regShopName').value.trim();
        const ownerEmail = document.getElementById('regOwnerEmail').value.trim();
        const printerName = document.getElementById('regPrinterName').value.trim();
        const upiId = document.getElementById('regUpiId').value.trim();
        const password = document.getElementById('regPassword').value;
        const val = (id) => (document.getElementById(id)?.value || '').trim();

        if (!password || password.length < 12) {
          showToast('warning', 'Password too short',
            'Choose at least 12 characters, with upper case, lower case and a digit.');
          return;
        }

        btnSubmitRegister.disabled = true;
        btnSubmitRegister.textContent = 'Creating your shop account...';

        try {
          // Signup creates the shop, its printer and the owner account together,
          // so a shop is never left with nobody able to sign in to it.
          const res = await fetch(`${API_BASE}/api/merchant/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              shopName, ownerEmail, printerName, upiId, password, plan: selectedPlan,
              // Stored on the shop so Route onboarding has them already, rather
              // than asking again at the moment the shop wants to be paid.
              contactPhone: val('regContactPhone'),
              addressStreet1: val('regAddressStreet1'),
              addressStreet2: val('regAddressStreet2'),
              addressCity: val('regAddressCity'),
              addressState: val('regAddressState'),
              addressPostalCode: val('regAddressPostalCode'),
              addressCountry: 'IN',
            }),
          });

          const data = await res.json();
          if (res.ok && data.shop && data.printer) {
            // Signed in immediately, so the dashboard works without a second step.
            if (data.token) MerchantSession.set(data.token);
            formStep3.hidden = true;
            formStep4.hidden = false;
            stepNav3.classList.remove('active');
            stepNav4.classList.add('active');

            // Remember this shop so the dashboard and nav resolve to it later.
            ShopContext.write({ shopId: data.shop.id, printerId: data.printer.id });

            document.getElementById('resShopTitle').textContent = data.shop.name;
            document.getElementById('resPrinterTitle').textContent = data.printer.printerName;
            document.getElementById('resQrImage').src = data.printer.qrCodeDataUrl;
            document.getElementById('resQrUrlDisplay').textContent = `${window.location.origin}/?printer=${data.printer.id}`;
            document.getElementById('resShopId').textContent = data.shop.id;
            document.getElementById('resPrinterId').textContent = data.printer.id;
            document.getElementById('resApiKey').textContent = data.printer.apiKey;

            const btnDownloadAgentExe = document.getElementById('btnDownloadAgentExe');
            const btnDownloadAgentConfig = document.getElementById('btnDownloadAgentConfig');

            if (btnDownloadAgentExe) btnDownloadAgentExe.href = `${API_BASE}/api/agent-installer`;
            if (btnDownloadAgentConfig) {
              // Authorised per click, not a standing URL. See downloadAgentConfig.
              btnDownloadAgentConfig.removeAttribute('href');
              btnDownloadAgentConfig.addEventListener('click', (e) => {
                e.preventDefault();
                downloadAgentConfig(data.printer.id, btnDownloadAgentConfig);
              });
            }

            const btnGoToDashboard = document.getElementById('btnGoToDashboard');
            if (btnGoToDashboard) btnGoToDashboard.href = `/dashboard?shop=${encodeURIComponent(data.shop.id)}&printer=${encodeURIComponent(data.printer.id)}`;

            // Save the shop's opening rates so customers are quoted what the owner set.
            await saveInitialPricing(data.shop.id);

            const btnDownloadPosterPng = document.getElementById('btnDownloadPosterPng');
            if (btnDownloadPosterPng) {
              btnDownloadPosterPng.onclick = () => {
                const a = document.createElement('a');
                a.href = data.printer.qrCodeDataUrl;
                a.download = `PrintOk_QR_${data.shop.name.replace(/\s+/g, '_')}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                showToast('info', 'QR Sign Downloaded', 'Print and place at shop counter.');
              };
            }

            showToast('success', '🎉 Shop & Plan Activated!', `Printer ID: ${data.printer.id}`);
          } else {
            showToast('danger', 'Error', data.error || 'Could not register shop.');
            btnSubmitRegister.disabled = false;
            btnSubmitRegister.textContent = '💳 Pay Upfront & Activate Shop';
          }
        } catch {
          showToast('danger', 'Network Error', 'Could not connect to API server.');
          btnSubmitRegister.disabled = false;
          btnSubmitRegister.textContent = '💳 Pay Upfront & Activate Shop';
        }
      });
    }

    /** Persist the per-page rates typed in step 2 — previously collected but never sent. */
    async function saveInitialPricing(shopId) {
      const toCents = (id) => {
        const el = document.getElementById(id);
        const val = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(val) ? Math.round(val * 100) : null;
      };

      const config = {
        bwSinglePerPageCents: toCents('regRateBwSingle'),
        bwDuplexPerPageCents: toCents('regRateBwDuplex'),
        colorSinglePerPageCents: toCents('regRateColorSingle'),
        colorDuplexPerPageCents: toCents('regRateColorDuplex'),
      };

      Object.keys(config).forEach(k => { if (config[k] === null) delete config[k]; });
      if (Object.keys(config).length === 0) return;

      try {
        await shopFetch(`/api/shops/${encodeURIComponent(shopId)}/pricing`, {
          method: 'POST',
          body: JSON.stringify(config),
        });
      } catch {
        showToast('warning', 'Rates Not Saved', 'Shop is live, but set your rates again from the dashboard.');
      }
    }
  }

  // ============================================================
  //  2. MERCHANT DASHBOARD DRIVER (/dashboard, dashboard.html)
  // ============================================================
  if (isDashboardPage) {
    // --- Theme --------------------------------------------------------------
    // The <head> has already applied any stored choice before first paint; this
    // only keeps the button in sync with it and records changes.
    // The theme toggle lives in /theme.js now, shared with Business Setup and
    // the admin console. Keeping a copy here would attach a second click
    // listener to the same button, so every press would toggle twice and the
    // theme would appear stuck.

    // --- Sign-in gate -------------------------------------------------------
    const loginView = document.getElementById('merchantLoginView');
    const dashboardView = document.getElementById('dashboardView');

    function showLogin(message) {
      if (loginView) loginView.hidden = false;
      if (dashboardView) dashboardView.hidden = true;
      if (message) {
        const box = document.getElementById('merchantAuthError');
        if (box) { box.textContent = message; box.hidden = false; }
      }
    }

    function showDashboard() {
      if (loginView) loginView.hidden = true;
      if (dashboardView) dashboardView.hidden = false;
    }

    const loginForm = document.getElementById('formMerchantLogin');
    if (loginForm) {
      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const box = document.getElementById('merchantAuthError');
        if (box) box.hidden = true;

        const button = document.getElementById('btnMerchantLogin');
        button.disabled = true;

        try {
          const res = await fetch(`${API_BASE}/api/merchant/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: document.getElementById('merchantEmail').value.trim(),
              password: document.getElementById('merchantPassword').value,
            }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || 'Sign in failed.');

          MerchantSession.set(body.token);
          ShopContext.write({ shopId: body.user.shopId, printerId: null });
          document.getElementById('merchantPassword').value = '';

          showDashboard();
          location.reload();
        } catch (err) {
          if (box) { box.textContent = err.message; box.hidden = false; }
        } finally {
          button.disabled = false;
        }
      });
    }

    const claimLink = document.getElementById('linkClaimShop');
    if (claimLink) {
      claimLink.addEventListener('click', async (event) => {
        event.preventDefault();
        const shopId = window.prompt('Your shop ID (shown on your QR poster or old dashboard):');
        if (!shopId) return;
        const email = window.prompt('The owner email your shop was registered with:');
        if (!email) return;
        const password = window.prompt('Choose a password (at least 12 characters, with upper, lower and a digit):');
        if (!password) return;

        try {
          const res = await fetch(`${API_BASE}/api/merchant/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shopId: shopId.trim(), ownerEmail: email.trim(), password }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || 'Could not claim that shop.');

          MerchantSession.set(body.token);
          ShopContext.write({ shopId: body.user.shopId, printerId: null });
          showToast('success', 'Shop claimed', 'You can now sign in with that email and password.');
          location.reload();
        } catch (err) {
          showToast('danger', 'Claim failed', err.message);
        }
      });
    }

    if (!MerchantSession.get()) {
      showLogin();
      return;
    }
    showDashboard();

    const ctx = ShopContext.read();
    let dashShopId = ctx.shopId || null;
    let dashPrinterId = ctx.printerId || null;
    // Resolved once from the session by resolveIdentity(), then reused so the
    // 8-second refresh does not re-fetch it.
    let identity = { shop: null, printer: null };
    // What the queue is currently showing. Sent to the server rather than
    // applied to a cached page, so the counts and the rows describe the same
    // set — and so searching finds an order from last month, not just the ones
    // that happened to be in the last fetch.
    let queueFilter = 'all';
    let queueSearch = '';
    let queueMonth = '';
    let queueCounts = null;
    let cachedJobs = [];
    let shopUpiId = null; // the shop's own payout UPI wins over the API's placeholder
    let dashTimer = null;

    const tabBtns = Array.from(document.querySelectorAll('.dash-tab-btn'));
    const tabPanes = Array.from(document.querySelectorAll('.dash-tab-pane'));

    function activateTab(btn) {
      const tabId = btn.getAttribute('data-tab');
      tabBtns.forEach(b => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      tabPanes.forEach(p => {
        const on = p.id === tabId;
        p.hidden = !on;
        p.classList.toggle('active', on);
      });
    }

    /**
     * Opens a tab from the URL hash, so a link can point at a section.
     *
     * #agent is the one that matters: Business Setup sends people here for the
     * printer and its pairing code, and landing on the queue instead would make
     * that link a lie.
     */
    const HASH_TABS = {
      '#agent': 'tabQr', '#queue': 'tabQueue',
      '#earnings': 'tabMoney', '#analytics': 'tabStats',
    };

    function activateTabFromHash() {
      const wanted = HASH_TABS[window.location.hash];
      if (!wanted) return;
      const btn = tabBtns.find((b) => b.getAttribute('data-tab') === wanted);
      if (btn) activateTab(btn);
    }

    activateTabFromHash();
    window.addEventListener('hashchange', activateTabFromHash);

    tabBtns.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        activateTab(btn);
        // Keep the URL honest, so a refresh or a shared link lands where the
        // person was rather than back on the queue.
        const hash = Object.entries(HASH_TABS)
          .find(([, id]) => id === btn.getAttribute('data-tab'))?.[0];
        if (hash) history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
      });
      // Arrow-key navigation is expected of a tablist.
      btn.addEventListener('keydown', (e) => {
        let next = null;
        if (e.key === 'ArrowRight') next = tabBtns[(idx + 1) % tabBtns.length];
        else if (e.key === 'ArrowLeft') next = tabBtns[(idx - 1 + tabBtns.length) % tabBtns.length];
        else if (e.key === 'Home') next = tabBtns[0];
        else if (e.key === 'End') next = tabBtns[tabBtns.length - 1];
        if (next) {
          e.preventDefault();
          activateTab(next);
          next.focus();
        }
      });
    });

    // --- Queue tabs, search and month ---

    const QUEUE_BUCKETS = [
      { id: 'all',        label: 'All' },
      { id: 'pending',    label: 'Pending' },
      { id: 'processing', label: 'Processing' },
      { id: 'printing',   label: 'Printing' },
      { id: 'failed',     label: 'Needs attention' },
      { id: 'rejected',   label: 'Rejected' },
      { id: 'done',       label: 'Done' },
    ];

    function renderQueueTabs() {
      const host = document.getElementById('queueTabs');
      if (!host) return;

      host.innerHTML = QUEUE_BUCKETS.map((b) => {
        const count = queueCounts ? (queueCounts[b.id] ?? 0) : null;
        const on = queueFilter === b.id;
        return `<button type="button" class="queue-tab ${on ? 'active' : ''}"
                        data-bucket="${b.id}" role="tab" aria-selected="${on}">
          ${escapeHtml(b.label)}${count === null ? '' : ` <span class="queue-tab-count">${count}</span>`}
        </button>`;
      }).join('');

      host.querySelectorAll('[data-bucket]').forEach((tab) => {
        tab.addEventListener('click', () => {
          queueFilter = tab.getAttribute('data-bucket') || 'all';
          renderQueueTabs();
          loadQueue();
        });
      });
    }

    const searchInput = document.getElementById('queueSearch');
    if (searchInput) {
      let timer = null;
      searchInput.addEventListener('input', () => {
        // Debounced: a shop owner typing a phone number should not fire eight
        // requests, and the queue already refreshes on its own timer.
        clearTimeout(timer);
        timer = setTimeout(() => {
          queueSearch = searchInput.value.trim();
          syncQueueClear();
          loadQueue();
        }, 250);
      });
    }

    const monthInput = document.getElementById('queueMonth');
    if (monthInput) {
      monthInput.addEventListener('change', () => {
        queueMonth = monthInput.value || '';
        syncQueueClear();
        loadQueue();
      });
    }

    function syncQueueClear() {
      const btn = document.getElementById('btnQueueClear');
      if (btn) btn.hidden = !queueSearch && !queueMonth;
    }

    const clearBtn = document.getElementById('btnQueueClear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        queueSearch = '';
        queueMonth = '';
        if (searchInput) searchInput.value = '';
        if (monthInput) monthInput.value = '';
        syncQueueClear();
        loadQueue();
      });
    }

    renderQueueTabs();

    // Ask the session which shop this is before deciding there isn't one. The
    // URL and localStorage are hints, not the authority, and a merchant who has
    // just signed in on a new browser has neither.
    (async () => {
      if (!dashShopId || !dashPrinterId) await resolveIdentity();

      if (!dashShopId) {
        showNoShopState();
        return;
      }
      loadDashboard();
      dashTimer = setInterval(loadDashboard, 8000);
      window.addEventListener('beforeunload', () => clearInterval(dashTimer));
    })();

    const btnRefreshQueue = document.getElementById('btnRefreshQueue');
    if (btnRefreshQueue) {
      btnRefreshQueue.addEventListener('click', () => {
        if (!dashShopId) {
          showToast('warning', 'No Shop Connected', 'Register a shop first, or open the dashboard with ?shop=<id>.');
          return;
        }
        loadDashboard();
        showToast('info', 'Refreshed', 'Queue metrics updated.');
      });
    }

    // --- QR poster actions ---
    const btnDownloadQr = document.getElementById('btnDownloadQr');
    if (btnDownloadQr) {
      btnDownloadQr.addEventListener('click', async () => {
        const img = document.getElementById('dashQrImg');
        if (!img || !img.src) {
          showToast('warning', 'No QR Yet', 'Connect a shop to generate its QR poster.');
          return;
        }

        const save = (href, filename, revoke) => {
          const a = document.createElement('a');
          a.href = href;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          if (revoke) setTimeout(() => URL.revokeObjectURL(href), 0);
        };

        const text = (id) => (document.getElementById(id)?.textContent || '').trim();

        // The bare QR square is the fallback, not the product. A shop that
        // prints a naked code gets customers who have no idea what it is for.
        if (!window.PrintOkPoster) {
          save(img.src, 'PrintOk_Shop_QR.png');
          showToast('info', 'QR Downloaded', 'Print and place at your shop counter.');
          return;
        }

        btnDownloadQr.disabled = true;
        try {
          const svg = window.PrintOkPoster.buildPosterSvg({
            shopName: text('dashQrShopName'),
            url: text('dashQrTargetUrl').replace(/^https?:\/\//, ''),
            qrDataUrl: img.src,
          });
          const blob = await window.PrintOkPoster.posterToPngBlob(svg, 2);
          save(URL.createObjectURL(blob), 'PrintOk_Counter_Poster.png', true);
          showToast('success', 'Poster Downloaded', 'A4 sign, ready to print and stick on the counter.');
        } catch {
          // Rendering is the browser's job and it can refuse. A merchant who
          // clicked download should still end up with something to print.
          save(img.src, 'PrintOk_Shop_QR.png');
          showToast('info', 'QR Downloaded', 'The full poster could not be built, so here is the code on its own.');
        } finally {
          btnDownloadQr.disabled = false;
        }
      });
    }

    const btnOpenCustomerView = document.getElementById('btnOpenCustomerView');
    if (btnOpenCustomerView) {
      btnOpenCustomerView.addEventListener('click', () => {
        if (!dashPrinterId) {
          showToast('warning', 'No Printer', 'Register a printer to test the customer flow.');
          return;
        }
        window.open(`/?printer=${encodeURIComponent(dashPrinterId)}`, '_blank', 'noopener');
      });
    }

    const btnCopyAgentConfig = document.getElementById('btnCopyAgentConfig');
    if (btnCopyAgentConfig) {
      btnCopyAgentConfig.addEventListener('click', async () => {
        const apiKey = document.getElementById('dashApiKey');
        if (!dashPrinterId || !apiKey || apiKey.textContent === '--') {
          showToast('warning', 'Nothing to Copy', 'Agent settings appear once a shop is connected.');
          return;
        }
        // Mirrors GET /api/printers/:id/agent-config. Both the flat keys and the
        // nested PrintOk section are emitted so pre-1.1.0 agents keep working.
        const settings = JSON.stringify({
          PrintOkApiUrl: API_BASE,
          AgentApiKey: apiKey.textContent,
          ShopId: dashShopId,
          PrinterId: dashPrinterId,
          PrinterName: '',
          PollIntervalMs: 3000,
          HeartbeatIntervalSeconds: 30,
          PrintOk: {
            ApiBaseUrl: API_BASE,
            ApiKey: apiKey.textContent,
            ShopId: dashShopId,
            PrinterId: dashPrinterId,
            PollIntervalMs: 3000,
            HeartbeatIntervalSeconds: 30,
          },
        }, null, 2);

        const ok = await copyToClipboard(settings);
        showToast(ok ? 'success' : 'danger',
          ok ? 'Settings Copied' : 'Copy Failed',
          ok ? 'Paste into appsettings.json next to PrintAgent.exe.' : 'Select the values manually instead.');
      });
    }

    // --- Agent pairing: each shop PC gets its own revocable credential ---

    let pairingCountdown = null;

    function renderPairedDevices(devices) {
      const list = document.getElementById('pairedDeviceList');
      if (!list) return;

      if (!devices || devices.length === 0) {
        list.innerHTML = '<div class="meta-text">No PCs paired yet.</div>';
        return;
      }

      list.innerHTML = devices.map((d) => {
        const revoked = d.status === 'revoked';
        const lastSeen = d.lastSeenAt
          ? new Date(d.lastSeenAt).toLocaleString()
          : 'never connected';

        return `
          <div class="device-row${revoked ? ' device-row--revoked' : ''}">
            <div class="device-info">
              <div class="device-name">${escapeHtml(d.deviceName || d.id)}</div>
              <div class="meta-text">
                ${escapeHtml(d.osVersion || 'Unknown OS')}
                ${d.agentVersion ? ' &middot; agent ' + escapeHtml(d.agentVersion) : ''}
                &middot; last seen ${escapeHtml(lastSeen)}
              </div>
            </div>
            <div class="device-actions">
              <span class="badge ${revoked ? 'badge-danger' : 'badge-success'}">
                ${revoked ? 'Revoked' : 'Active'}
              </span>
              ${revoked ? '' : `<button class="btn btn-outline btn-sm" data-revoke-device="${escapeHtml(d.id)}" type="button">Revoke</button>`}
            </div>
          </div>`;
      }).join('');
    }

    /**
     * Releases a job this shop was holding.
     *
     * Only appears for shops that print on their own say-so; the server refuses
     * anything not actually held, so a stale page cannot push a job through.
     */
    async function releaseJob(jobId, button) {
      const label = button ? button.textContent : null;
      try {
        if (button) { button.disabled = true; button.textContent = 'Sending…'; }

        const res = await shopFetch(
          `/api/shops/${encodeURIComponent(dashShopId)}/jobs/${encodeURIComponent(jobId)}/release`,
          { method: 'POST' }
        );

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Could not send this job to the printer.');
        }

        showToast('success', 'Sent to printer', 'The agent will pick it up within a few seconds.');
        loadDashboard();
      } catch (err) {
        showToast('danger', 'Not sent', err.message);
        if (button) { button.disabled = false; if (label) button.textContent = label; }
      }
    }

    // ---------------------------------------------------------- earnings ---

    let moneyFrom = '';
    let moneyTo = '';

    /**
     * How the money actually reaches this shop.
     *
     * Said before any figure, because a shop owner's first question about a
     * payments screen is not "how much" but "when do I get it" — and the honest
     * answer today is "not through this screen yet".
     */
    /**
     * The one place settlement is explained.
     *
     * This used to hold its own hardcoded pair of messages while the payout card
     * below rendered a second explanation from the API — two descriptions of the
     * same thing, in different words, on one screen. Both now come from the
     * server's describeSettlement, which is also what decides the mode, so they
     * cannot drift apart or disagree.
     */
    function renderSettlement(settlement, detail) {
      const box = document.getElementById('settlementNotice');
      if (!box) return;

      const automatic = (detail?.mode || settlement) === 'automatic';
      box.className = `settlement-notice ${automatic ? 'is-good' : 'is-pending'}`;

      if (!detail) {
        // An older response with no explanation attached. Say the one true
        // thing rather than inventing the rest.
        box.textContent = automatic
          ? 'You are paid on every order.'
          : 'Automatic settlement is not switched on yet.';
        return;
      }

      // Built as nodes rather than innerHTML: these strings come from the API,
      // and the only reason they are safe to interpolate is that nobody has
      // checked — which is not a reason.
      box.replaceChildren();

      const headline = document.createElement('strong');
      headline.textContent = detail.headline || '';
      box.append(headline, ' ', document.createTextNode(detail.detail || ''));

      if (detail.action) {
        const action = document.createElement('div');
        action.style.marginTop = '6px';
        action.style.fontWeight = '600';
        action.textContent = detail.action;
        box.append(action);
      }
    }

    function renderMoney(data) {
      renderSettlement(data.settlement, data.settlementDetail);

      const totals = document.getElementById('moneyTotals');
      if (totals) {
        const t = data.totals;
        const tile = (label, cents, hint) => `
          <div class="money-tile">
            <div class="money-label">${escapeHtml(label)}</div>
            <div class="money-value">${formatRupees(cents)}</div>
            ${hint ? `<div class="money-hint">${escapeHtml(hint)}</div>` : ''}
          </div>`;

        totals.innerHTML = [
          tile('Customers paid', t.grossCents, `${t.orders} order${t.orders === 1 ? '' : 's'}`),
          tile(
            'Razorpay fees',
            t.razorpayFeeCents,
            // Named against the orders it actually applies to. A shop taking
            // mostly cash was previously shown a gateway fee on every order,
            // which is money Razorpay never charged.
            t.cashOrders
              ? `${(data.gatewayFeeBps / 100).toFixed(2)}% on ${t.onlineOrders} online order${t.onlineOrders === 1 ? '' : 's'}`
              : `${(data.gatewayFeeBps / 100).toFixed(2)}% estimated`
          ),
          tile('PrintOk commission', t.platformCommissionCents, `${(data.commissionBps / 100).toFixed(2)}% of each order`),
          tile('You keep', t.netCents, 'after both'),
        ].join('');
      }

      const body = document.getElementById('ledgerBody');
      if (body) {
        body.innerHTML = data.rows.length === 0
          ? `<tr><td colspan="7" class="ledger-empty">No paid orders in this period.</td></tr>`
          : data.rows.map((r) => `
            <tr>
              <td>${escapeHtml(new Date(r.createdAt).toLocaleDateString())}</td>
              <td>
                <div class="ledger-file">${escapeHtml(r.fileName)}</div>
                <div class="ledger-meta">${escapeHtml(r.tokenNumber || r.orderId)}${
                  r.paymentMethod === 'cash' ? ' · cash at counter' : ''
                }</div>
              </td>
              <td>${escapeHtml(r.customerName || '—')}</td>
              <td class="num">${formatRupees(r.grossCents)}</td>
              <td class="num ledger-out">${
                // A dash, not "−₹0.00": cash never went through Razorpay, so
                // there is no deduction to show rather than a zero one.
                r.razorpayFeeCents > 0 ? `−${formatRupees(r.razorpayFeeCents)}` : '—'
              }</td>
              <td class="num ledger-out">−${formatRupees(r.platformCommissionCents)}</td>
              <td class="num ledger-net">${formatRupees(r.netCents)}</td>
            </tr>`).join('');
      }

      const note = document.getElementById('ledgerNote');
      if (note) {
        const cashNote = data.totals?.cashOrders
          ? ' Orders paid in cash at the counter carry no Razorpay fee.'
          : '';
        note.textContent = data.feesAreEstimated
          ? 'Razorpay fees are estimated at the published rate. The exact amount appears on your '
            + 'Razorpay settlement statement.' + cashNote
          : cashNote.trim();
      }
    }

    async function loadMoney() {
      if (!dashShopId) return;
      try {
        const params = new URLSearchParams();
        if (moneyFrom) params.set('from', moneyFrom);
        if (moneyTo) params.set('to', moneyTo);

        const res = await shopFetch(
          `/api/shops/${encodeURIComponent(dashShopId)}/earnings?${params.toString()}`
        );
        if (!res.ok) return;
        renderMoney(await res.json());
      } catch {
        // keep the last good render
      }
    }

    document.getElementById('moneyFrom')?.addEventListener('change', (e) => {
      moneyFrom = e.target.value; loadMoney();
    });
    document.getElementById('moneyTo')?.addEventListener('change', (e) => {
      moneyTo = e.target.value; loadMoney();
    });
    document.getElementById('btnMoneyThisMonth')?.addEventListener('click', () => {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      moneyFrom = first.toISOString().slice(0, 10);
      moneyTo = '';
      document.getElementById('moneyFrom').value = moneyFrom;
      document.getElementById('moneyTo').value = '';
      loadMoney();
    });
    document.getElementById('btnMoneyAll')?.addEventListener('click', () => {
      moneyFrom = '';
      moneyTo = '';
      document.getElementById('moneyFrom').value = '';
      document.getElementById('moneyTo').value = '';
      loadMoney();
    });

    async function loadPairedDevices() {
      if (!dashPrinterId) return;
      try {
        const res = await shopFetch(`/api/printers/${encodeURIComponent(dashPrinterId)}/devices`);
        if (!res.ok) return;
        const data = await res.json();
        renderPairedDevices(data.devices);
      } catch {
        // The device list is supplementary; a failure here must not break the tab.
      }
    }

    const btnPairAgent = document.getElementById('btnPairAgent');
    if (btnPairAgent) {
      btnPairAgent.addEventListener('click', async () => {
        if (!dashPrinterId) {
          showToast('warning', 'No Printer', 'Connect a shop before pairing a PC.');
          return;
        }

        btnPairAgent.disabled = true;
        try {
          const res = await shopFetch(`/api/printers/${encodeURIComponent(dashPrinterId)}/pairing-code`, {
            method: 'POST',
          });
          if (!res.ok) throw new Error('Could not generate a pairing code.');

          const data = await res.json();
          const box = document.getElementById('pairingCodeBox');
          const value = document.getElementById('pairingCodeValue');
          const commandCode = document.getElementById('pairingCommandCode');
          const expiry = document.getElementById('pairingExpiry');

          if (value) value.textContent = data.code;
          if (commandCode) commandCode.textContent = data.code;
          if (box) box.hidden = false;

          // Copies the code alone. The button exists so that the obvious way to
          // get the code onto the clipboard is not "select the command line".
          const copyBtn = document.getElementById('btnCopyPairingCode');
          if (copyBtn && !copyBtn.dataset.wired) {
            copyBtn.dataset.wired = '1';
            copyBtn.addEventListener('click', async () => {
              const code = document.getElementById('pairingCodeValue')?.textContent?.trim();
              if (!code || code === '--') return;
              try {
                await navigator.clipboard.writeText(code);
                showToast('success', 'Code Copied', 'Type or paste it into the agent on the shop PC.');
              } catch {
                showToast('warning', 'Copy Failed', `Type it in by hand: ${code}`);
              }
            });
          }

          // The code is single use and short lived; show the operator how long is left.
          let remaining = data.expiresInSeconds || 900;
          clearInterval(pairingCountdown);
          pairingCountdown = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              clearInterval(pairingCountdown);
              if (expiry) expiry.textContent = 'Expired — generate a new code.';
              if (value) value.textContent = '--';
              if (commandCode) commandCode.textContent = '--';
              return;
            }
            const mins = Math.floor(remaining / 60);
            const secs = String(remaining % 60).padStart(2, '0');
            if (expiry) expiry.textContent = `Expires in ${mins}:${secs}`;
          }, 1000);

          showToast('success', 'Pairing Code Ready', 'Enter it in the agent on the shop PC within 15 minutes.');
        } catch (err) {
          showToast('danger', 'Pairing Failed', err.message);
        } finally {
          btnPairAgent.disabled = false;
        }
      });
    }

    const pairedDeviceList = document.getElementById('pairedDeviceList');
    if (pairedDeviceList) {
      pairedDeviceList.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-revoke-device]');
        if (!button) return;

        const deviceId = button.getAttribute('data-revoke-device');
        if (!window.confirm('Revoke this PC? It will stop printing immediately and must be paired again.')) {
          return;
        }

        button.disabled = true;
        try {
          const res = await shopFetch(
            `/api/printers/${encodeURIComponent(dashPrinterId)}/devices/${encodeURIComponent(deviceId)}/revoke`,
            {
              method: 'POST',
              body: JSON.stringify({ reason: 'Revoked from dashboard' }),
            }
          );
          if (!res.ok) throw new Error('Revoke failed.');

          showToast('success', 'PC Revoked', 'That machine can no longer collect print jobs.');
          await loadPairedDevices();
        } catch (err) {
          showToast('danger', 'Revoke Failed', err.message);
          button.disabled = false;
        }
      });
    }

    const btnToggleSimulatedAgent = document.getElementById('btnToggleSimulatedAgent');
    if (btnToggleSimulatedAgent) {
      let simulating = false;
      let simTimer = null;
      btnToggleSimulatedAgent.addEventListener('click', async () => {
        const apiKeyEl = document.getElementById('dashApiKey');
        const apiKey = apiKeyEl ? apiKeyEl.textContent : '';
        if (!apiKey || apiKey === '--') {
          showToast('warning', 'No Agent Key', 'Connect a shop before running the browser test agent.');
          return;
        }

        simulating = !simulating;
        const statusEl = document.getElementById('agentStatusText');

        if (simulating) {
          const beat = async () => {
            try {
              await fetch(`${API_BASE}/api/agent/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-agent-api-key': apiKey },
                body: JSON.stringify({ paperStatus: 'OK' }),
              });
            } catch {
              // the telemetry poll will surface the outage
            }
          };
          beat();
          simTimer = setInterval(beat, 15000);
          btnToggleSimulatedAgent.textContent = '⏹️ Stop Test Agent';
          if (statusEl) statusEl.textContent = 'Agent Status: Simulated heartbeat running in this tab';
          showToast('info', 'Browser Test Agent Started', 'Sending heartbeats every 15s. It cannot actually print.');
        } else {
          clearInterval(simTimer);
          btnToggleSimulatedAgent.textContent = '▶️ Test In Browser';
          if (statusEl) statusEl.textContent = 'Agent Status: Test agent stopped';
          showToast('info', 'Browser Test Agent Stopped', null);
        }
      });
    }

    const btnRequestWithdrawal = document.getElementById('btnRequestWithdrawal');
    if (btnRequestWithdrawal) {
      btnRequestWithdrawal.addEventListener('click', async () => {
        if (!dashShopId) {
          showToast('warning', 'No Shop Connected', 'Register a shop before requesting a payout.');
          return;
        }

        btnRequestWithdrawal.disabled = true;
        const original = btnRequestWithdrawal.textContent;
        btnRequestWithdrawal.textContent = 'Processing Instant Payout...';

        try {
          const res = await shopFetch(`/api/shops/${encodeURIComponent(dashShopId)}/withdraw`, { method: 'POST' });
          const data = await res.json();
          if (res.ok && data.success) {
            showToast('success', '⚡ Instant Payout Triggered!', `${formatRupees(data.payout.netTransferredCents)} transferred to ${data.payout.payoutUpiId}.`);
            loadDashboard();
          } else {
            showToast('info', 'Payout Info', data.error || 'No available balance to withdraw.');
          }
        } catch {
          showToast('danger', 'Error', 'Failed to process instant payout.');
        } finally {
          btnRequestWithdrawal.disabled = false;
          btnRequestWithdrawal.textContent = original;
        }
      });
    }

    function showNoShopState() {
      const list = document.getElementById('liveQueueList');
      if (list) {
        list.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">🏬</div>
            <div class="empty-title">No Shop Connected</div>
            <div class="empty-sub">Register a shop to see its live queue here, or open this dashboard with <code>?shop=&lt;shopId&gt;</code>.</div>
            <div style="margin-top:14px;"><a href="/register" class="btn btn-primary btn-sm" style="text-decoration:none;">🏬 Register a Shop</a></div>
          </div>`;
      }
      const statusText = document.getElementById('dashAgentStatusText');
      if (statusText) statusText.textContent = 'No shop connected';
      const dot = document.getElementById('dashAgentDot');
      if (dot) dot.className = 'status-pulse-dot offline';
    }

    async function loadDashboard() {
      if (!dashShopId) return;
      await Promise.all([loadShopIdentity(), loadMetrics(), loadQueue(), loadMoney()]);
      await loadTelemetry();
    }

    /** The rates form showed hardcoded defaults regardless of what the shop had saved. */
    // loadPricingForm and its save handler are gone with the Rates Matrix pane.
    // Business Setup owns pricing now; leaving a second editor behind would be
    // a quietly different answer to the same question.

    /**
     * Resolves which shop and printer this dashboard belongs to, from the session.
     *
     * The dashboard used to take its shop id only from the URL or localStorage,
     * and its printer from the shop's most recent job. A merchant who simply
     * signs in has no such URL, and a shop that has never printed has no such
     * job — so for every newly registered shop dashShopId was null, the boot
     * gate dropped straight into the "No Shop Connected" state, and nothing was
     * ever loaded. The session token knows which shop it belongs to, so ask the
     * API instead of guessing from the client's leftovers.
     */
    async function resolveIdentity() {
      try {
        const res = await shopFetch('/api/merchant/me');
        if (!res.ok) return identity;

        const me = await res.json();
        const printers = me.printers || [];
        identity.shop = me.shop || null;
        // Honour an explicitly requested printer for shops that have several;
        // otherwise take the first, which every shop gets when it registers.
        identity.printer =
          printers.find(p => p.id === dashPrinterId) || printers[0] || null;

        if (identity.shop) dashShopId = identity.shop.id;
        if (identity.printer) dashPrinterId = identity.printer.id;
        if (dashShopId) ShopContext.write({ shopId: dashShopId, printerId: dashPrinterId });
      } catch {
        // keep whatever context we already had
      }
      return identity;
    }

    /** Populates the shop header, QR tab and agent pairing panel — all previously stuck on "--". */
    async function loadShopIdentity() {
      let { shop, printer } = identity;
      if (!shop || !printer) ({ shop, printer } = await resolveIdentity());
      if (!dashPrinterId) return;

      try {
        if (!printer || !shop) {
          // Last resort when /api/merchant/me could not be reached. This record
          // is public, so it carries the name and status but no agent key.
          const res = await fetch(`${API_BASE}/api/printers/${encodeURIComponent(dashPrinterId)}`);
          if (!res.ok) return;
          const body = await res.json();
          printer = printer || body.printer;
          shop = shop || body.shop;
        }

        const set = (id, val) => {
          const el = document.getElementById(id);
          if (el && val !== undefined && val !== null) el.textContent = val;
        };

        if (shop) {
          set('dashShopTitle', shop.name);
          set('dashShopIdBadge', `Shop ID: ${shop.id}`);
          set('dashShopId', shop.id);
          set('dashQrShopName', shop.name);
          if (shop.upiId) {
            shopUpiId = shop.upiId;
            set('dashPayoutUpi', shop.upiId);
          }
        }
        if (printer) {
          set('dashPrinterTitle', printer.printerName);
          set('dashQrPrinterName', printer.printerName);
          set('dashPrinterId', printer.id);
          set('dashApiKey', printer.apiKey);
          set('dashQrTargetUrl', `${window.location.origin}/?printer=${printer.id}`);

          const qrImg = document.getElementById('dashQrImg');
          if (qrImg && printer.qrCodeDataUrl) qrImg.src = printer.qrCodeDataUrl;

          // Deliberate merchant action: preview this printer's customer page.
          // Not a standing route from the customer app into the dashboard.
          const customerLink = document.getElementById('btnCustomerLink');
          if (customerLink) customerLink.href = `/?printer=${encodeURIComponent(printer.id)}`;

          // The wizard reads the shop from storage, but a link that carries it
          // works on a browser that has never stored anything.
          // The shop id is added to whatever the link already points at, so a
          // link aimed at a section keeps its section. Overwriting the href
          // wholesale would send "Rates & discounts" to the first tab instead.
          for (const id of ['btnBusinessSetup', 'btnRatesToSetup']) {
            const link = document.getElementById(id);
            if (!link || !dashShopId) continue;

            const url = new URL(link.getAttribute('href'), window.location.origin);
            url.searchParams.set('shop', dashShopId);
            link.href = `${url.pathname}${url.search}${url.hash}`;
          }

          const exeLink = document.getElementById('btnDownloadAgentExe');
          if (exeLink) exeLink.href = `${API_BASE}/api/agent-installer`;
          const cfgLink = document.getElementById('btnDownloadAgentConfigFile');
          if (cfgLink && !cfgLink.dataset.wired) {
            // Authorised per click, not a standing URL. See downloadAgentConfig.
            cfgLink.dataset.wired = '1';
            cfgLink.removeAttribute('href');
            cfgLink.addEventListener('click', (e) => {
              e.preventDefault();
              downloadAgentConfig(dashPrinterId, cfgLink);
            });
          }

          loadPairedDevices();
        }
      } catch {
        // keep whatever is already rendered
      }
    }

    async function loadMetrics() {
      try {
        const res = await shopFetch(`/api/shops/${encodeURIComponent(dashShopId)}/stats`);
        if (res.ok) {
          const { stats } = await res.json();
          const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
          };
          // Field names must match MerchantStats from the API.
          set('statTodayRevenue', formatRupees(stats?.todayRevenueCents));
        }
      } catch {
        // leave the previous values on screen
      }

      try {
        const payoutRes = await shopFetch(`/api/shops/${encodeURIComponent(dashShopId)}/payout-summary`);
        if (payoutRes.ok) {
          const p = await payoutRes.json();
          const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
          };
          set('statGrossRevenue', formatRupees(p.grossCents));
          set('statTotalDeductions', `-${formatRupees(p.razorpayFeeCents + p.platformCommissionCents)}`);
          set('statNetAvailable', formatRupees(p.netAvailableCents));
          set('dashWithdrawBalance', formatRupees(p.netAvailableCents));

          // The mode used to be the whole message: a badge reading "manual"
          // and nothing a shop owner could act on, least of all why it
          // depended on a Razorpay account nobody had explained.
          // Badge only. The explanation itself lives in the notice at the top
          // of this screen, rendered from the same server answer — saying it
          // twice on one screen, in two different wordings, helped nobody.
          const s = p.settlementDetail;
          const badge = document.getElementById('settlementBadge');
          if (s && badge) {
            badge.textContent = s.mode === 'automatic' ? 'Automatic' : 'Paid out by hand';
            badge.className = `badge ${s.mode === 'automatic' ? 'badge-success' : 'badge-queued'}`;
          }
        }
      } catch {
        // ignore
      }

      await loadPayoutDetails();
      await loadPlan();
    }

    /**
     * The shop's payout destination.
     *
     * There was no way to change these at all after signup — the field was in
     * the registration body and nowhere else — so a shop that mistyped an IFSC,
     * or signed up without one, could never tell us where to send its money.
     */
    async function loadPayoutDetails() {
      try {
        const res = await shopFetch(`/api/shops/${encodeURIComponent(dashShopId)}/payout-details`);
        if (!res.ok) return; // staff accounts get 403 here, which is correct
        const d = await res.json();

        const upi = document.getElementById('inputPayoutUpi');
        const ifsc = document.getElementById('inputPayoutIfsc');
        const help = document.getElementById('payoutAccountHelp');

        if (upi) upi.value = d.upiId || '';
        if (ifsc) ifsc.value = d.bankIfsc || '';
        if (help) {
          help.textContent = d.bankAccountSet
            ? `Saved, ending ${d.bankAccountLast4}. Type a new number to replace it.`
            : 'Only the last four digits are shown once saved.';
        }
      } catch {
        // leave the form empty; saving still works
      }
    }

    const payoutForm = document.getElementById('payoutDetailsForm');
    if (payoutForm) {
      payoutForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const btn = document.getElementById('btnSavePayoutDetails');
        const err = document.getElementById('payoutDetailsError');
        const ok = document.getElementById('payoutDetailsSaved');
        const show = (el, text) => { if (el) { el.textContent = text; el.hidden = !text; } };

        show(err, '');
        show(ok, '');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

        try {
          const body = {
            upiId: (document.getElementById('inputPayoutUpi')?.value || '').trim(),
            bankIfsc: (document.getElementById('inputPayoutIfsc')?.value || '').trim(),
          };

          // Only sent when actually typed: the field shows a masked tail, so
          // submitting it unchanged would try to save four digits as the whole
          // account number.
          const typedAccount = (document.getElementById('inputPayoutAccount')?.value || '').trim();
          if (typedAccount) body.bankAccountNumber = typedAccount;

          const res = await shopFetch(`/api/shops/${encodeURIComponent(dashShopId)}/payout-details`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          const data = await res.json();

          if (!res.ok) {
            show(err, data.error || 'Those payout details could not be saved.');
            return;
          }

          const accountField = document.getElementById('inputPayoutAccount');
          if (accountField) accountField.value = '';
          show(ok, 'Saved. This is where your payouts will go.');
          await loadPayoutDetails();
        } catch {
          show(err, 'Those payout details could not be saved. Check your connection and try again.');
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Save payout details'; }
        }
      });
    }

    /**
     * The shop's plan, costed against its own volume.
     *
     * The tiles here were hardcoded at prices and commission rates that do not
     * exist in PLAN_CATALOGUE — a "₹149 Starter" and a "₹299 Growth" that no
     * shop was ever on. Now every figure comes from the catalogue the API
     * actually charges from.
     */
    async function loadPlan() {
      try {
        const res = await shopFetch(`/api/shops/${encodeURIComponent(dashShopId)}/plan`);
        if (!res.ok) return; // staff accounts get 403, which is correct
        const plan = await res.json();

        const badge = document.getElementById('planCurrentBadge');
        if (badge) {
          badge.textContent =
            `${plan.current.name || plan.current.tier} · ${(plan.current.commissionBps / 100).toFixed(2)}%`;
        }

        const month = document.getElementById('planThisMonth');
        if (month) {
          month.textContent = plan.thisMonth.orders
            ? `This month: ${plan.thisMonth.orders} paid order${plan.thisMonth.orders === 1 ? '' : 's'}, `
              + `${formatRupees(plan.thisMonth.grossCents)} collected, `
              + `${formatRupees(plan.thisMonth.commissionCents)} in PrintOk commission.`
            : 'No paid orders yet this month.';
        }

        const options = document.getElementById('planOptions');
        if (options) {
          options.innerHTML = plan.options.map((o) => `
            <div class="pricing-mini-card"${o.isCurrent ? ' style="border: 2px solid var(--color-primary);"' : ''}>
              <div class="pricing-type">${escapeHtml(o.name)}${o.isCurrent ? ' · current' : ''}</div>
              <div class="pricing-rate">${formatRupees(o.monthlyPriceCents)} <span>/ month</span></div>
              <div class="pricing-meta">
                ${(o.commissionBps / 100).toFixed(2)}% commission •
                ${o.maxOrdersPerMonth} orders • ${o.maxPrinters} printer${o.maxPrinters === 1 ? '' : 's'}
              </div>
              <div class="pricing-meta" style="font-weight: 600;">
                At your volume: ${formatRupees(o.wouldCostCents)}/month
              </div>
            </div>`).join('');
        }

        const how = document.getElementById('planHowToChange');
        if (how) how.textContent = plan.howToChange || '';
      } catch {
        // leave the plan card empty rather than showing invented numbers
      }
    }

    /** The queue feed was never fetched — the empty state was permanent. */
    async function loadQueue() {
      const list = document.getElementById('liveQueueList');
      if (list) list.setAttribute('aria-busy', 'true');
      try {
        // Filtering happens server-side so the tab counts and the rows agree,
        // and so a search reaches orders older than the page being shown.
        const params = new URLSearchParams({ limit: '100', status: queueFilter });
        if (queueSearch) params.set('q', queueSearch);
        if (queueMonth) params.set('month', queueMonth);

        const res = await shopFetch(
          `/api/shops/${encodeURIComponent(dashShopId)}/jobs?${params.toString()}`
        );
        if (res.ok) {
          const data = await res.json();
          cachedJobs = Array.isArray(data.jobs) ? data.jobs : [];
          queueCounts = data.counts || null;
          renderQueueTabs();
          renderQueue(cachedJobs);

          // The tiles describe the shop, not whatever the queue is filtered to,
          // so they come from the server's tally rather than the rows on screen.
          // Counting the rows would make "Printed Pages" fall to zero the moment
          // someone searched for a customer.
          const pagesEl = document.getElementById('statPrintedPages');
          if (pagesEl && queueCounts) pagesEl.textContent = String(queueCounts.pagesDone ?? 0);

          // The tile reads "Awaiting Agent / Cash", so it is everything not yet
          // finished, refused or broken.
          const queuedEl = document.getElementById('statQueuedCount');
          if (queuedEl && queueCounts) {
            queuedEl.textContent = String(
              (queueCounts.pending ?? 0) + (queueCounts.processing ?? 0) + (queueCounts.printing ?? 0)
            );
          }
        }
      } catch {
        // keep the last good render
      } finally {
        if (list) list.setAttribute('aria-busy', 'false');
      }
    }

    function renderQueue(jobs) {
      const list = document.getElementById('liveQueueList');
      if (!list) return;

      // Already filtered by the server. Filtering again here would compare a
      // bucket name against a print state and quietly show nothing.
      const visible = jobs;

      if (visible.length === 0) {
        list.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <div class="empty-title">${(queueSearch || queueMonth || queueFilter !== 'all')
              ? 'Nothing matches' : 'No Print Jobs Yet'}</div>
            <div class="empty-sub">${jobs.length === 0
              ? 'Customer print requests will appear here in real-time as they scan your shop QR code.'
              : 'Try the “All” filter to see every order.'}</div>
          </div>`;
        return;
      }

      list.innerHTML = visible.map(job => {
        const badgeClass = PRINT_STATE_BADGES[job.printState] || 'badge-neutral';
        const label = PRINT_STATE_LABELS[job.printState] || job.printState;
        const needsCash = job.printState === 'AwaitingPayment';
        const detail = [
          `${job.pageCount} ${job.pageCount === 1 ? 'page' : 'pages'}`,
          `${job.copies} ${job.copies === 1 ? 'copy' : 'copies'}`,
          job.isColor ? 'Color' : 'B&W',
          job.isDuplex ? 'Duplex' : 'Single',
          job.paperSize || 'A4',
        ].join(' • ');

        return `
          <div class="queue-row">
            <div class="queue-row-main">
              <span class="queue-token">${escapeHtml(job.tokenNumber || '#--')}</span>
              <div style="min-width:0;">
                <div class="queue-file">${escapeHtml(job.fileName)}</div>
                ${customerLine(job)}
                <div class="queue-meta">${escapeHtml(detail)}</div>
              </div>
            </div>
            <div class="queue-row-actions">
              <span class="queue-amount">${formatRupees(job.totalPriceInCents)}</span>
              <span class="badge ${badgeClass}">${escapeHtml(label)}</span>
              ${needsCash ? `<button type="button" class="btn btn-primary btn-sm" data-approve="${escapeHtml(job.id)}">✅ Cash Received</button>` : ''}
              ${job.printState === 'HeldForRelease' ? `<button type="button" class="btn btn-primary btn-sm" data-release="${escapeHtml(job.id)}">🖨️ Print now</button>` : ''}
              ${canDecline(job) ? `<button type="button" class="btn btn-outline btn-sm btn-decline" data-decline="${escapeHtml(job.id)}" data-paid="${job.paymentState === 'Paid' ? '1' : ''}">✖ Decline</button>` : ''}
            </div>
          </div>`;
      }).join('');

      list.querySelectorAll('[data-approve]').forEach(btn => {
        btn.addEventListener('click', () => approveCashJob(btn.getAttribute('data-approve'), btn));
      });

      list.querySelectorAll('[data-decline]').forEach(btn => {
        btn.addEventListener('click', () =>
          declineJob(btn.getAttribute('data-decline'), btn.getAttribute('data-paid') === '1', btn));
      });

      list.querySelectorAll('[data-release]').forEach(btn => {
        btn.addEventListener('click', () => releaseJob(btn.getAttribute('data-release'), btn));
      });
    }

    /**
     * A job can be refused until it has printed. After that the paper and toner
     * are spent, so the decision is a refund for a human rather than a button.
     */
    function canDecline(job) {
      return ['AwaitingPayment', 'Created', 'Queued', 'Assigned', 'Downloading', 'RequiresShopAction']
        .includes(job.printState);
    }

    async function declineJob(jobId, wasPaid, btn) {
      const warning = wasPaid
        ? 'This customer has paid. Declining refunds them in full.'
        : 'This job has not been paid for, so there is nothing to refund.';

      const reason = window.prompt(
        `${warning}\n\nWhy are you refusing it? The customer is shown this.`,
        wasPaid ? 'We cannot print this job.' : ''
      );
      // Cancelled prompt: do nothing at all, rather than declining with no reason.
      if (reason === null) return;

      if (!reason.trim()) {
        showToast('warning', 'A reason is needed', 'The customer is told why their job was refused.');
        return;
      }

      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Declining...';

      try {
        const res = await shopFetch(`/api/shops/${encodeURIComponent(dashShopId)}/jobs/${encodeURIComponent(jobId)}/decline`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason.trim() }),
        });
        const data = await res.json();

        if (!res.ok) {
          showToast('danger', 'Could not decline', data.error || 'The job was not declined.');
          btn.disabled = false;
          btn.textContent = original;
          return;
        }

        if (data.refund && data.refund.issued) {
          showToast('success', 'Declined and refunded',
            `${formatRupees(data.refund.amountInCents)} has been sent back to the customer.`);
        } else if (data.refund && data.refund.error) {
          // 202: the decision stands but the money has not moved. Say so
          // plainly — the shop still owes this customer a refund.
          showToast('warning', 'Declined — refund not issued',
            'Refund it from your Razorpay dashboard: ' + data.refund.error);
        } else {
          showToast('success', 'Job declined', 'Nothing had been paid, so there was nothing to refund.');
        }

        loadQueue();
      } catch (err) {
        showToast('danger', 'Network Error', err.message || 'Could not reach the API server.');
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    async function approveCashJob(jobId, btn) {
      btn.disabled = true;
      btn.textContent = 'Approving...';
      try {
        // shopFetch, not fetch: approving a cash job asserts that money changed
        // hands, so the server now requires the merchant session that says who
        // took it. A bare fetch here answers 401.
        const res = await shopFetch(`/api/print-jobs/${encodeURIComponent(jobId)}/manual-override`, { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('success', 'Job Queued', 'Cash payment recorded — the job was sent to the printer.');
          loadQueue();
        } else {
          showToast('danger', 'Approval Failed', data.error || 'Could not queue this job.');
          btn.disabled = false;
          btn.textContent = '✅ Cash Received';
        }
      } catch {
        showToast('danger', 'Network Error', 'Could not reach the API server.');
        btn.disabled = false;
        btn.textContent = '✅ Cash Received';
      }
    }

    /** Agent pill, dot and latency KPI were all static placeholders. */
    async function loadTelemetry() {
      if (!dashPrinterId) return;
      const dot = document.getElementById('dashAgentDot');
      const text = document.getElementById('dashAgentStatusText');
      const latency = document.getElementById('statAgentLatency');
      const sub = document.getElementById('statAgentStatusSub');
      const agentStatusText = document.getElementById('agentStatusText');

      try {
        const started = performance.now();
        const res = await fetch(`${API_BASE}/api/printers/${encodeURIComponent(dashPrinterId)}/telemetry`);
        const roundTrip = Math.round(performance.now() - started);
        if (!res.ok) return;
        const t = await res.json();

        if (dot) dot.className = `status-pulse-dot ${t.isOnline ? 'online' : 'offline'}`;
        if (text) text.textContent = t.isOnline ? 'Agent Online' : 'Agent Offline';
        if (latency) latency.textContent = `${roundTrip} ms`;
        if (agentStatusText) agentStatusText.textContent = `Agent Status: ${t.isOnline ? 'Online' : 'Offline'}`;

        if (sub) {
          if (t.lastHeartbeat) {
            const ageSec = Math.max(0, Math.round((Date.now() - new Date(t.lastHeartbeat).getTime()) / 1000));
            sub.textContent = `Last heartbeat ${ageSec}s ago`;
          } else {
            sub.textContent = 'No heartbeat received';
          }
        }
      } catch {
        if (dot) dot.className = 'status-pulse-dot offline';
        if (text) text.textContent = 'Agent Unreachable';
      }
    }
  }

  // ============================================================
  //  3. CUSTOMER MOBILE PRINTING DRIVER (index.html / ?printer=)
  // ============================================================
  if (!isRegisterPage && !isDashboardPage) {
    const urlParams = new URLSearchParams(window.location.search);
    const pathParts = window.location.pathname.split('/');
    // /p/:printerId is rewritten to index.html, so accept that shape too.
    const fromPath = pathParts[1] === 'p' ? pathParts[2] : null;
    currentPrinterId = urlParams.get('printer') || fromPath || null;

    const screenLanding = document.getElementById('screenLanding');
    const screenCustomer = document.getElementById('screenCustomer');
    const screenStatus = document.getElementById('screenStatus');

    if (!currentPrinterId) {
      if (screenLanding) screenLanding.hidden = false;
      if (screenCustomer) screenCustomer.hidden = true;
      if (screenStatus) screenStatus.hidden = true;
    } else {
      if (screenLanding) screenLanding.hidden = true;
      if (screenCustomer) screenCustomer.hidden = false;
      if (screenStatus) screenStatus.hidden = true;
      fetchShopInfo(currentPrinterId);
      startAgentHealthCheck(currentPrinterId);
    }

    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const fileInfoBox = document.getElementById('fileInfoBox');
    const infoFileName = document.getElementById('infoFileName');
    const infoFileMeta = document.getElementById('infoFileMeta');
    const btnRemoveFile = document.getElementById('btnRemoveFile');
    const configSection = document.getElementById('configSection');
    const documentPreviewBox = document.getElementById('documentPreviewBox');

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());
      // The drop zone is keyboard-operable, so Enter/Space must open the picker.
      dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInput.click();
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleCustomerFile(e.target.files[0]);
      });

      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });

      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) handleCustomerFile(e.dataTransfer.files[0]);
      });
    }

    if (btnRemoveFile) {
      btnRemoveFile.addEventListener('click', (e) => {
        e.stopPropagation();
        resetFileSelection();
      });
    }

    function resetFileSelection() {
      selectedFile = null;
      fileBase64 = null;
      submissionKey = newSubmissionKey();
      detectedTotalPages = 1;
      pageCount = 1;
      copies = 1;

      const copiesVal = document.getElementById('copiesVal');
      if (copiesVal) copiesVal.textContent = '1';

      // Without this, re-picking the same file fires no change event.
      if (fileInput) fileInput.value = '';
      DocumentPreview.reset();

      if (fileInfoBox) fileInfoBox.hidden = true;
      if (documentPreviewBox) documentPreviewBox.hidden = true;
      if (configSection) configSection.hidden = true;
      if (dropZone) dropZone.hidden = false;
      setPayButtonsEnabled(false);
    }

    function setPayButtonsEnabled(enabled) {
      [document.getElementById('btnPayCash'), document.getElementById('btnPayRazorpay')]
        .forEach(b => { if (b) b.disabled = !enabled; });
    }

    async function handleCustomerFile(file) {
      if (file.size > MAX_UPLOAD_BYTES) {
        showToast('danger', 'File Too Large',
          `${(file.size / (1024 * 1024)).toFixed(1)} MB exceeds the 25 MB limit. Please compress or split the document.`);
        if (fileInput) fileInput.value = '';
        return;
      }

      selectedFile = file;
      fileBase64 = null;
      // A different file is a different order, so it gets its own key. Without
      // this, a second order in the same visit would reuse the first's key and
      // the server would hand back the first job.
      submissionKey = newSubmissionKey();
      setPayButtonsEnabled(false);

      if (infoFileName) infoFileName.textContent = file.name;
      if (infoFileMeta) infoFileMeta.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB • Detecting pages...`;

      if (fileInfoBox) fileInfoBox.hidden = false;
      if (documentPreviewBox) documentPreviewBox.hidden = false;
      if (configSection) configSection.hidden = false;
      if (dropZone) dropZone.hidden = true;

      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);


      // Render the real document rather than handing it to the browser's PDF
      // plugin, which many mobile browsers do not have. Also lets the preview
      // reflect the settings chosen below it.
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        detectedTotalPages = detectPdfPages(bytes);
      } else {
        detectedTotalPages = 1;
      }

      await DocumentPreview.load(file);

      // pdf.js is authoritative on page count when it managed to parse the file.
      if (DocumentPreview.kind === 'pdf' && DocumentPreview.totalPages > 0) {
        detectedTotalPages = DocumentPreview.totalPages;
      }

      if (infoFileMeta) {
        infoFileMeta.textContent = `${detectedTotalPages} ${detectedTotalPages === 1 ? 'page' : 'pages'} • ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
      }

      const allPagesCountBadge = document.getElementById('allPagesCountBadge');
      if (allPagesCountBadge) allPagesCountBadge.textContent = String(detectedTotalPages);

      pageCount = detectedTotalPages;
      updateCustomerPrice();
      DocumentPreview.refresh();

      // Only enable checkout once the base64 payload is actually ready.
      try {
        fileBase64 = await readFileAsBase64(file);
        setPayButtonsEnabled(true);
      } catch {
        showToast('danger', 'Read Failed', 'Could not read that file. Please try another document.');
        resetFileSelection();
      }
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          const comma = result.indexOf(',');
          if (comma === -1) reject(new Error('Unexpected data URL'));
          else resolve(result.slice(comma + 1));
        };
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsDataURL(file);
      });
    }

    // Page selection range handlers
    const pillPagesAll = document.getElementById('pillPagesAll');
    const pillPagesCustom = document.getElementById('pillPagesCustom');
    const customPageRangeBox = document.getElementById('customPageRangeBox');
    const inputCustomPageRange = document.getElementById('inputCustomPageRange');

    function selectAllPages() {
      pageRangeMode = 'all';
      customPageRange = '';
      if (pillPagesAll) pillPagesAll.classList.add('active');
      if (pillPagesCustom) pillPagesCustom.classList.remove('active');
      if (customPageRangeBox) customPageRangeBox.hidden = true;
      pageCount = detectedTotalPages;
      updateCustomerPrice();
    }

    function selectCustomPages() {
      pageRangeMode = 'custom';
      if (pillPagesCustom) pillPagesCustom.classList.add('active');
      if (pillPagesAll) pillPagesAll.classList.remove('active');
      if (customPageRangeBox) customPageRangeBox.hidden = false;
      recalculateCustomPageCount();
    }

    if (pillPagesAll && pillPagesCustom) {
      bindPill(pillPagesAll, selectAllPages);
      bindPill(pillPagesCustom, selectCustomPages);
    }

    if (inputCustomPageRange) {
      inputCustomPageRange.addEventListener('input', recalculateCustomPageCount);
    }

    function recalculateCustomPageCount() {
      if (!inputCustomPageRange) return;
      const rangeStr = inputCustomPageRange.value.trim();
      customPageRange = rangeStr;
      const help = document.getElementById('customRangeHelp');

      if (!rangeStr) {
        pageCount = detectedTotalPages;
        if (help) help.textContent = 'Enter page numbers and ranges separated by commas. E.g. 1-5, 8';
      } else {
        const selected = parseCustomPageRange(rangeStr, detectedTotalPages);
        pageCount = selected;
        if (help) {
          help.textContent = selected === detectedTotalPages && rangeStr
            ? `No valid pages in that range — charging for all ${detectedTotalPages}.`
            : `Selected ${selected} of ${detectedTotalPages} ${detectedTotalPages === 1 ? 'page' : 'pages'}.`;
        }
      }
      updateCustomerPrice();
    }

    /** Keeps a pill's visual state, its hidden radio, and the app state in sync. */
    function bindPill(pill, onSelect) {
      pill.addEventListener('click', onSelect);
      const radio = pill.querySelector('input[type="radio"]');
      if (radio) radio.addEventListener('change', onSelect);
    }

    // Option pills
    const pillBw = document.getElementById('pillBw');
    const pillColor = document.getElementById('pillColor');
    const pillSingle = document.getElementById('pillSingle');
    const pillDuplex = document.getElementById('pillDuplex');

    if (pillBw && pillColor) {
      bindPill(pillBw, () => {
        isColor = false;
        pillBw.classList.add('active');
        pillColor.classList.remove('active');
        updateCustomerPrice();
      });

      bindPill(pillColor, () => {
        isColor = true;
        pillColor.classList.add('active');
        pillBw.classList.remove('active');
        updateCustomerPrice();
      });
    }

    if (pillSingle && pillDuplex) {
      bindPill(pillSingle, () => {
        isDuplex = false;
        pillSingle.classList.add('active');
        pillDuplex.classList.remove('active');
        updateCustomerPrice();
      });

      bindPill(pillDuplex, () => {
        isDuplex = true;
        pillDuplex.classList.add('active');
        pillSingle.classList.remove('active');
        updateCustomerPrice();
      });
    }

    // Orientation. Not priced differently — the same sheet either way — so it
    // does not re-quote; it only has to reach the print job.
    const orientationPills = {
      auto: document.getElementById('pillOrientAuto'),
      portrait: document.getElementById('pillOrientPortrait'),
      landscape: document.getElementById('pillOrientLandscape'),
    };

    Object.entries(orientationPills).forEach(([value, pill]) => {
      if (!pill) return;
      bindPill(pill, () => {
        orientation = value;
        Object.values(orientationPills).forEach((p) => p && p.classList.remove('active'));
        pill.classList.add('active');
        DocumentPreview.refresh();
      });
    });

    // Paper size was collected but never fed back into the quote.
    const selectPaperSize = document.getElementById('selectPaperSize');
    if (selectPaperSize) {
      selectPaperSize.addEventListener('change', () => {
        paperSize = selectPaperSize.value || 'A4';
        // Sellability is per paper size, so changing paper can invalidate the
        // colour and sides already chosen.
        applySellableCombinations();
        updateCustomerPrice();
      });
    }

    // Steppers
    const btnDecCopies = document.getElementById('btnDecCopies');
    const btnIncCopies = document.getElementById('btnIncCopies');
    const copiesVal = document.getElementById('copiesVal');

    if (btnDecCopies && btnIncCopies && copiesVal) {
      btnDecCopies.addEventListener('click', () => {
        if (copies > 1) { copies--; copiesVal.textContent = copies; updateCustomerPrice(); }
      });
      btnIncCopies.addEventListener('click', () => {
        if (copies < 99) { copies++; copiesVal.textContent = copies; updateCustomerPrice(); }
      });
    }

    /**
     * The price, from the shop's own rate card.
     *
     * Two steps on purpose. The local estimate below paints immediately so the
     * figure does not flicker or lag a tap, and then the server is asked what it
     * will actually charge and that answer replaces it.
     *
     * The server has to be asked, because the estimate cannot be right. It
     * mirrors the four flat rates, and shops price from a grid now — twelve
     * cells, two discount models and per-configuration switches. The customer
     * page also has no way to read the flat rates it mirrors: GET /pricing is
     * merchant-only, so every customer silently fell back to the hardcoded
     * numbers below. A shop could rebuild its entire rate card in Business
     * Setup and the price on the customer's screen would not move by a paisa.
     */
    function updateCustomerPrice() {
      renderLocalEstimate();
      requestAuthoritativeQuote();
    }

    /**
     * The last server quote, and the exact configuration it was for.
     *
     * Paired, because a quote for black-and-white must not still be on screen
     * after someone taps Colour. A stale price is worse than an estimate.
     */
    let confirmedQuote = null;
    let confirmedFor = null;

    /** Discards a slow answer that a later choice has already superseded. */
    let quoteRequest = 0;
    let quoteTimer = null;

    /** Everything the price depends on, as one comparable string. */
    function quoteSignature() {
      const range = pageRangeMode === 'custom' ? customPageRange.trim() : '';
      return [detectedTotalPages, copies, !!isColor, !!isDuplex, paperSize || 'A4', range].join('|');
    }

    function requestAuthoritativeQuote() {
      if (!currentShopId) return;

      const mine = ++quoteRequest;
      const signature = quoteSignature();
      clearTimeout(quoteTimer);

      // Debounced: holding the copies stepper should not be one request per tap.
      quoteTimer = setTimeout(async () => {
        const range = pageRangeMode === 'custom' ? customPageRange.trim() : '';
        const params = new URLSearchParams({
          pages: String(Math.max(1, detectedTotalPages)),
          copies: String(Math.max(1, copies)),
          isColor: String(!!isColor),
          isDuplex: String(!!isDuplex),
          paperSize: paperSize || 'A4',
        });
        if (range) params.set('pageRange', range);

        try {
          const res = await fetch(
            `${API_BASE}/api/shops/${encodeURIComponent(currentShopId)}/quote?${params}`
          );
          if (!res.ok) return;
          const data = await res.json();
          // A later change has already been made; this answer is about a
          // configuration the customer is no longer looking at.
          if (mine !== quoteRequest || !data.quote) return;

          confirmedQuote = data.quote;
          confirmedFor = signature;
          renderQuote(data.quote);
        } catch {
          // Leave the estimate showing. The amount charged is settled by the
          // server at submit either way, and a blank price would stop the order.
        }
      }, 250);
    }

    /** Paints a figure the server has confirmed it will charge. */
    function renderQuote(quote) {
      const totalCostDisplay = document.getElementById('totalCostDisplay');
      const costBreakdownText = document.getElementById('costBreakdownText');

      if (totalCostDisplay) totalCostDisplay.textContent = formatRupees(quote.totalPriceInCents);
      if (costBreakdownText) {
        const parts = [
          `${quote.pages} ${quote.pages === 1 ? 'page' : 'pages'}`,
          quote.copies > 1 ? `× ${quote.copies} copies` : null,
          `× ${formatRupees(quote.perPageRateCents)}`,
          `(${isColor ? 'Color' : 'B&W'} ${isDuplex ? 'Duplex' : 'Single'}, ${paperSize})`,
          quote.discountCents > 0 ? `− ${formatRupees(quote.discountCents)} discount` : null,
        ].filter(Boolean);
        costBreakdownText.textContent = parts.join(' ');
      }
    }

    /**
     * A first guess, shown for the moment before the server answers.
     *
     * Kept as a fallback rather than deleted: a customer on a bad connection
     * should see a plausible number rather than a blank where the price goes.
     */
    function renderLocalEstimate() {
      // Keep the preview in step with colour, duplex, copies and page range.
      DocumentPreview.refresh();

      // A confirmed figure for this exact configuration is never overwritten by
      // a guess: re-renders happen for reasons that do not change the price, and
      // the number must not flicker back to an estimate. A quote for a different
      // configuration is not reused at all.
      if (confirmedQuote && confirmedFor === quoteSignature()) {
        renderQuote(confirmedQuote);
        return;
      }

      // Constants on purpose. This is the placeholder shown for the moment
      // before /quote answers, and it is never what anyone is charged — the
      // shop's real rates are twelve grid cells this calculator cannot express.
      const cfg = {
        bwSinglePerPageCents: 200,
        bwDuplexPerPageCents: 150,
        colorSinglePerPageCents: 1000,
        colorDuplexPerPageCents: 800,
        a3Multiplier: 2.0,
        bulkDiscountThreshold: 50,
        bulkDiscountPercent: 10,
      };

      const safePages = Math.max(1, pageCount);
      const safeCopies = Math.max(1, copies);

      let perPageCents = isColor
        ? (isDuplex ? cfg.colorDuplexPerPageCents : cfg.colorSinglePerPageCents)
        : (isDuplex ? cfg.bwDuplexPerPageCents : cfg.bwSinglePerPageCents);

      if (paperSize === 'A3') {
        perPageCents = Math.round(perPageCents * (cfg.a3Multiplier || 2.0));
      }

      let totalCents = safePages * safeCopies * perPageCents;

      const totalSheets = safePages * safeCopies;
      const threshold = cfg.bulkDiscountThreshold || 50;
      let discounted = false;
      if (threshold > 0 && totalSheets >= threshold) {
        const pct = cfg.bulkDiscountPercent ?? 10;
        totalCents = Math.round(totalCents * ((100 - pct) / 100));
        discounted = pct > 0;
      }

      const totalCostDisplay = document.getElementById('totalCostDisplay');
      const costBreakdownText = document.getElementById('costBreakdownText');

      if (totalCostDisplay) totalCostDisplay.textContent = formatRupees(totalCents);
      if (costBreakdownText) {
        const parts = [
          `${safePages} ${safePages === 1 ? 'page' : 'pages'}`,
          safeCopies > 1 ? `× ${safeCopies} copies` : null,
          `× ${formatRupees(perPageCents)}`,
          `(${isColor ? 'Color' : 'B&W'} ${isDuplex ? 'Duplex' : 'Single'}, ${paperSize})`,
          discounted ? `− ${cfg.bulkDiscountPercent ?? 10}% bulk discount` : null,
        ].filter(Boolean);
        costBreakdownText.textContent = parts.join(' ');
      }
    }

    rerenderPrice = updateCustomerPrice;

    const btnPrevPage = document.getElementById('btnPrevPage');
    const btnNextPage = document.getElementById('btnNextPage');
    if (btnPrevPage) btnPrevPage.addEventListener('click', () => DocumentPreview.goTo(DocumentPreview.page - 1));
    if (btnNextPage) btnNextPage.addEventListener('click', () => DocumentPreview.goTo(DocumentPreview.page + 1));

    // Payment submissions
    const btnPayCash = document.getElementById('btnPayCash');
    const btnPayRazorpay = document.getElementById('btnPayRazorpay');

    setPayButtonsEnabled(false);

    // Neither route may auto-approve payment. Cash waits for the shop to
    // confirm the money is in hand; Razorpay waits for a verified payment.
    // Previously "Pay Cash" queued the job as Paid immediately, so documents
    // printed before anyone had paid.
    if (btnPayCash) {
      btnPayCash.addEventListener('click', () => submitCustomerPrintJob('cash'));
    }
    if (btnPayRazorpay) {
      btnPayRazorpay.addEventListener('click', () => submitCustomerPrintJob('razorpay'));
    }

    let submitting = false;

    /**
     * Opens Razorpay Checkout for a job and confirms the result server-side.
     * Resolves true only once our own API has verified the payment signature;
     * the browser's word alone is never enough to queue a print.
     */
    async function payWithRazorpay(job) {
      const orderRes = await fetch(`${API_BASE}/api/payments/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      const order = await orderRes.json();
      if (!orderRes.ok) throw new Error(order.error || 'Could not start the payment.');

      if (typeof window.Razorpay !== 'function') {
        throw new Error('Payment library failed to load. Check your connection and try again.');
      }

      return new Promise((resolve, reject) => {
        const checkout = new window.Razorpay({
          key: order.keyId,
          amount: order.amountInCents,
          currency: order.currency || 'INR',
          name: 'PrintOk',
          description: `${job.fileName} · ${job.pageCount} page(s)`,
          order_id: order.orderId,
          notes: { jobId: job.id },
          theme: { color: '#6c2cff' },
          handler: async (response) => {
            try {
              const verifyRes = await fetch(`${API_BASE}/api/payments/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jobId: job.id,
                  razorpayOrderId: response.razorpay_order_id,
                  razorpayPaymentId: response.razorpay_payment_id,
                  razorpaySignature: response.razorpay_signature,
                }),
              });
              const verified = await verifyRes.json();
              if (!verifyRes.ok) throw new Error(verified.error || 'Payment could not be verified.');
              resolve(verified.job || job);
            } catch (err) {
              reject(err);
            }
          },
          modal: {
            // Closing the popup abandons payment; the job stays unpaid rather
            // than silently printing.
            ondismiss: () => reject(new Error('Payment was cancelled.')),
          },
        });

        checkout.on('payment.failed', (event) => {
          reject(new Error(event?.error?.description || 'The payment failed.'));
        });

        checkout.open();
      });
    }

    function showJobStatus(job, message) {
      if (screenCustomer) screenCustomer.hidden = true;
      if (screenStatus) screenStatus.hidden = false;

      document.getElementById('statusTokenNumber').textContent = `Token ${job.tokenNumber || '#001'}`;
      document.getElementById('stFileName').textContent = job.fileName;
      document.getElementById('stPageCopy').textContent =
        `${job.pageCount} ${job.pageCount === 1 ? 'page' : 'pages'}, ${job.copies} ${job.copies === 1 ? 'copy' : 'copies'}`;
      document.getElementById('stAmount').textContent = formatRupees(job.totalPriceInCents);

      renderJobProgress(job);
      if (message) showToast('success', message.title, message.body);
      startPollingJobStatus(job.id);
    }

    /**
     * What the shop asks a customer for. Empty until portal-config is read,
     * which is the safe default: no fields shown, nothing sent.
     */
    let portalConfig = {
      collectCustomerName: false, customerNameRequired: false,
      collectCustomerPhone: false, customerPhoneRequired: false,
    };

    /**
     * What this shop actually sells, from the API.
     *
     * Derived server-side rather than here, so the page that hides a control
     * and the endpoint that refuses the job can never disagree about what is
     * on offer. Null until loaded, which means "show everything" — an older
     * cached page must not start refusing options mid-order.
     */
    let portalOptions = null;

    async function loadPortalOptions(shopId) {
      if (!shopId) return;
      try {
        const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(shopId)}/portal-options`);
        if (!res.ok) return;
        portalOptions = await res.json();
        applyPortalOptions();
      } catch {
        // Leave everything visible. The server still refuses anything this shop
        // does not sell, so the worst case is a refusal at submit rather than a
        // customer who cannot order at all.
      }
    }

    /**
     * Hides what this shop does not offer.
     *
     * A control with one remaining choice is hidden entirely rather than shown
     * as a single option: a radio group of one is a question with no answer to
     * give, and it invites a customer to wonder what the other one was.
     */
    function applyPortalOptions() {
      if (!portalOptions) return;
      const o = portalOptions;

      const show = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.hidden = !on;
      };
      const pill = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.hidden = !on;
      };

      // Colour
      pill('pillBw', o.colourModes.includes('bw'));
      pill('pillColor', o.colourModes.includes('colour'));
      show('groupColorMode', o.colourModes.length > 1);
      if (o.colourModes.length === 1) selectColorMode(o.colourModes[0] === 'colour');

      // Sides
      pill('pillSingle', o.sidedModes.includes('single'));
      pill('pillDuplex', o.sidedModes.includes('duplex'));
      show('groupDuplexMode', o.sidedModes.length > 1);
      if (o.sidedModes.length === 1) selectDuplexMode(o.sidedModes[0] === 'duplex');

      // Paper
      const select = document.getElementById('selectPaperSize');
      if (select) {
        [...select.options].forEach((opt) => {
          opt.hidden = !o.paperSizes.includes(opt.value);
          opt.disabled = opt.hidden;
        });
        if (!o.paperSizes.includes(select.value) && o.paperSizes.length > 0) {
          select.value = o.paperSizes[0];
          select.dispatchEvent(new Event('change'));
        }
      }
      show('groupPaperSize', o.paperSizes.length > 1);

      // Orientation
      const orientations = Array.isArray(o.orientations) && o.orientations.length
        ? o.orientations
        : ['auto'];
      pill('pillOrientAuto', orientations.includes('auto'));
      pill('pillOrientPortrait', orientations.includes('portrait'));
      pill('pillOrientLandscape', orientations.includes('landscape'));
      show('groupOrientation', orientations.length > 1);
      if (!orientations.includes(orientation)) selectOrientation(orientations[0]);

      show('groupCopies', o.allowMultipleCopies);
      show('groupPageRange', o.allowPageSelection);

      // A shop can switch off one exact combination while keeping its siblings
      // on — A4 colour double-sided, say. The pills above are per dimension, so
      // they cannot express that; without this the customer picks a
      // combination the server then refuses at submit, after they have chosen
      // everything else.
      applySellableCombinations();
    }

    /**
     * Steers away from a combination this shop has switched off.
     *
     * Deliberately corrective rather than restrictive: the pills stay
     * available, and if the current selection is unsellable the sided or colour
     * choice moves to one that is. The server still refuses an unsellable
     * order, so this is about not walking the customer into that refusal.
     */
    function applySellableCombinations() {
      const combos = portalOptions?.sellableCombinations;
      if (!Array.isArray(combos) || combos.length === 0) return;

      const sellable = (c, d) => combos.some(
        (x) => x.paperSize === paperSize && x.isColor === c && x.isDuplex === d
      );

      if (sellable(isColor, isDuplex)) return;

      // Try keeping the colour choice, which customers care about more than
      // sides, and move the sides instead.
      if (sellable(isColor, !isDuplex)) {
        selectDuplexMode(!isDuplex);
        return;
      }

      // Otherwise take the first combination this shop sells on this paper.
      const fallback = combos.find((x) => x.paperSize === paperSize);
      if (fallback) {
        selectColorMode(fallback.isColor);
        selectDuplexMode(fallback.isDuplex);
      }
    }

    /**
     * Moves the choice to one the shop actually offers.
     *
     * Needed because the markup starts on "auto" and a shop may have switched
     * exactly that off — leaving the page holding a value the server will refuse.
     */
    function selectOrientation(value) {
      const input = document.querySelector(`input[name="orientation"][value="${value}"]`);
      if (input && !input.checked) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    /** Forces a colour choice when the shop offers only one. */
    function selectColorMode(wantColour) {
      const input = document.querySelector(`input[name="colorMode"][value="${wantColour ? 'color' : 'bw'}"]`);
      if (input && !input.checked) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    function selectDuplexMode(wantDuplex) {
      const input = document.querySelector(`input[name="duplexMode"][value="${wantDuplex ? 'duplex' : 'single'}"]`);
      if (input && !input.checked) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    async function loadPortalConfig(shopId) {
      if (!shopId) return;
      try {
        const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(shopId)}/portal-config`);
        if (!res.ok) return;
        portalConfig = { ...portalConfig, ...(await res.json()) };
        renderCustomerDetails();
      } catch {
        // Leave the fields hidden. A shop that wanted a phone number will chase
        // it at the counter; a broken form would lose the order outright.
      }
    }

    function renderCustomerDetails() {
      const box = document.getElementById('customerDetailsBox');
      const nameField = document.getElementById('customerNameField');
      const phoneField = document.getElementById('customerPhoneField');
      if (!box) return;

      const wantsName = !!portalConfig.collectCustomerName;
      const wantsPhone = !!portalConfig.collectCustomerPhone;

      box.hidden = !(wantsName || wantsPhone);
      if (nameField) nameField.hidden = !wantsName;
      if (phoneField) phoneField.hidden = !wantsPhone;

      // The asterisk is the only signal a customer gets before submitting, so
      // it has to match what the server will actually enforce.
      const nameLabel = document.getElementById('labelCustomerName');
      if (nameLabel) nameLabel.textContent = portalConfig.customerNameRequired ? 'Name *' : 'Name (optional)';
      const phoneLabel = document.getElementById('labelCustomerPhone');
      if (phoneLabel) {
        phoneLabel.textContent = portalConfig.customerPhoneRequired
          ? 'Mobile number *' : 'Mobile number (optional)';
      }
    }

    /** Returns the values to send, or null having shown why it cannot. */
    function readCustomerDetails() {
      const errorBox = document.getElementById('customerDetailsError');
      const show = (message) => {
        if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; }
        return null;
      };
      if (errorBox) errorBox.hidden = true;

      const name = (document.getElementById('inputCustomerName')?.value || '').replace(/\s+/g, ' ').trim();
      const phone = (document.getElementById('inputCustomerPhone')?.value || '').trim();

      if (portalConfig.collectCustomerName && portalConfig.customerNameRequired && !name) {
        return show('This shop needs your name for the order.');
      }
      if (portalConfig.collectCustomerPhone && portalConfig.customerPhoneRequired && !phone) {
        return show('This shop needs your mobile number for the order.');
      }
      if (phone && !/^[0-9+][0-9 ()+-]{5,}$/.test(phone)) {
        return show('That mobile number does not look right.');
      }

      return {
        ...(portalConfig.collectCustomerName && name ? { customerName: name } : {}),
        ...(portalConfig.collectCustomerPhone && phone ? { customerPhone: phone } : {}),
      };
    }

    async function submitCustomerPrintJob(method) {
      if (submitting) return; // guard against a double tap creating two paid jobs
      if (!selectedFile || !fileBase64) {
        showToast('warning', 'Still Preparing', 'Your document is still being read. Try again in a moment.');
        return;
      }

      // Checked here rather than after upload: a customer should not wait for a
      // document to transfer only to be told their name is missing.
      const customer = readCustomerDetails();
      if (customer === null) {
        document.getElementById('customerDetailsBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      submitting = true;
      setPayButtonsEnabled(false);
      showToast('info', 'Submitting Job...', 'Uploading document to printer queue...');

      try {
        // autoApprove=false for both routes: a job is only ever queued once
        // payment is actually confirmed.
        const res = await fetch(`${API_BASE}/api/print-jobs?autoApprove=false`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Same key for every retry of this one submission, so a double tap
            // or a reconnect returns the original job instead of creating and
            // charging for a second. Minted when the file was chosen, not here.
            'Idempotency-Key': submissionKey,
          },
          body: JSON.stringify({
            printerId: currentPrinterId,
            fileName: selectedFile.name,
            fileBase64,
            pageCount,
            copies,
            isColor,
            isDuplex,
            paperSize,
            orientation,
            pageRange: pageRangeMode === 'custom' ? customPageRange : null,
            ...customer,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.job) {
          showToast('danger', 'Submission Error', data.error || 'Could not create print job.');
          submitting = false;
          setPayButtonsEnabled(true);
          return;
        }

        if (method === 'cash') {
          showJobStatus(data.job, {
            title: 'Show this token at the counter',
            body: `Pay ₹${(data.job.totalPriceInCents / 100).toFixed(2)} in cash. Printing starts once the shop confirms.`,
          });
          return;
        }

        showToast('info', 'Opening payment...', 'Complete the payment to start printing.');
        const paidJob = await payWithRazorpay(data.job);
        showJobStatus(paidJob, {
          title: 'Payment received',
          body: `Token ${paidJob.tokenNumber || ''} is queued for printing.`,
        });
      } catch (err) {
        // The job exists but is unpaid; the customer can retry or pay cash.
        showToast('danger', 'Payment not completed', err.message || 'Failed to submit print job.');
        submitting = false;
        setPayButtonsEnabled(true);
      }
    }

    const btnNewPrintJob = document.getElementById('btnNewPrintJob');
    if (btnNewPrintJob) {
      btnNewPrintJob.addEventListener('click', () => window.location.reload());
    }

    const btnCopyToken = document.getElementById('btnCopyToken');
    if (btnCopyToken) {
      btnCopyToken.addEventListener('click', async () => {
        const tok = document.getElementById('statusTokenNumber').textContent;
        const ok = await copyToClipboard(tok);
        showToast(ok ? 'info' : 'warning',
          ok ? 'Copied!' : 'Copy Unavailable',
          ok ? `${tok} copied to clipboard.` : 'Please note the token down manually.');
      });
    }
  }

  // ============================================================
  //  CLIENT-SIDE PDF PAGE COUNTER & RANGE PARSER HELPERS
  // ============================================================
  /* =========================================================================
   * Document preview
   *
   * The preview box existed in the markup but nothing ever drew into it, so a
   * customer saw an empty panel. It now renders the real document and reflects
   * the settings chosen underneath it: greyscale when B&W is selected, and the
   * page range that will actually print. What you see is what comes out.
   * ========================================================================= */

  const DocumentPreview = {
    pdf: null,
    objectUrl: null,
    page: 1,
    totalPages: 1,
    kind: 'none',   // pdf | image | unsupported | none

    els() {
      return {
        box: document.getElementById('documentPreviewBox'),
        img: document.getElementById('previewImg'),
        canvas: document.getElementById('previewCanvas'),
        fallback: document.getElementById('previewFallback'),
        fallbackText: document.getElementById('previewFallbackText'),
        badge: document.getElementById('previewPageBadge'),
        nav: document.getElementById('previewNav'),
        navLabel: document.getElementById('previewNavLabel'),
        note: document.getElementById('previewNote'),
      };
    },

    /** Releases the previous file's resources before loading another. */
    reset() {
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
      }
      this.pdf = null;
      this.page = 1;
      this.totalPages = 1;
      this.kind = 'none';

      const { box, img, canvas, fallback, nav } = this.els();
      if (img) { img.hidden = true; img.removeAttribute('src'); }
      if (canvas) canvas.hidden = true;
      if (fallback) fallback.hidden = false;
      if (nav) nav.hidden = true;
      if (box) box.hidden = true;
    },

    async load(file) {
      this.reset();
      const { box, fallbackText } = this.els();
      if (box) box.hidden = false;
      if (fallbackText) fallbackText.textContent = 'Loading preview…';

      const name = (file.name || '').toLowerCase();

      try {
        if (/\.(png|jpe?g|webp|gif|bmp)$/.test(name)) {
          await this.loadImage(file);
        } else if (name.endsWith('.pdf')) {
          await this.loadPdf(file);
        } else {
          // Office formats cannot be rendered in the browser without shipping a
          // converter. Say so plainly rather than showing a blank box.
          this.kind = 'unsupported';
          if (fallbackText) {
            fallbackText.textContent =
              'Preview is not available for this file type, but it will print normally.';
          }
        }
      } catch (err) {
        this.kind = 'unsupported';
        if (fallbackText) {
          fallbackText.textContent = 'Could not render a preview. The file will still print.';
        }
      }

      this.refresh();
    },

    async loadImage(file) {
      const { img, fallback } = this.els();
      this.objectUrl = URL.createObjectURL(file);
      this.kind = 'image';
      this.totalPages = 1;

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = this.objectUrl;
      });

      img.hidden = false;
      if (fallback) fallback.hidden = true;
    },

    async loadPdf(file) {
      if (typeof window.pdfjsLib === 'undefined') {
        throw new Error('pdf.js unavailable');
      }

      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

      const buffer = await file.arrayBuffer();
      this.pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
      this.kind = 'pdf';
      this.totalPages = this.pdf.numPages;
      this.page = 1;

      await this.renderPdfPage();
    },

    async renderPdfPage() {
      if (!this.pdf) return;

      const { canvas, fallback } = this.els();
      const page = await this.pdf.getPage(this.page);

      // Fit the viewport width, capped so a huge page does not blow up memory.
      const viewportWidth = Math.min(canvas.parentElement?.clientWidth || 320, 640);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(viewportWidth / base.width, 2);
      const viewport = page.getViewport({ scale });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

      canvas.hidden = false;
      if (fallback) fallback.hidden = true;
    },

    async goTo(pageNumber) {
      if (this.kind !== 'pdf') return;
      const next = Math.min(Math.max(1, pageNumber), this.totalPages);
      if (next === this.page) return;
      this.page = next;
      await this.renderPdfPage();
      this.refresh();
    },

    /** Parses "1-3, 5" into the set of pages that will print. */
    selectedPages() {
      if (pageRangeMode !== 'custom' || !customPageRange.trim()) {
        return null; // all pages
      }

      const pages = new Set();
      for (const part of customPageRange.split(',')) {
        const piece = part.trim();
        if (!piece) continue;

        const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
        if (range) {
          const from = Number(range[1]);
          const to = Number(range[2]);
          for (let i = Math.min(from, to); i <= Math.max(from, to); i++) pages.add(i);
        } else if (/^\d+$/.test(piece)) {
          pages.add(Number(piece));
        }
      }
      return pages.size ? pages : null;
    },

    /** Re-applies whatever the customer has selected below the preview. */
    refresh() {
      const { box, img, canvas, badge, nav, navLabel, note } = this.els();
      if (!box || box.hidden) return;

      // Black and white is shown as black and white, so the choice is visible
      // rather than something the customer discovers at the counter.
      const filter = isColor ? 'none' : 'grayscale(100%)';
      if (img) img.style.filter = filter;
      if (canvas) canvas.style.filter = filter;

      const selected = this.selectedPages();
      const printing = selected ? selected.size : this.totalPages;

      if (badge) {
        badge.textContent = this.kind === 'pdf'
          ? `Page ${this.page} of ${this.totalPages}`
          : `${this.totalPages} page${this.totalPages === 1 ? '' : 's'}`;
      }

      if (nav) nav.hidden = !(this.kind === 'pdf' && this.totalPages > 1);
      if (navLabel) navLabel.textContent = `${this.page} / ${this.totalPages}`;

      const prev = document.getElementById('btnPrevPage');
      const next = document.getElementById('btnNextPage');
      if (prev) prev.disabled = this.page <= 1;
      if (next) next.disabled = this.page >= this.totalPages;

      if (note) {
        const bits = [];
        bits.push(isColor ? 'Colour' : 'Black & white');
        bits.push(isDuplex ? 'both sides' : 'one side');
        if (selected) {
          bits.push(`pages ${customPageRange.trim()} (${printing} of ${this.totalPages})`);
        }
        if (copies > 1) bits.push(`${copies} copies`);

        let text = bits.join(' · ');

        // Warn when the typed range does not exist in the document.
        if (selected && [...selected].some((n) => n > this.totalPages)) {
          text += ' — some selected pages are beyond the end of this document';
          note.classList.add('preview-note--warn');
        } else {
          note.classList.remove('preview-note--warn');
        }

        // Dim pages that will not print, so the exclusion is visible.
        const excluded = selected && this.kind === 'pdf' && !selected.has(this.page);
        if (img) img.classList.toggle('preview--excluded', Boolean(excluded));
        if (canvas) canvas.classList.toggle('preview--excluded', Boolean(excluded));
        if (excluded) text += ' — this page will not be printed';

        note.textContent = text;
      }
    },
  };

  function detectPdfPages(uint8Array) {
    try {
      const str = new TextDecoder('latin1').decode(uint8Array);
      let countMatches = str.match(/\/Count\s+(\d+)/g);
      if (countMatches && countMatches.length > 0) {
        const maxVal = Math.max(...countMatches.map(m => parseInt(m.split(/\s+/)[1], 10)));
        if (!isNaN(maxVal) && maxVal > 0) return maxVal;
      }
      let pageMatches = str.match(/\/Type\s*\/Page\b/g);
      if (pageMatches && pageMatches.length > 0) return pageMatches.length;
      return 1;
    } catch {
      return 1;
    }
  }

  function parseCustomPageRange(rangeStr, totalPages) {
    try {
      const parts = rangeStr.split(',');
      const selected = new Set();
      for (const part of parts) {
        const clean = part.trim();
        if (clean.includes('-')) {
          const [startStr, endStr] = clean.split('-');
          const start = parseInt(startStr, 10);
          const end = parseInt(endStr, 10);
          if (!isNaN(start) && !isNaN(end) && start <= end) {
            for (let i = start; i <= end; i++) {
              if (i >= 1 && i <= totalPages) selected.add(i);
            }
          }
        } else {
          const num = parseInt(clean, 10);
          if (!isNaN(num) && num >= 1 && num <= totalPages) selected.add(num);
        }
      }
      return selected.size > 0 ? selected.size : totalPages;
    } catch {
      return totalPages;
    }
  }

  // Helper functions
  async function fetchShopInfo(printerId) {
    try {
      const res = await fetch(`${API_BASE}/api/printers/${encodeURIComponent(printerId)}`);
      if (res.ok) {
        const data = await res.json();
        const shopNameDisplay = document.getElementById('shopNameDisplay');
        if (shopNameDisplay) shopNameDisplay.textContent = data.shop ? data.shop.name : 'PrintOk Shop';

        // Quote the shop's own rates rather than the hardcoded defaults, and
        // ask the same shop what it wants from the customer.
        if (data.shop && data.shop.id) {
          currentShopId = data.shop.id;
          await loadPortalConfig(data.shop.id);
          await loadPortalOptions(data.shop.id);
          // Now that the shop is known, replace the opening estimate with the
          // figure this shop will actually charge.
          if (rerenderPrice) rerenderPrice();
        }
      } else {
        const shopNameDisplay = document.getElementById('shopNameDisplay');
        if (shopNameDisplay) shopNameDisplay.textContent = 'Shop Not Found';
        showToast('danger', 'Shop Not Found', 'This QR code points to a printer that no longer exists.');
      }
    } catch {
      const shopNameDisplay = document.getElementById('shopNameDisplay');
      if (shopNameDisplay) shopNameDisplay.textContent = 'Shop Unavailable';
    }
  }

  function startAgentHealthCheck(printerId) {
    if (!printerId) return;
    checkAgentHealth(printerId);
    healthCheckTimer = setInterval(() => checkAgentHealth(printerId), 15000);
    window.addEventListener('beforeunload', () => clearInterval(healthCheckTimer));
    // Stop polling while the tab is in the background.
    document.addEventListener('visibilitychange', () => {
      clearInterval(healthCheckTimer);
      if (!document.hidden) {
        checkAgentHealth(printerId);
        healthCheckTimer = setInterval(() => checkAgentHealth(printerId), 15000);
      }
    });
  }

  async function checkAgentHealth(printerId) {
    try {
      const res = await fetch(`${API_BASE}/api/printers/${encodeURIComponent(printerId)}/telemetry`);
      if (res.ok) {
        const telemetry = await res.json();
        const agentOfflineWarning = document.getElementById('agentOfflineWarning');
        const shopStatusDot = document.getElementById('shopStatusDot');

        if (telemetry.isOnline) {
          if (agentOfflineWarning) agentOfflineWarning.hidden = true;
          if (shopStatusDot) shopStatusDot.className = 'status-pulse-dot online';
        } else {
          if (agentOfflineWarning) agentOfflineWarning.hidden = false;
          if (shopStatusDot) shopStatusDot.className = 'status-pulse-dot offline';
        }
      }
    } catch {
      // ignore
    }
  }

  /** Drives the 4-step tracker on the status screen, which was previously frozen. */
  function renderJobProgress(job) {
    const badge = document.getElementById('statusBadgeState');
    if (badge) {
      badge.textContent = PRINT_STATE_LABELS[job.printState] || job.printState;
      badge.className = `badge ${PRINT_STATE_BADGES[job.printState] || 'badge-neutral'}`;
    }

    const paid = job.paymentState === 'Paid';
    const failed = job.printState === 'Failed' || job.printState === 'Cancelled';
    const sent = ['Downloading', 'Printing', 'Printed', 'Completed'].includes(job.printState);
    const printing = ['Printing', 'Printed', 'Completed'].includes(job.printState);
    const done = ['Printed', 'Completed'].includes(job.printState);

    const steps = [
      { id: 'pStep1', completed: true, active: false },
      { id: 'pStep2', completed: paid, active: !paid },
      { id: 'pStep3', completed: printing, active: sent && !printing },
      { id: 'pStep4', completed: done, active: printing && !done },
    ];

    steps.forEach(s => {
      const el = document.getElementById(s.id);
      if (!el) return;
      el.classList.toggle('completed', s.completed && !failed);
      el.classList.toggle('active', s.active && !failed);
    });

    if (failed) {
      const last = document.getElementById('pStep4');
      if (last) {
        last.classList.remove('completed', 'active');
        const text = last.querySelector('.p-text');
        const icon = last.querySelector('.p-icon');
        if (text) text.textContent = job.printState === 'Cancelled' ? 'Cancelled' : 'Print Failed';
        if (icon) icon.textContent = '⚠️';
      }
    }
  }

  function startPollingJobStatus(jobId) {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/print-jobs/${encodeURIComponent(jobId)}`);
        if (res.ok) {
          const data = await res.json();
          const job = data.job;
          renderJobProgress(job);

          if (TERMINAL_STATES.includes(job.printState)) {
            clearInterval(pollingTimer);
            pollingTimer = null;

            if (job.printState === 'Completed') {
              showToast('success', '🎉 Printing Completed!', 'Your document has been printed at the counter.');
            } else if (job.printState === 'Failed') {
              showToast('danger', 'Print Failed', job.errorMessage || 'Please speak to the shop counter staff.', 9000);
            } else {
              showToast('warning', 'Order Cancelled', 'This print job was cancelled.', 9000);
            }
          }
        }
      } catch {
        // ignore
      }
    }, 2500);

    window.addEventListener('beforeunload', () => {
      if (pollingTimer) clearInterval(pollingTimer);
    });
  }
});
