/**
 * PrintOk Web Application Client
 * Multi-page support, Document Preview, Automatic Page Detection, Custom Page Ranges & Redirects.
 */

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = window.PRINTOK_API_BASE
    || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ? 'http://localhost:4000'
      : 'https://prinok-api.onrender.com');

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
  let currentPrinterId = null;
  let pollingTimer = null;
  let healthCheckTimer = null;
  let previewObjectUrl = null;
  let shopPricing = null; // fetched from the shop so the quote matches what the backend charges
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
  const ShopContext = {
    read() {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = {
        shopId: params.get('shop'),
        printerId: params.get('printer'),
      };
      if (fromUrl.shopId || fromUrl.printerId) return fromUrl;

      try {
        const raw = localStorage.getItem('printok.shopContext');
        if (raw) return JSON.parse(raw);
      } catch {
        // localStorage can be unavailable (private mode / blocked cookies)
      }
      return { shopId: null, printerId: null };
    },
    write(ctx) {
      try {
        localStorage.setItem('printok.shopContext', JSON.stringify(ctx));
      } catch {
        // non-fatal: the dashboard just won't remember across reloads
      }
    },
  };

  // Human-facing labels for the backend PrintState enum
  const PRINT_STATE_LABELS = {
    Created: 'Created',
    AwaitingPayment: 'Awaiting Payment',
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
  (function wireGlobalNav() {
    const ctx = ShopContext.read();
    if (!ctx.printerId) return;
    const navLink = document.getElementById('navCustomerLink');
    if (navLink) navLink.href = `/?printer=${encodeURIComponent(ctx.printerId)}`;
  })();

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

        btnSubmitRegister.disabled = true;
        btnSubmitRegister.textContent = 'Processing Payment & Activating...';

        try {
          const res = await fetch(`${API_BASE}/api/shops/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shopName, ownerEmail, printerName, upiId, plan: selectedPlan }),
          });

          const data = await res.json();
          if (res.ok && data.shop && data.printer) {
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
            if (btnDownloadAgentConfig) btnDownloadAgentConfig.href = `${API_BASE}/api/printers/${data.printer.id}/agent-config`;

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
        await fetch(`${API_BASE}/api/shops/${encodeURIComponent(shopId)}/pricing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
    const ctx = ShopContext.read();
    let dashShopId = ctx.shopId || null;
    let dashPrinterId = ctx.printerId || null;
    let queueFilter = 'all';
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

    tabBtns.forEach((btn, idx) => {
      btn.addEventListener('click', () => activateTab(btn));
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

    // --- Queue filter pills ---
    document.querySelectorAll('.filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        queueFilter = pill.getAttribute('data-filter') || 'all';
        document.querySelectorAll('.filter-pill').forEach(p => {
          const on = p === pill;
          p.classList.toggle('active', on);
          p.setAttribute('aria-pressed', String(on));
        });
        renderQueue(cachedJobs);
      });
    });

    if (!dashShopId) {
      showNoShopState();
    } else {
      loadDashboard();
      dashTimer = setInterval(loadDashboard, 8000);
      window.addEventListener('beforeunload', () => clearInterval(dashTimer));
    }

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

    // --- Rates matrix save (the form had no handler at all) ---
    const btnSavePricing = document.getElementById('btnSavePricing');
    if (btnSavePricing) {
      btnSavePricing.addEventListener('click', async () => {
        if (!dashShopId) {
          showToast('warning', 'No Shop Connected', 'Register a shop before setting rates.');
          return;
        }

        const toCents = (id) => {
          const el = document.getElementById(id);
          const v = el ? parseFloat(el.value) : NaN;
          return Number.isFinite(v) ? Math.round(v * 100) : null;
        };

        const config = {
          bwSinglePerPageCents: toCents('rateBwSingle'),
          bwDuplexPerPageCents: toCents('rateBwDuplex'),
          colorSinglePerPageCents: toCents('rateColorSingle'),
          colorDuplexPerPageCents: toCents('rateColorDuplex'),
        };

        if (Object.values(config).some(v => v === null || v <= 0)) {
          showToast('warning', 'Invalid Rates', 'Every rate must be a number greater than zero.');
          return;
        }

        btnSavePricing.disabled = true;
        const original = btnSavePricing.textContent;
        btnSavePricing.textContent = 'Saving...';

        try {
          const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(dashShopId)}/pricing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
          });
          const data = await res.json();
          if (res.ok) {
            showToast('success', 'Rates Saved', 'New per-page rates now apply to incoming jobs.');
          } else {
            showToast('danger', 'Save Failed', data.error || 'Could not update rates.');
          }
        } catch {
          showToast('danger', 'Network Error', 'Could not reach the API server.');
        } finally {
          btnSavePricing.disabled = false;
          btnSavePricing.textContent = original;
        }
      });
    }

    // --- QR poster actions ---
    const btnDownloadQr = document.getElementById('btnDownloadQr');
    if (btnDownloadQr) {
      btnDownloadQr.addEventListener('click', () => {
        const img = document.getElementById('dashQrImg');
        if (!img || !img.src) {
          showToast('warning', 'No QR Yet', 'Connect a shop to generate its QR poster.');
          return;
        }
        const a = document.createElement('a');
        a.href = img.src;
        a.download = 'PrintOk_Shop_QR.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        showToast('info', 'QR Sign Downloaded', 'Print and place at your shop counter.');
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
        const settings = JSON.stringify({
          PrintOkApiUrl: API_BASE,
          ShopId: dashShopId,
          PrinterId: dashPrinterId,
          AgentApiKey: apiKey.textContent,
          HeartbeatIntervalSeconds: 30,
        }, null, 2);

        const ok = await copyToClipboard(settings);
        showToast(ok ? 'success' : 'danger',
          ok ? 'Settings Copied' : 'Copy Failed',
          ok ? 'Paste into appsettings.json next to PrintAgent.exe.' : 'Select the values manually instead.');
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
          const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(dashShopId)}/withdraw`, { method: 'POST' });
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
      await Promise.all([loadShopIdentity(), loadMetrics(), loadQueue(), loadPricingForm()]);
      await loadTelemetry();
    }

    /** The rates form showed hardcoded defaults regardless of what the shop had saved. */
    async function loadPricingForm() {
      try {
        const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(dashShopId)}/pricing`);
        if (!res.ok) return;
        const { pricing } = await res.json();
        if (!pricing) return;

        const fill = (id, cents) => {
          const el = document.getElementById(id);
          // Don't clobber what the owner is currently typing.
          if (el && document.activeElement !== el && Number.isFinite(cents)) {
            el.value = (cents / 100).toFixed(2);
          }
        };
        fill('rateBwSingle', pricing.bwSinglePerPageCents);
        fill('rateBwDuplex', pricing.bwDuplexPerPageCents);
        fill('rateColorSingle', pricing.colorSinglePerPageCents);
        fill('rateColorDuplex', pricing.colorDuplexPerPageCents);
      } catch {
        // keep whatever is in the form
      }
    }

    /** Populates the shop header, QR tab and agent pairing panel — all previously stuck on "--". */
    async function loadShopIdentity() {
      if (!dashPrinterId) {
        // Derive the printer from the shop's most recent job when it wasn't stored.
        try {
          const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(dashShopId)}/jobs?limit=1`);
          if (res.ok) {
            const data = await res.json();
            if (data.jobs && data.jobs[0]) dashPrinterId = data.jobs[0].printerId;
          }
        } catch {
          // leave the pairing panel empty
        }
      }
      if (!dashPrinterId) return;

      try {
        const res = await fetch(`${API_BASE}/api/printers/${encodeURIComponent(dashPrinterId)}`);
        if (!res.ok) return;
        const { printer, shop } = await res.json();

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

          const customerLink = document.getElementById('btnCustomerLink');
          if (customerLink) customerLink.href = `/?printer=${encodeURIComponent(printer.id)}`;
          const navLink = document.getElementById('navCustomerLink');
          if (navLink) navLink.href = `/?printer=${encodeURIComponent(printer.id)}`;

          const exeLink = document.getElementById('btnDownloadAgentExe');
          if (exeLink) exeLink.href = `${API_BASE}/api/agent-installer`;
          const cfgLink = document.getElementById('btnDownloadAgentConfigFile');
          if (cfgLink) cfgLink.href = `${API_BASE}/api/printers/${encodeURIComponent(printer.id)}/agent-config`;
        }
      } catch {
        // keep whatever is already rendered
      }
    }

    async function loadMetrics() {
      try {
        const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(dashShopId)}/stats`);
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
        const payoutRes = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(dashShopId)}/payout-summary`);
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
          // payout-summary returns a placeholder UPI; only use it if the shop has none.
          if (!shopUpiId && p.payoutUpiId) set('dashPayoutUpi', p.payoutUpiId);
        }
      } catch {
        // ignore
      }
    }

    /** The queue feed was never fetched — the empty state was permanent. */
    async function loadQueue() {
      const list = document.getElementById('liveQueueList');
      if (list) list.setAttribute('aria-busy', 'true');
      try {
        const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(dashShopId)}/jobs?limit=50`);
        if (res.ok) {
          const data = await res.json();
          cachedJobs = Array.isArray(data.jobs) ? data.jobs : [];
          renderQueue(cachedJobs);

          // "Printed Pages" has no API field; derive it from completed jobs.
          const pages = cachedJobs
            .filter(j => j.printState === 'Completed' || j.printState === 'Printed')
            .reduce((sum, j) => sum + (j.pageCount || 0) * (j.copies || 1), 0);
          const pagesEl = document.getElementById('statPrintedPages');
          if (pagesEl) pagesEl.textContent = String(pages);

          // The tile reads "Awaiting Agent / Cash", so count both, not just queued.
          const outstanding = cachedJobs.filter(j =>
            ['AwaitingPayment', 'Queued', 'Downloading', 'Printing'].includes(j.printState)).length;
          const queuedEl = document.getElementById('statQueuedCount');
          if (queuedEl) queuedEl.textContent = String(outstanding);
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

      const visible = queueFilter === 'all'
        ? jobs
        : jobs.filter(j => j.printState === queueFilter);

      if (visible.length === 0) {
        list.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <div class="empty-title">${jobs.length === 0 ? 'No Print Jobs Yet' : 'Nothing Matches This Filter'}</div>
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
                <div class="queue-meta">${escapeHtml(detail)}</div>
              </div>
            </div>
            <div class="queue-row-actions">
              <span class="queue-amount">${formatRupees(job.totalPriceInCents)}</span>
              <span class="badge ${badgeClass}">${escapeHtml(label)}</span>
              ${needsCash ? `<button type="button" class="btn btn-primary btn-sm" data-approve="${escapeHtml(job.id)}">✅ Cash Received</button>` : ''}
            </div>
          </div>`;
      }).join('');

      list.querySelectorAll('[data-approve]').forEach(btn => {
        btn.addEventListener('click', () => approveCashJob(btn.getAttribute('data-approve'), btn));
      });
    }

    async function approveCashJob(jobId, btn) {
      btn.disabled = true;
      btn.textContent = 'Approving...';
      try {
        const res = await fetch(`${API_BASE}/api/print-jobs/${encodeURIComponent(jobId)}/manual-override`, { method: 'POST' });
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
      detectedTotalPages = 1;
      pageCount = 1;
      copies = 1;

      const copiesVal = document.getElementById('copiesVal');
      if (copiesVal) copiesVal.textContent = '1';

      // Without this, re-picking the same file fires no change event.
      if (fileInput) fileInput.value = '';
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = null;
      }

      const previewViewport = document.querySelector('.preview-viewport');
      if (previewViewport) previewViewport.innerHTML = '';

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
      setPayButtonsEnabled(false);

      if (infoFileName) infoFileName.textContent = file.name;
      if (infoFileMeta) infoFileMeta.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB • Detecting pages...`;

      if (fileInfoBox) fileInfoBox.hidden = false;
      if (documentPreviewBox) documentPreviewBox.hidden = false;
      if (configSection) configSection.hidden = false;
      if (dropZone) dropZone.hidden = true;

      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      const previewViewport = document.querySelector('.preview-viewport');
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = URL.createObjectURL(file);
      const blobUrl = previewObjectUrl;

      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        detectedTotalPages = detectPdfPages(bytes);
        if (previewViewport) {
          previewViewport.innerHTML = `<object data="${escapeHtml(blobUrl)}#toolbar=0&navpanes=0&page=1" type="application/pdf" style="width:100%; height:260px; border:none; border-radius:4px;"></object>`;
        }
      } else if (file.type.startsWith('image/')) {
        detectedTotalPages = 1;
        if (previewViewport) {
          previewViewport.innerHTML = `<img src="${escapeHtml(blobUrl)}" alt="Preview of ${escapeHtml(file.name)}" style="max-width:100%; max-height:260px; object-fit:contain; border-radius:4px;">`;
        }
      } else {
        detectedTotalPages = 1;
        if (previewViewport) {
          previewViewport.innerHTML = `<div class="preview-fallback"><div class="fallback-icon" aria-hidden="true">📄</div><div>${escapeHtml(file.name)}</div><div class="empty-sub">No inline preview for this format. Page count is confirmed by the shop before printing.</div></div>`;
        }
      }

      if (infoFileMeta) {
        infoFileMeta.textContent = `${detectedTotalPages} ${detectedTotalPages === 1 ? 'page' : 'pages'} • ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
      }

      const allPagesCountBadge = document.getElementById('allPagesCountBadge');
      if (allPagesCountBadge) allPagesCountBadge.textContent = String(detectedTotalPages);

      const previewPageBadge = document.getElementById('previewPageBadge');
      if (previewPageBadge) {
        previewPageBadge.textContent = detectedTotalPages === 1 ? '1 page' : `${detectedTotalPages} pages`;
      }

      pageCount = detectedTotalPages;
      updateCustomerPrice();

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

    // Paper size was collected but never fed back into the quote.
    const selectPaperSize = document.getElementById('selectPaperSize');
    if (selectPaperSize) {
      selectPaperSize.addEventListener('change', () => {
        paperSize = selectPaperSize.value || 'A4';
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
     * Mirrors the server's calculateJobPrice so the quote on screen is the amount charged:
     * shop-configured rates, A3 multiplier and bulk discount all included.
     */
    function updateCustomerPrice() {
      const cfg = shopPricing || {
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

    // Payment submissions
    const btnPayCash = document.getElementById('btnPayCash');
    const btnPayRazorpay = document.getElementById('btnPayRazorpay');

    setPayButtonsEnabled(false);

    if (btnPayCash) {
      btnPayCash.addEventListener('click', () => submitCustomerPrintJob(true));
    }
    if (btnPayRazorpay) {
      btnPayRazorpay.addEventListener('click', () => submitCustomerPrintJob(false));
    }

    let submitting = false;

    async function submitCustomerPrintJob(autoApprove) {
      if (submitting) return; // guard against a double tap creating two paid jobs
      if (!selectedFile || !fileBase64) {
        showToast('warning', 'Still Preparing', 'Your document is still being read. Try again in a moment.');
        return;
      }

      submitting = true;
      setPayButtonsEnabled(false);
      showToast('info', 'Submitting Job...', 'Uploading document to printer queue...');

      try {
        const res = await fetch(`${API_BASE}/api/print-jobs?autoApprove=${autoApprove}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            printerId: currentPrinterId,
            fileName: selectedFile.name,
            fileBase64,
            pageCount,
            copies,
            isColor,
            isDuplex,
            paperSize,
            pageRange: pageRangeMode === 'custom' ? customPageRange : null,
          }),
        });

        const data = await res.json();
        if (res.ok && data.job) {
          if (screenCustomer) screenCustomer.hidden = true;
          if (screenStatus) screenStatus.hidden = false;

          document.getElementById('statusTokenNumber').textContent = `Token ${data.job.tokenNumber || '#001'}`;
          document.getElementById('stFileName').textContent = data.job.fileName;
          document.getElementById('stPageCopy').textContent =
            `${data.job.pageCount} ${data.job.pageCount === 1 ? 'page' : 'pages'}, ${data.job.copies} ${data.job.copies === 1 ? 'copy' : 'copies'}`;
          document.getElementById('stAmount').textContent = formatRupees(data.job.totalPriceInCents);

          renderJobProgress(data.job);
          showToast('success', 'Job Submitted!', `Token ${data.job.tokenNumber || '#001'} queued for printing.`);
          startPollingJobStatus(data.job.id);
        } else {
          showToast('danger', 'Submission Error', data.error || 'Could not create print job.');
          submitting = false;
          setPayButtonsEnabled(true);
        }
      } catch {
        showToast('danger', 'Network Failure', 'Failed to submit print job.');
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

        // Quote the shop's own rates rather than the hardcoded defaults.
        if (data.shop && data.shop.id) await fetchShopPricing(data.shop.id);
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

  async function fetchShopPricing(shopId) {
    try {
      const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(shopId)}/pricing`);
      if (res.ok) {
        const data = await res.json();
        if (data.pricing) {
          shopPricing = data.pricing;
          if (rerenderPrice) rerenderPrice();
        }
      }
    } catch {
      // keep the default rate card
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
