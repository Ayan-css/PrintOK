/**
 * PrintOk Customer Mobile Web Client
 * Milestone 4 — Neo-Brutalist UX Redesign
 */

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://prinok-api.onrender.com';

  // ============================================================
  //  STATE
  // ============================================================
  let selectedFile = null;
  let fileBase64 = null;
  let isColor = false;
  let isDuplex = false;
  let paperSize = 'A4';
  let copies = 1;
  let pageCount = 1;
  let currentPrinterId = null;
  let pollingTimer = null;
  let healthCheckTimer = null;

  // ============================================================
  //  DOM REFS
  // ============================================================
  const screenLanding        = document.getElementById('screenLanding');
  const screenUpload         = document.getElementById('screenUpload');
  const actionBar            = document.getElementById('actionBar');
  const trackerSection       = document.getElementById('trackerSection');

  const shopNameDisplay      = document.getElementById('shopNameDisplay');
  const shopNameSkeleton     = document.getElementById('shopNameSkeleton');
  const shopStatusDot        = document.getElementById('shopStatusDot');
  const agentOfflineWarning  = document.getElementById('agentOfflineWarning');

  const dropZone             = document.getElementById('dropZone');
  const fileInput            = document.getElementById('fileInput');
  const fileSelectedDisplay  = document.getElementById('fileSelectedDisplay');
  const fileNameText         = document.getElementById('fileNameText');
  const fileSizeText         = document.getElementById('fileSizeText');
  const removeFileBtn        = document.getElementById('removeFileBtn');
  const fileError            = document.getElementById('fileError');

  const bwBtn                = document.getElementById('bwBtn');
  const colorBtn             = document.getElementById('colorBtn');
  const singleSideBtn        = document.getElementById('singleSideBtn');
  const duplexBtn            = document.getElementById('duplexBtn');
  const paperA4Btn           = document.getElementById('paperA4Btn');
  const paperA3Btn           = document.getElementById('paperA3Btn');
  const minusCopyBtn         = document.getElementById('minusCopyBtn');
  const plusCopyBtn          = document.getElementById('plusCopyBtn');
  const copiesVal            = document.getElementById('copiesVal');
  const pageCountInput       = document.getElementById('pageCountInput');
  const totalPriceText       = document.getElementById('totalPriceText');
  const payPrintBtn          = document.getElementById('payPrintBtn');

  const tokenNumberDisplay   = document.getElementById('tokenNumberDisplay');
  const statusBadge          = document.getElementById('statusBadge');
  const progressFill         = document.getElementById('progressFill');
  const progressBar          = document.getElementById('progressBar');
  const trackerMessage       = document.getElementById('trackerMessage');
  const printAnotherBtn      = document.getElementById('printAnotherBtn');

  // ============================================================
  //  HEALTH & TELEMETRY CHECK
  // ============================================================
  function startAgentHealthCheck(printerId) {
    if (!printerId) return;
    checkAgentHealth(printerId);
    healthCheckTimer = setInterval(() => checkAgentHealth(printerId), 5000);
  }

  async function checkAgentHealth(printerId) {
    try {
      const res = await fetch(`${API_BASE}/api/printers/${printerId}/telemetry`);
      if (res.ok) {
        const telemetry = await res.json();
        if (telemetry.isOnline) {
          if (agentOfflineWarning) agentOfflineWarning.hidden = true;
          if (shopStatusDot) shopStatusDot.className = 'shop-status-dot';
        } else {
          if (agentOfflineWarning) agentOfflineWarning.hidden = false;
          if (shopStatusDot) shopStatusDot.className = 'shop-status-dot offline';
        }
      }
    } catch {
      // transient network error
    }
  }

  // ============================================================
  //  TOAST SYSTEM
  // ============================================================
  const toastContainer = document.getElementById('toastContainer');

  function showToast(type, title, message, duration = 4000) {
    const icons = {
      success: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 8 6 12 14 4"/></svg>`,
      warning: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2L15 14H1L8 2z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r="0.5" fill="currentColor"/></svg>`,
      danger:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>`,
      info:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><line x1="8" y1="6" x2="8" y2="6"/><line x1="8" y1="9" x2="8" y2="12"/></svg>`,
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
      <div class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</div>
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        ${message ? `<div class="toast-msg">${message}</div>` : ''}
      </div>
      <button class="toast-close" aria-label="Dismiss notification" type="button">&times;</button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
    toastContainer.appendChild(toast);

    const timer = setTimeout(() => dismissToast(toast), duration);
    toast._timer = timer;
  }

  function dismissToast(toast) {
    clearTimeout(toast._timer);
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }

  // ============================================================
  //  SCREEN / VIEW STATE MANAGER
  // ============================================================
  function showScreen(screen) {
    screenLanding.hidden = true;
    screenUpload.hidden  = true;
    actionBar.hidden     = true;
    trackerSection.hidden = true;

    if (screen === 'landing') {
      screenLanding.hidden = false;
    } else if (screen === 'upload') {
      screenUpload.hidden = false;
      actionBar.hidden    = false;
    } else if (screen === 'tracker') {
      screenUpload.hidden   = false; // keep settings visible (greyed via disabled)
      trackerSection.hidden = false;
      actionBar.hidden      = true;
    }
  }

  // ============================================================
  //  INITIALISE — extract printer ID from URL
  // ============================================================
  const pathParts  = window.location.pathname.split('/');
  const urlParams  = new URLSearchParams(window.location.search);
  currentPrinterId = urlParams.get('printer') || (pathParts[2] || null);

  if (!currentPrinterId) {
    // No printer in URL — show landing screen
    showScreen('landing');
    hideSkeleton('Demo Shop');
  } else {
    showScreen('upload');
    fetchShopInfo();
    startAgentHealthCheck(currentPrinterId);
  }

  // ============================================================
  //  SHOP INFO
  // ============================================================
  async function fetchShopInfo() {
    try {
      const res = await fetch(`${API_BASE}/api/printers/${currentPrinterId}`);
      if (res.ok) {
        const data = await res.json();
        hideSkeleton(data.shop ? data.shop.name : 'PrintOk Shop');
        if (data.telemetry) {
          if (!data.telemetry.isOnline && agentOfflineWarning) {
            agentOfflineWarning.hidden = false;
            if (shopStatusDot) shopStatusDot.className = 'shop-status-dot offline';
          }
        }
      } else {
        hideSkeleton('Partner Shop');
      }
    } catch {
      hideSkeleton('Partner Shop');
    }
  }

  function hideSkeleton(shopName) {
    if (shopNameSkeleton) shopNameSkeleton.remove();
    shopNameDisplay.textContent = shopName;
  }

  // ============================================================
  //  FILE HANDLING
  // ============================================================

  // Click to open file dialog
  dropZone.addEventListener('click', () => fileInput.click());

  // Keyboard accessibility for drop zone
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
  });

  // Drag & Drop
  dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drag-over');
    }
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  removeFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearFile();
  });

  function handleFile(file) {
    clearFileError();

    // Validate type
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.docx', '.doc', '.xlsx', '.csv', '.pptx'];
    const fileExt = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    const isSupported = allowedExts.includes(fileExt);

    if (!isSupported) {
      showFileError('Unsupported file type. Please upload a PDF, Image (JPG/PNG), Word (.docx), Excel (.xlsx), or CSV file.');
      dropZone.classList.add('has-error');
      return;
    }

    // Validate size (25 MB)
    const maxBytes = 25 * 1024 * 1024;
    if (file.size > maxBytes) {
      showFileError(`This file is ${formatSize(file.size)} — the limit is 25 MB. Please compress or split the document.`);
      dropZone.classList.add('has-error');
      return;
    }

    selectedFile = file;
    fileNameText.textContent = file.name;
    fileSizeText.textContent = formatSize(file.size);
    fileSelectedDisplay.classList.add('visible');
    dropZone.classList.add('has-file');
    dropZone.classList.remove('has-error');

    const reader = new FileReader();
    reader.onload = () => {
      fileBase64 = reader.result.split(',')[1];
      payPrintBtn.disabled = false;
    };
    reader.onerror = () => {
      showFileError('Could not read the file. Please try again.');
    };
    reader.readAsDataURL(file);
  }

  function clearFile() {
    selectedFile = null;
    fileBase64 = null;
    fileInput.value = '';
    fileSelectedDisplay.classList.remove('visible');
    dropZone.classList.remove('has-file', 'has-error', 'drag-over');
    clearFileError();
    payPrintBtn.disabled = true;
  }

  function showFileError(msg) {
    fileError.textContent = msg;
    fileError.classList.add('visible');
  }

  function clearFileError() {
    fileError.textContent = '';
    fileError.classList.remove('visible');
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ============================================================
  //  COLOR MODE & DUPLEX & PAPER OPTIONS
  // ============================================================
  bwBtn.addEventListener('click', () => setColorMode(false));
  colorBtn.addEventListener('click', () => setColorMode(true));

  if (singleSideBtn) singleSideBtn.addEventListener('click', () => setDuplexMode(false));
  if (duplexBtn) duplexBtn.addEventListener('click', () => setDuplexMode(true));
  if (paperA4Btn) paperA4Btn.addEventListener('click', () => setPaperSize('A4'));
  if (paperA3Btn) paperA3Btn.addEventListener('click', () => setPaperSize('A3'));

  function setColorMode(color) {
    isColor = color;
    bwBtn.classList.toggle('active', !color);
    bwBtn.setAttribute('aria-pressed', String(!color));
    colorBtn.classList.toggle('active', color);
    colorBtn.setAttribute('aria-pressed', String(color));
    updatePrice();
  }

  function setDuplexMode(duplex) {
    isDuplex = duplex;
    if (singleSideBtn) {
      singleSideBtn.classList.toggle('active', !duplex);
      singleSideBtn.setAttribute('aria-pressed', String(!duplex));
    }
    if (duplexBtn) {
      duplexBtn.classList.toggle('active', duplex);
      duplexBtn.setAttribute('aria-pressed', String(duplex));
    }
    updatePrice();
  }

  function setPaperSize(size) {
    paperSize = size;
    if (paperA4Btn) {
      paperA4Btn.classList.toggle('active', size === 'A4');
      paperA4Btn.setAttribute('aria-pressed', String(size === 'A4'));
    }
    if (paperA3Btn) {
      paperA3Btn.classList.toggle('active', size === 'A3');
      paperA3Btn.setAttribute('aria-pressed', String(size === 'A3'));
    }
    updatePrice();
  }

  // ============================================================
  //  COPIES & PRICING
  // ============================================================
  minusCopyBtn.addEventListener('click', () => {
    if (copies > 1) { copies--; copiesVal.textContent = copies; updatePrice(); }
  });
  plusCopyBtn.addEventListener('click', () => {
    if (copies < 99) { copies++; copiesVal.textContent = copies; updatePrice(); }
  });

  pageCountInput.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    pageCount = (!isNaN(val) && val > 0) ? val : 1;
    updatePrice();
  });

  function updatePrice() {
    let pricePerPage = isColor ? (isDuplex ? 8.00 : 10.00) : (isDuplex ? 1.50 : 2.00);
    if (paperSize === 'A3') pricePerPage *= 2; // A3 double rate
    const total = pricePerPage * pageCount * copies;
    totalPriceText.textContent = `₹${total.toFixed(2)}`;
  }

  // ============================================================
  //  PAY & PRINT
  // ============================================================
  payPrintBtn.addEventListener('click', async () => {
    if (!fileBase64 || !selectedFile) return;

    setPayBtnLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/print-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: currentPrinterId || 'prn_demo',
          fileName: selectedFile.name,
          fileBase64,
          pageCount,
          copies,
          isColor,
          isDuplex,
          paperSize,
        }),
      });

      const data = await res.json();

      if (res.ok && data.job) {
        showScreen('tracker');
        if (data.job.tokenNumber && tokenNumberDisplay) {
          tokenNumberDisplay.textContent = data.job.tokenNumber;
        }
        startJobTracking(data.job.id);
        showToast('success', `Token ${data.job.tokenNumber || ''} Generated!`, 'Your document is queued at printer.');
      } else {
        const msg = data.error || 'Failed to submit the print job. Please try again.';
        showToast('danger', 'Submission failed', msg);
        setPayBtnLoading(false);
      }
    } catch {
      showToast('danger', 'Network error', 'Could not reach the PrintOk server. Check your connection.');
      setPayBtnLoading(false);
    }
  });


  function setPayBtnLoading(loading) {
    payPrintBtn.disabled = loading;
    payPrintBtn.classList.toggle('loading', loading);
  }

  // ============================================================
  //  JOB STATUS POLLING
  // ============================================================
  function startJobTracking(jobId) {
    updateTrackerUI('Queued');

    pollingTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/print-jobs/${jobId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.job && data.job.tokenNumber && tokenNumberDisplay) {
            tokenNumberDisplay.textContent = data.job.tokenNumber;
          }
          const state = data.job.printState;
          updateTrackerUI(state);

          if (state === 'Completed' || state === 'Failed' || state === 'Cancelled') {
            clearInterval(pollingTimer);
            pollingTimer = null;
          }
        }
      } catch {
        // Silently continue polling on network hiccups
      }
    }, 1500);
  }

  // ============================================================
  //  TRACKER UI
  // ============================================================
  const STEP_CONFIG = {
    Queued:      { progress: 20, badgeClass: 'badge-queued',   badgeLabel: 'Queued',      stepId: 'step-Queued',     msg: 'Your print job is queued — the shop printer agent is picking it up.' },
    Downloading: { progress: 50, badgeClass: 'badge-download', badgeLabel: 'Downloading', stepId: 'step-Downloading',msg: 'The printer agent is securely fetching your document.' },
    Printing:    { progress: 75, badgeClass: 'badge-printing', badgeLabel: 'Printing',    stepId: 'step-Printing',   msg: 'Your document is spooling to the physical printer right now.' },
    Completed:   { progress: 100,badgeClass: 'badge-success',  badgeLabel: 'Done ✓',      stepId: 'step-Done',       msg: '🎉 Print complete! Collect your document from the printer tray.' },
    Failed:      { progress: 100,badgeClass: 'badge-danger',   badgeLabel: 'Failed',      stepId: null,              msg: '❌ Printing failed. Please speak to the shop counter for help.' },
    Cancelled:   { progress: 100,badgeClass: 'badge-neutral',  badgeLabel: 'Cancelled',   stepId: null,              msg: 'This print job was cancelled.' },
  };

  const STEP_ORDER = ['step-Queued', 'step-Downloading', 'step-Printing', 'step-Done'];

  function updateTrackerUI(state) {
    const config = STEP_CONFIG[state];
    if (!config) return;

    // Badge
    statusBadge.className = `badge ${config.badgeClass}`;
    statusBadge.textContent = config.badgeLabel;

    // Progress bar
    progressFill.style.width = `${config.progress}%`;
    progressBar.setAttribute('aria-valuenow', config.progress);
    if (state === 'Completed') progressFill.classList.add('complete');
    if (state === 'Failed')    progressFill.classList.add('failed');

    // Steps
    const activeIndex = config.stepId ? STEP_ORDER.indexOf(config.stepId) : -1;

    STEP_ORDER.forEach((stepId, idx) => {
      const el = document.getElementById(stepId);
      if (!el) return;
      el.classList.remove('step-active', 'step-done', 'step-failed');
      el.removeAttribute('aria-current');

      if (state === 'Failed' || state === 'Cancelled') {
        if (idx < activeIndex) el.classList.add('step-done');
        // no active step on failure
      } else {
        if (idx < activeIndex)  { el.classList.add('step-done'); }
        if (idx === activeIndex) { el.classList.add('step-active'); el.setAttribute('aria-current', 'step'); }
      }
    });

    // Failed marker on last completed step
    if (state === 'Failed') {
      // find last done step and mark it red
      const lastEl = document.getElementById('step-Printing') || document.getElementById('step-Downloading');
      if (lastEl) lastEl.classList.add('step-failed');
    }

    // Message
    trackerMessage.textContent = config.msg;

    // Post-completion actions
    if (state === 'Completed') {
      printAnotherBtn.classList.remove('hidden');
    }
  }

  // "Print another document" button
  printAnotherBtn.addEventListener('click', () => {
    clearFile();
    copies = 1; copiesVal.textContent = 1;
    pageCount = 1; pageCountInput.value = 1;
    setColorMode(false);
    updatePrice();
    setPayBtnLoading(false);
    showScreen('upload');
    printAnotherBtn.classList.add('hidden');
  });

  // ============================================================
  //  INTERACTIVE DEMO / SHOPKEEPER SANDBOX LOGIC
  // ============================================================
  const btnRegisterShop        = document.getElementById('btnRegisterShop');
  const regShopName            = document.getElementById('regShopName');
  const regPrinterName         = document.getElementById('regPrinterName');
  const regShopUpi             = document.getElementById('regShopUpi');
  const dashUpiDisplay         = document.getElementById('dashUpiDisplay');
  const shopRegisterForm       = document.getElementById('shopRegisterForm');
  const shopDashboard          = document.getElementById('shopDashboard');
  const dashShopTitle          = document.getElementById('dashShopTitle');
  const dashPrinterTitle       = document.getElementById('dashPrinterTitle');
  const dashQrImg              = document.getElementById('dashQrImg');
  const dashQrTargetUrl        = document.getElementById('dashQrTargetUrl');
  const dashShopId             = document.getElementById('dashShopId');
  const dashPrinterId          = document.getElementById('dashPrinterId');
  const dashApiKey             = document.getElementById('dashApiKey');
  const btnCopyAgentConfig     = document.getElementById('btnCopyAgentConfig');
  const btnDownloadAgentExe    = document.getElementById('btnDownloadAgentExe');
  const btnDownloadAgentConfigFile = document.getElementById('btnDownloadAgentConfigFile');
  const btnOpenCustomerView    = document.getElementById('btnOpenCustomerView');
  const btnDownloadQr          = document.getElementById('btnDownloadQr');
  const btnSavePricing         = document.getElementById('btnSavePricing');
  const btnToggleSimulatedAgent = document.getElementById('btnToggleSimulatedAgent');
  const agentStatusText        = document.getElementById('agentStatusText');
  const liveQueueList          = document.getElementById('liveQueueList');
  const queueCountBadge        = document.getElementById('queueCountBadge');

  const rateBwSingle           = document.getElementById('rateBwSingle');
  const rateBwDuplex           = document.getElementById('rateBwDuplex');
  const rateColorSingle        = document.getElementById('rateColorSingle');
  const rateColorDuplex        = document.getElementById('rateColorDuplex');

  const statTodayRevenue       = document.getElementById('statTodayRevenue');
  const statTodayOrders        = document.getElementById('statTodayOrders');

  const calcOrdersRange        = document.getElementById('calcOrdersRange');
  const calcOrdersVal          = document.getElementById('calcOrdersVal');
  const calcRevenueText        = document.getElementById('calcRevenueText');

  let activeShopData           = null;
  let activePrinterData        = null;
  let isSimulatedAgentRunning  = false;
  let agentLoopTimer           = null;

  // Revenue Estimator Slider
  if (calcOrdersRange) {
    calcOrdersRange.addEventListener('input', (e) => {
      const orders = parseInt(e.target.value, 10);
      if (calcOrdersVal) calcOrdersVal.textContent = `${orders} orders/day`;
      const estMonthly = orders * 15 * 30; // ₹15 average order * 30 days
      if (calcRevenueText) calcRevenueText.textContent = `₹${estMonthly.toLocaleString()} / mo`;
    });
  }

  // Dashboard Tab Switching
  document.querySelectorAll('.dash-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dash-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dash-tab-pane').forEach(p => p.hidden = true);
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.hidden = false;
    });
  });

  if (btnRegisterShop) {
    btnRegisterShop.addEventListener('click', async () => {
      const shopName = regShopName.value.trim() || 'Speedy Print Shop';
      const printerName = regPrinterName.value.trim() || 'HP LaserJet Pro M404dn';
      const upiId = regShopUpi ? (regShopUpi.value.trim() || 'speedyprint@upi') : 'speedyprint@upi';

      btnRegisterShop.disabled = true;
      btnRegisterShop.textContent = 'Creating Shop...';

      try {
        const res = await fetch(`${API_BASE}/api/shops/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shopName,
            ownerEmail: 'owner@printshop.com',
            printerName,
            upiId,
          }),
        });

        const data = await res.json();
        if (res.ok && data.shop && data.printer) {
          activeShopData = data.shop;
          activePrinterData = data.printer;

          shopRegisterForm.hidden = true;
          shopDashboard.hidden = false;

          dashShopTitle.textContent = data.shop.name;
          dashPrinterTitle.textContent = data.printer.printerName;
          if (dashUpiDisplay) dashUpiDisplay.textContent = data.shop.upiId || upiId;
          dashQrImg.src = data.printer.qrCodeDataUrl;
          if (dashShopId) dashShopId.textContent = data.shop.id;
          if (dashPrinterId) dashPrinterId.textContent = data.printer.id;
          dashApiKey.textContent = data.printer.apiKey;
          dashQrTargetUrl.textContent = `${window.location.origin}/?printer=${data.printer.id}`;
          if (btnDownloadAgentExe) {
            btnDownloadAgentExe.href = `${API_BASE}/api/agent-installer`;
          }
          if (btnDownloadAgentConfigFile) {
            btnDownloadAgentConfigFile.href = `${API_BASE}/api/printers/${data.printer.id}/agent-config`;
          }

          if (btnCopyAgentConfig) {
            btnCopyAgentConfig.onclick = () => {
              const configJson = JSON.stringify({
                PrintOkApiUrl: API_BASE,
                ShopId: data.shop.id,
                PrinterId: data.printer.id,
                AgentApiKey: data.printer.apiKey,
                HeartbeatIntervalSeconds: 30
              }, null, 2);

              navigator.clipboard.writeText(configJson).then(() => {
                showToast('success', 'Config Copied!', 'appsettings.json configuration copied to clipboard.');
              }).catch(() => {
                showToast('info', 'Agent Settings', `ShopId: ${data.shop.id}\nPrinterId: ${data.printer.id}\nApiKey: ${data.printer.apiKey}`);
              });
            };
          }

          showToast('success', 'Shop Registered!', `Printer ID: ${data.printer.id}`);

          btnOpenCustomerView.onclick = () => {
            window.location.href = `/?printer=${data.printer.id}`;
          };

          // QR Download Helper
          if (btnDownloadQr) {
            btnDownloadQr.onclick = () => {
              const a = document.createElement('a');
              a.href = data.printer.qrCodeDataUrl;
              a.download = `PrintOk_QR_${data.shop.name.replace(/\s+/g, '_')}.png`;
              a.click();
              showToast('info', 'QR Sign Downloaded', 'Print and display this QR card at your shop counter.');
            };
          }

          // Auto-start simulated agent
          startSimulatedAgent();
          fetchShopStats();
        } else {
          showToast('danger', 'Registration Failed', data.error || 'Could not register shop.');
          btnRegisterShop.disabled = false;
          btnRegisterShop.textContent = '✨ Register Shop & Generate QR Code';
        }
      } catch (err) {
        showToast('danger', 'Network Error', 'Could not reach server.');
        btnRegisterShop.disabled = false;
        btnRegisterShop.textContent = '✨ Register Shop & Generate QR Code';
      }
    });
  }

  // Save Pricing Matrix
  if (btnSavePricing) {
    btnSavePricing.addEventListener('click', async () => {
      if (!activeShopData) return;
      try {
        const res = await fetch(`${API_BASE}/api/shops/${activeShopData.id}/pricing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bwSinglePerPageCents: Math.round(parseFloat(rateBwSingle.value) * 100),
            bwDuplexPerPageCents: Math.round(parseFloat(rateBwDuplex.value) * 100),
            colorSinglePerPageCents: Math.round(parseFloat(rateColorSingle.value) * 100),
            colorDuplexPerPageCents: Math.round(parseFloat(rateColorDuplex.value) * 100),
          }),
        });

        if (res.ok) {
          showToast('success', 'Rates Saved!', 'Custom pricing matrix updated for all customer uploads.');
        }
      } catch {
        showToast('danger', 'Error', 'Could not update shop pricing matrix.');
      }
    });
  }

  async function fetchShopStats() {
    if (!activeShopData) return;
    try {
      const res = await fetch(`${API_BASE}/api/shops/${activeShopData.id}/stats`);
      if (res.ok) {
        const data = await res.json();
        if (statTodayRevenue) statTodayRevenue.textContent = `₹${(data.stats.todayRevenueCents / 100).toFixed(2)}`;
        if (statTodayOrders) statTodayOrders.textContent = String(data.stats.todayJobsCount);
      }
    } catch {
      // ignore transient error
    }
  }

  if (btnToggleSimulatedAgent) {
    btnToggleSimulatedAgent.addEventListener('click', () => {
      if (isSimulatedAgentRunning) {
        stopSimulatedAgent();
      } else {
        startSimulatedAgent();
      }
    });
  }

  function startSimulatedAgent() {
    if (isSimulatedAgentRunning || !activePrinterData) return;
    isSimulatedAgentRunning = true;
    btnToggleSimulatedAgent.textContent = '⏸️ Pause Simulated Windows Agent';
    btnToggleSimulatedAgent.className = 'btn btn-danger btn-full btn-sm';
    agentStatusText.textContent = 'Agent status: 🟢 ONLINE & POLLING (Every 2s)';
    agentStatusText.style.color = 'var(--color-success)';

    showToast('info', 'Windows Agent Online', 'Polling server for print jobs...');
    pollAndProcessJobs();
    agentLoopTimer = setInterval(pollAndProcessJobs, 2000);
  }

  function stopSimulatedAgent() {
    isSimulatedAgentRunning = false;
    if (agentLoopTimer) clearInterval(agentLoopTimer);
    btnToggleSimulatedAgent.textContent = '▶️ Start Simulated Windows Agent';
    btnToggleSimulatedAgent.className = 'btn btn-outline btn-full btn-sm';
    agentStatusText.textContent = 'Agent status: 🔴 OFFLINE';
    agentStatusText.style.color = 'var(--color-danger)';
    showToast('warning', 'Agent Stopped', 'Windows Print Agent turned off.');
  }

  async function pollAndProcessJobs() {
    if (!activePrinterData) return;
    try {
      const res = await fetch(`${API_BASE}/api/agent/jobs/pending`, {
        headers: { 'x-agent-api-key': activePrinterData.apiKey },
      });

      if (!res.ok) return;
      const data = await res.json();
      const jobs = data.jobs || [];

      updateShopQueueUI(jobs);
      fetchShopStats();

      for (const job of jobs) {
        showToast('info', '🖨️ Agent Picked Up Job', `Downloading & Spooling Token ${job.tokenNumber || ''} (${job.fileName})...`);

        // Update to Printing
        await fetch(`${API_BASE}/api/agent/jobs/${job.id}/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-agent-api-key': activePrinterData.apiKey,
          },
          body: JSON.stringify({ printState: 'Printing' }),
        });

        await new Promise(r => setTimeout(r, 1200));

        // Update to Completed
        await fetch(`${API_BASE}/api/agent/jobs/${job.id}/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-agent-api-key': activePrinterData.apiKey,
          },
          body: JSON.stringify({ printState: 'Completed' }),
        });

        showToast('success', '🎉 Printed Successfully!', `Token ${job.tokenNumber || ''} delivered to tray.`);
      }
    } catch {
      // ignore transient errors
    }
  }

  function updateShopQueueUI(jobs) {
    if (!liveQueueList) return;
    queueCountBadge.textContent = `${jobs.length} Active Job(s)`;

    if (jobs.length === 0) {
      liveQueueList.innerHTML = `<div class="meta-text" style="text-align: center; padding: 12px; background: var(--color-surface); border: 1px dashed var(--color-border-muted); border-radius: 6px;">No pending jobs in queue. Tap 'Customer View' to submit!</div>`;
      return;
    }

    liveQueueList.innerHTML = jobs.map(j => `
      <div style="background: var(--color-surface); border: var(--border); border-radius: 6px; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <div style="font-family: var(--font-display); font-size: 13px; font-weight: 800; color: var(--color-primary);">Token ${j.tokenNumber || '#---'}</div>
          <div style="font-family: var(--font-display); font-size: 12px; font-weight: 700;">📄 ${escapeHtml(j.fileName)}</div>
          <div class="meta-text" style="font-size: 10px;">${j.pageCount} pg • ${j.copies} copy • ${j.isColor ? 'Color' : 'B&W'} • ₹${(j.totalPriceInCents/100).toFixed(2)}</div>
        </div>
        <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-end;">
          <span class="badge badge-printing">${j.printState}</span>
          <button class="btn btn-primary btn-sm btn-override-cash" data-jobid="${j.id}" type="button" style="padding:2px 6px; font-size:10px;">⚡ Cash Approve</button>
        </div>
      </div>
    `).join('');

    // Attach Cash Manual Override listeners
    document.querySelectorAll('.btn-override-cash').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const jobId = e.target.getAttribute('data-jobid');
        if (!jobId) return;
        try {
          const res = await fetch(`${API_BASE}/api/print-jobs/${jobId}/manual-override`, { method: 'POST' });
          if (res.ok) {
            showToast('success', 'Cash Approved!', 'Job queued for immediate auto-print.');
            pollAndProcessJobs();
          }
        } catch {
          showToast('danger', 'Error', 'Could not approve job.');
        }
      });
    });
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  }

});


