/**
 * PrintOk Web Application Client
 * Multi-page support, Document Preview, Automatic Page Detection, Custom Page Ranges & Redirects.
 */

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://prinok-api.onrender.com';

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

  // Detect current page route
  const pathname = window.location.pathname.toLowerCase();
  const isRegisterPage = pathname.includes('/register') || pathname.includes('/registration') || pathname.includes('register.html');
  const isDashboardPage = pathname.includes('/dashboard') || pathname.includes('dashboard.html');

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
    toast.innerHTML = `
      <div class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</div>
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        ${message ? `<div class="toast-msg">${message}</div>` : ''}
      </div>
      <button class="toast-close" type="button">&times;</button>
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
  //  1. SHOP REGISTRATION DRIVER (/register, /registration, register.html)
  // ============================================================
  if (isRegisterPage) {
    const btnNextStep1 = document.getElementById('btnNextStep1');
    const btnPrevStep2 = document.getElementById('btnPrevStep2');
    const btnSubmitRegister = document.getElementById('btnSubmitRegister');

    const formStep1 = document.getElementById('formStep1');
    const formStep2 = document.getElementById('formStep2');
    const formStep3 = document.getElementById('formStep3');

    const stepNav1 = document.getElementById('stepNav1');
    const stepNav2 = document.getElementById('stepNav2');
    const stepNav3 = document.getElementById('stepNav3');

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

    if (btnSubmitRegister) {
      btnSubmitRegister.addEventListener('click', async () => {
        const shopName = document.getElementById('regShopName').value.trim();
        const ownerEmail = document.getElementById('regOwnerEmail').value.trim();
        const printerName = document.getElementById('regPrinterName').value.trim();
        const upiId = document.getElementById('regUpiId').value.trim();

        btnSubmitRegister.disabled = true;
        btnSubmitRegister.textContent = 'Registering Shop...';

        try {
          const res = await fetch(`${API_BASE}/api/shops/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shopName, ownerEmail, printerName, upiId }),
          });

          const data = await res.json();
          if (res.ok && data.shop && data.printer) {
            formStep2.hidden = true;
            formStep3.hidden = false;
            stepNav2.classList.remove('active');
            stepNav3.classList.add('active');

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

            const btnDownloadPosterPng = document.getElementById('btnDownloadPosterPng');
            if (btnDownloadPosterPng) {
              btnDownloadPosterPng.onclick = () => {
                const a = document.createElement('a');
                a.href = data.printer.qrCodeDataUrl;
                a.download = `PrintOk_QR_${data.shop.name.replace(/\s+/g, '_')}.png`;
                a.click();
                showToast('info', 'QR Sign Downloaded', 'Print and place at shop counter.');
              };
            }

            showToast('success', 'Shop Registered!', `Printer ID: ${data.printer.id}`);
          } else {
            showToast('danger', 'Error', data.error || 'Could not register shop.');
            btnSubmitRegister.disabled = false;
            btnSubmitRegister.textContent = '✨ Register Shop & Get QR';
          }
        } catch {
          showToast('danger', 'Network Error', 'Could not connect to API server.');
          btnSubmitRegister.disabled = false;
          btnSubmitRegister.textContent = '✨ Register Shop & Get QR';
        }
      });
    }
  }

  // ============================================================
  //  2. MERCHANT DASHBOARD DRIVER (/dashboard, dashboard.html)
  // ============================================================
  if (isDashboardPage) {
    const tabBtns = document.querySelectorAll('.dash-tab-btn');
    const tabPanes = document.querySelectorAll('.dash-tab-pane');

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');
        tabBtns.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => { p.hidden = true; p.classList.remove('active'); });

        btn.classList.add('active');
        const targetPane = document.getElementById(tabId);
        if (targetPane) {
          targetPane.hidden = false;
          targetPane.classList.add('active');
        }
      });
    });

    loadDashboardMetrics();
    const btnRefreshQueue = document.getElementById('btnRefreshQueue');
    if (btnRefreshQueue) {
      btnRefreshQueue.addEventListener('click', () => {
        loadDashboardMetrics();
        showToast('info', 'Refreshed', 'Queue metrics updated.');
      });
    }
  }

  async function loadDashboardMetrics() {
    try {
      const res = await fetch(`${API_BASE}/api/shops/shop_test/stats`);
      if (res.ok) {
        const data = await res.json();
        const rev = document.getElementById('statTodayRevenue');
        if (rev) rev.textContent = `₹${((data.stats?.todayRevenueCents || 0) / 100).toFixed(2)}`;
        const queued = document.getElementById('statQueuedCount');
        if (queued) queued.textContent = String(data.stats?.queuedJobsCount || 0);
        const printed = document.getElementById('statPrintedPages');
        if (printed) printed.textContent = String(data.stats?.printedPagesCount || 0);
      }
    } catch {
      // ignore
    }
  }

  // ============================================================
  //  3. CUSTOMER MOBILE PRINTING DRIVER (index.html / ?printer=)
  // ============================================================
  if (!isRegisterPage && !isDashboardPage) {
    const urlParams = new URLSearchParams(window.location.search);
    const pathParts = window.location.pathname.split('/');
    currentPrinterId = urlParams.get('printer') || (pathParts[2] || null);

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
    const previewImg = document.getElementById('previewImg');
    const previewFallback = document.getElementById('previewFallback');
    const previewFallbackText = document.getElementById('previewFallbackText');

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());
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
        selectedFile = null;
        fileBase64 = null;
        if (fileInfoBox) fileInfoBox.hidden = true;
        if (documentPreviewBox) documentPreviewBox.hidden = true;
        if (configSection) configSection.hidden = true;
        if (dropZone) dropZone.hidden = false;
      });
    }

    async function handleCustomerFile(file) {
      selectedFile = file;
      if (infoFileName) infoFileName.textContent = file.name;
      if (infoFileMeta) infoFileMeta.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB • Detecting pages...`;

      if (fileInfoBox) fileInfoBox.hidden = false;
      if (documentPreviewBox) documentPreviewBox.hidden = false;
      if (configSection) configSection.hidden = false;
      if (dropZone) dropZone.hidden = true;

      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      
      // Auto-detect page count for PDFs
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        detectedTotalPages = detectPdfPages(bytes);
        if (previewImg) previewImg.hidden = true;
        if (previewFallback) previewFallback.hidden = false;
        if (previewFallbackText) previewFallbackText.textContent = `📄 PDF Document (${detectedTotalPages} ${detectedTotalPages === 1 ? 'Page' : 'Pages'})`;
      } else if (file.type.startsWith('image/')) {
        detectedTotalPages = 1;
        const dataUrl = URL.createObjectURL(file);
        if (previewImg) {
          previewImg.src = dataUrl;
          previewImg.hidden = false;
        }
        if (previewFallback) previewFallback.hidden = true;
      } else {
        detectedTotalPages = 1;
        if (previewImg) previewImg.hidden = true;
        if (previewFallback) previewFallback.hidden = false;
        if (previewFallbackText) previewFallbackText.textContent = `📄 ${file.name}`;
      }

      if (infoFileMeta) {
        infoFileMeta.textContent = `${detectedTotalPages} ${detectedTotalPages === 1 ? 'page' : 'pages'} • ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
      }

      const allPagesCountBadge = document.getElementById('allPagesCountBadge');
      if (allPagesCountBadge) allPagesCountBadge.textContent = String(detectedTotalPages);

      pageCount = detectedTotalPages;

      const reader = new FileReader();
      reader.onload = () => {
        fileBase64 = reader.result.split(',')[1];
      };
      reader.readAsDataURL(file);

      updateCustomerPrice();
    }

    // Page selection range handlers
    const pillPagesAll = document.getElementById('pillPagesAll');
    const pillPagesCustom = document.getElementById('pillPagesCustom');
    const customPageRangeBox = document.getElementById('customPageRangeBox');
    const inputCustomPageRange = document.getElementById('inputCustomPageRange');

    if (pillPagesAll && pillPagesCustom) {
      pillPagesAll.addEventListener('click', () => {
        pageRangeMode = 'all';
        pillPagesAll.classList.add('active');
        pillPagesCustom.classList.remove('active');
        if (customPageRangeBox) customPageRangeBox.hidden = true;
        pageCount = detectedTotalPages;
        updateCustomerPrice();
      });

      pillPagesCustom.addEventListener('click', () => {
        pageRangeMode = 'custom';
        pillPagesCustom.classList.add('active');
        pillPagesAll.classList.remove('active');
        if (customPageRangeBox) customPageRangeBox.hidden = false;
        recalculateCustomPageCount();
      });
    }

    if (inputCustomPageRange) {
      inputCustomPageRange.addEventListener('input', () => {
        recalculateCustomPageCount();
      });
    }

    function recalculateCustomPageCount() {
      if (!inputCustomPageRange) return;
      const rangeStr = inputCustomPageRange.value.trim();
      if (!rangeStr) {
        pageCount = detectedTotalPages;
      } else {
        pageCount = parseCustomPageRange(rangeStr, detectedTotalPages);
      }
      updateCustomerPrice();
    }

    // Option pills
    const pillBw = document.getElementById('pillBw');
    const pillColor = document.getElementById('pillColor');
    const pillSingle = document.getElementById('pillSingle');
    const pillDuplex = document.getElementById('pillDuplex');

    if (pillBw && pillColor) {
      pillBw.addEventListener('click', () => {
        isColor = false;
        pillBw.classList.add('active');
        pillColor.classList.remove('active');
        updateCustomerPrice();
      });

      pillColor.addEventListener('click', () => {
        isColor = true;
        pillColor.classList.add('active');
        pillBw.classList.remove('active');
        updateCustomerPrice();
      });
    }

    if (pillSingle && pillDuplex) {
      pillSingle.addEventListener('click', () => {
        isDuplex = false;
        pillSingle.classList.add('active');
        pillDuplex.classList.remove('active');
        updateCustomerPrice();
      });

      pillDuplex.addEventListener('click', () => {
        isDuplex = true;
        pillDuplex.classList.add('active');
        pillSingle.classList.remove('active');
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

    function updateCustomerPrice() {
      let rate = isColor ? (isDuplex ? 8.00 : 10.00) : (isDuplex ? 1.50 : 2.00);
      const total = rate * pageCount * copies;
      const totalCostDisplay = document.getElementById('totalCostDisplay');
      const costBreakdownText = document.getElementById('costBreakdownText');

      if (totalCostDisplay) totalCostDisplay.textContent = `₹${total.toFixed(2)}`;
      if (costBreakdownText) {
        costBreakdownText.textContent = `${pageCount} ${pageCount === 1 ? 'page' : 'pages'} × ₹${rate.toFixed(2)} (${isColor ? 'Color' : 'B&W'} ${isDuplex ? 'Duplex' : 'Single'})`;
      }
    }

    // Payment submissions
    const btnPayCash = document.getElementById('btnPayCash');
    const btnPayRazorpay = document.getElementById('btnPayRazorpay');

    if (btnPayCash) {
      btnPayCash.addEventListener('click', () => submitCustomerPrintJob(true));
    }
    if (btnPayRazorpay) {
      btnPayRazorpay.addEventListener('click', () => submitCustomerPrintJob(false));
    }

    async function submitCustomerPrintJob(autoApprove) {
      if (!selectedFile || !fileBase64) {
        showToast('warning', 'No File', 'Please select a document to print.');
        return;
      }

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
          }),
        });

        const data = await res.json();
        if (res.ok && data.job) {
          if (screenCustomer) screenCustomer.hidden = true;
          if (screenStatus) screenStatus.hidden = false;

          document.getElementById('statusTokenNumber').textContent = `Token ${data.job.tokenNumber || '#001'}`;
          document.getElementById('stFileName').textContent = data.job.fileName;
          document.getElementById('stPageCopy').textContent = `${data.job.pageCount} page(s), ${data.job.copies} copy`;
          document.getElementById('stAmount').textContent = `₹${(data.job.totalPriceInCents / 100).toFixed(2)}`;

          showToast('success', 'Job Submitted!', `Token ${data.job.tokenNumber || '#001'} queued for printing.`);
          startPollingJobStatus(data.job.id);
        } else {
          showToast('danger', 'Submission Error', data.error || 'Could not create print job.');
        }
      } catch {
        showToast('danger', 'Network Failure', 'Failed to submit print job.');
      }
    }

    const btnNewPrintJob = document.getElementById('btnNewPrintJob');
    if (btnNewPrintJob) {
      btnNewPrintJob.addEventListener('click', () => window.location.reload());
    }

    const btnCopyToken = document.getElementById('btnCopyToken');
    if (btnCopyToken) {
      btnCopyToken.addEventListener('click', () => {
        const tok = document.getElementById('statusTokenNumber').textContent;
        navigator.clipboard.writeText(tok);
        showToast('info', 'Copied!', `${tok} copied to clipboard.`);
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
      const res = await fetch(`${API_BASE}/api/printers/${printerId}`);
      if (res.ok) {
        const data = await res.json();
        const shopNameDisplay = document.getElementById('shopNameDisplay');
        if (shopNameDisplay) shopNameDisplay.textContent = data.shop ? data.shop.name : 'PrintOk Shop';
      }
    } catch {
      // ignore
    }
  }

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

  function startPollingJobStatus(jobId) {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/print-jobs/${jobId}`);
        if (res.ok) {
          const data = await res.json();
          const job = data.job;
          const badge = document.getElementById('statusBadgeState');
          if (badge) badge.textContent = job.printState;

          if (job.printState === 'Completed') {
            clearInterval(pollingTimer);
            showToast('success', '🎉 Printing Completed!', 'Your document has been printed at the counter.');
          }
        }
      } catch {
        // ignore
      }
    }, 2500);
  }
});
