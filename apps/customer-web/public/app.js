/**
 * PrintOk Customer Mobile Web Client
 * Milestone 4 — Neo-Brutalist UX Redesign
 */

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = 'http://localhost:4000';

  // ============================================================
  //  STATE
  // ============================================================
  let selectedFile = null;
  let fileBase64 = null;
  let isColor = false;
  let copies = 1;
  let pageCount = 1;
  let currentPrinterId = null;
  let pollingTimer = null;

  // ============================================================
  //  DOM REFS
  // ============================================================
  const screenLanding        = document.getElementById('screenLanding');
  const screenUpload         = document.getElementById('screenUpload');
  const actionBar            = document.getElementById('actionBar');
  const trackerSection       = document.getElementById('trackerSection');

  const shopNameDisplay      = document.getElementById('shopNameDisplay');
  const shopNameSkeleton     = document.getElementById('shopNameSkeleton');

  const dropZone             = document.getElementById('dropZone');
  const fileInput            = document.getElementById('fileInput');
  const fileSelectedDisplay  = document.getElementById('fileSelectedDisplay');
  const fileNameText         = document.getElementById('fileNameText');
  const fileSizeText         = document.getElementById('fileSizeText');
  const removeFileBtn        = document.getElementById('removeFileBtn');
  const fileError            = document.getElementById('fileError');

  const bwBtn                = document.getElementById('bwBtn');
  const colorBtn             = document.getElementById('colorBtn');
  const minusCopyBtn         = document.getElementById('minusCopyBtn');
  const plusCopyBtn          = document.getElementById('plusCopyBtn');
  const copiesVal            = document.getElementById('copiesVal');
  const pageCountInput       = document.getElementById('pageCountInput');
  const totalPriceText       = document.getElementById('totalPriceText');
  const payPrintBtn          = document.getElementById('payPrintBtn');

  const statusBadge          = document.getElementById('statusBadge');
  const progressFill         = document.getElementById('progressFill');
  const progressBar          = document.getElementById('progressBar');
  const trackerMessage       = document.getElementById('trackerMessage');
  const printAnotherBtn      = document.getElementById('printAnotherBtn');

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
    const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
    if (!isPdf) {
      showFileError('Only PDF documents are accepted. Please choose a .pdf file.');
      dropZone.classList.add('has-error');
      return;
    }

    // Validate size (25 MB)
    const maxBytes = 25 * 1024 * 1024;
    if (file.size > maxBytes) {
      showFileError(`This file is ${formatSize(file.size)} — the limit is 25 MB. Please compress or split the PDF.`);
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
  //  COLOR MODE
  // ============================================================
  bwBtn.addEventListener('click', () => setColorMode(false));
  colorBtn.addEventListener('click', () => setColorMode(true));

  function setColorMode(color) {
    isColor = color;
    bwBtn.classList.toggle('active', !color);
    bwBtn.setAttribute('aria-pressed', String(!color));
    colorBtn.classList.toggle('active', color);
    colorBtn.setAttribute('aria-pressed', String(color));
    updatePrice();
  }

  // ============================================================
  //  COPIES
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
    const pricePerPage = isColor ? 10.00 : 2.00;
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
        }),
      });

      const data = await res.json();

      if (res.ok && data.job) {
        showScreen('tracker');
        startJobTracking(data.job.id);
        showToast('success', 'Job submitted!', 'Your document is on its way to the printer.');
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

});
