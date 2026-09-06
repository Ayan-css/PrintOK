/**
 * PrintOk Customer Mobile Web Client Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = 'http://localhost:4000';

  // State Variables
  let selectedFile = null;
  let fileBase64 = null;
  let isColor = false;
  let copies = 1;
  let pageCount = 1;
  let currentPrinterId = null;

  // DOM Elements
  const shopNameDisplay = document.getElementById('shopNameDisplay');
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const filePill = document.getElementById('filePill');
  const fileNameText = document.getElementById('fileNameText');
  const removeFileBtn = document.getElementById('removeFileBtn');
  const bwBtn = document.getElementById('bwBtn');
  const colorBtn = document.getElementById('colorBtn');
  const minusCopyBtn = document.getElementById('minusCopyBtn');
  const plusCopyBtn = document.getElementById('plusCopyBtn');
  const copiesVal = document.getElementById('copiesVal');
  const pageCountInput = document.getElementById('pageCountInput');
  const totalPriceText = document.getElementById('totalPriceText');
  const payPrintBtn = document.getElementById('payPrintBtn');
  const trackerSection = document.getElementById('trackerSection');
  const statusBadge = document.getElementById('statusBadge');
  const progressFill = document.getElementById('progressFill');
  const trackerDesc = document.getElementById('trackerDesc');

  // Extract Printer ID / Shop ID from URL query or path
  const pathParts = window.location.pathname.split('/');
  const urlParams = new URLSearchParams(window.location.search);
  currentPrinterId = urlParams.get('printer') || (pathParts[2] ? pathParts[2] : null);

  // Initialize Shop Metadata
  fetchShopInfo();

  async function fetchShopInfo() {
    if (!currentPrinterId) {
      shopNameDisplay.textContent = 'Demo Print Shop';
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/printers/${currentPrinterId}`);
      if (res.ok) {
        const data = await res.json();
        shopNameDisplay.textContent = data.shop ? data.shop.name : 'PrintOk Shop';
      } else {
        shopNameDisplay.textContent = 'PrintOk Partner Shop';
      }
    } catch (err) {
      shopNameDisplay.textContent = 'PrintOk Partner Shop';
    }
  }

  // File Selection
  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  removeFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedFile = null;
    fileBase64 = null;
    filePill.classList.add('hidden');
    payPrintBtn.disabled = true;
  });

  function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      alert('Please select a valid PDF document.');
      return;
    }

    selectedFile = file;
    fileNameText.textContent = file.name;
    filePill.classList.remove('hidden');

    const reader = new FileReader();
    reader.onload = () => {
      fileBase64 = reader.result.split(',')[1];
      payPrintBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  // Color Mode Toggle
  bwBtn.addEventListener('click', () => {
    isColor = false;
    bwBtn.classList.add('active');
    colorBtn.classList.remove('active');
    updatePrice();
  });

  colorBtn.addEventListener('click', () => {
    isColor = true;
    colorBtn.classList.add('active');
    bwBtn.classList.remove('active');
    updatePrice();
  });

  // Copies Counter
  minusCopyBtn.addEventListener('click', () => {
    if (copies > 1) {
      copies--;
      copiesVal.textContent = copies;
      updatePrice();
    }
  });

  plusCopyBtn.addEventListener('click', () => {
    copies++;
    copiesVal.textContent = copies;
    updatePrice();
  });

  pageCountInput.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    pageCount = val > 0 ? val : 1;
    updatePrice();
  });

  function updatePrice() {
    const pricePerPage = isColor ? 10.00 : 2.00;
    const total = pricePerPage * pageCount * copies;
    totalPriceText.textContent = `₹${total.toFixed(2)}`;
  }

  // Pay & Print Action
  payPrintBtn.addEventListener('click', async () => {
    if (!fileBase64) return;

    payPrintBtn.disabled = true;
    payPrintBtn.innerHTML = '<span>Processing...</span>';

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
      if (res.ok) {
        startJobTracking(data.job.id);
      } else {
        alert(`Error: ${data.error || 'Failed to submit job.'}`);
        payPrintBtn.disabled = false;
        payPrintBtn.innerHTML = '<span>Pay & Print Now</span><span class="arrow">→</span>';
      }
    } catch (err) {
      alert('Network error contacting PrintOk API server.');
      payPrintBtn.disabled = false;
      payPrintBtn.innerHTML = '<span>Pay & Print Now</span><span class="arrow">→</span>';
    }
  });

  // Live Job Status Polling
  function startJobTracking(jobId) {
    trackerSection.classList.remove('hidden');
    trackerSection.scrollIntoView({ behavior: 'smooth' });

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/print-jobs/${jobId}`);
        if (res.ok) {
          const data = await res.json();
          const state = data.job.printState;
          updateTrackerUI(state);

          if (state === 'Completed' || state === 'Failed') {
            clearInterval(pollInterval);
          }
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1000);
  }

  function updateTrackerUI(state) {
    statusBadge.textContent = state;

    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const step3 = document.getElementById('step3');
    const step4 = document.getElementById('step4');

    step1.classList.remove('active');
    step2.classList.remove('active');
    step3.classList.remove('active');
    step4.classList.remove('active');

    switch (state) {
      case 'Queued':
        progressFill.style.width = '25%';
        step1.classList.add('active');
        trackerDesc.textContent = 'Print job created and queued for shop printer...';
        break;
      case 'Downloading':
        progressFill.style.width = '50%';
        step1.classList.add('active');
        step2.classList.add('active');
        trackerDesc.textContent = 'Shop Windows Print Agent is downloading PDF payload...';
        break;
      case 'Printing':
        progressFill.style.width = '75%';
        step1.classList.add('active');
        step2.classList.add('active');
        step3.classList.add('active');
        trackerDesc.textContent = 'Document is spooling to physical printer...';
        break;
      case 'Completed':
        progressFill.style.width = '100%';
        progressFill.style.background = '#10b981';
        step1.classList.add('active');
        step2.classList.add('active');
        step3.classList.add('active');
        step4.classList.add('active');
        statusBadge.style.background = 'rgba(16, 185, 129, 0.2)';
        statusBadge.style.color = '#34d399';
        trackerDesc.textContent = '✨ Print complete! Collect your paper from the tray.';
        break;
      case 'Failed':
        progressFill.style.width = '100%';
        progressFill.style.background = '#ef4444';
        statusBadge.style.background = 'rgba(239, 68, 68, 0.2)';
        statusBadge.style.color = '#f87171';
        trackerDesc.textContent = '❌ Printing failed. Please notify shop counter.';
        break;
    }
  }
});
