/**
 * Business Setup.
 *
 * Six tabs over one save. A shop configures what it offers, what it charges,
 * what it discounts and what it asks customers for, then saves the lot — rather
 * than six screens that each save themselves and leave the shop half-configured
 * with no way to tell which half took.
 *
 * Nothing is written until Save. Every edit goes into `draft`, the button
 * enables when `draft` differs from what was loaded, and the page warns before
 * a navigation that would discard it.
 */
(function () {
  'use strict';

  const API_BASE = (function () {
    // Same rule as the dashboard: same-origin in development, the deployed API
    // otherwise. A relative path would hit Vercel, which serves no API.
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:4000';
    return 'https://prinok-api.onrender.com';
  })();

  const SESSION_KEY = 'printok.merchantToken';
  const CONTEXT_KEY = 'printok.shopContext';

  let shopId = null;
  let catalogue = { capabilities: [], groups: [], defaults: [] };

  /** What was loaded, and what the shop has changed. Compared to detect edits. */
  let saved = null;
  let draft = null;

  // ------------------------------------------------------------------ utils ---

  function token() {
    try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
  }

  function readShopId() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('shop')) return params.get('shop');
    try {
      const ctx = JSON.parse(localStorage.getItem(CONTEXT_KEY) || '{}');
      return ctx.shopId || null;
    } catch {
      return null;
    }
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    return fetch(`${API_BASE}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  }

  function toast(type, title, message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<div class="toast-title"></div><div class="toast-message"></div>`;
    el.querySelector('.toast-title').textContent = title;
    el.querySelector('.toast-message').textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /** Paise to a rupee string for an input, blank for "no value". */
  const toRupees = (cents) => (cents === null || cents === undefined ? '' : (cents / 100).toString());

  /**
   * Rupees typed by a person to whole paise.
   *
   * Returns undefined for blank (meaning "no discount here") and null for
   * anything that is not a number, so a typo is refused rather than silently
   * becoming zero — a rate of zero is a shop giving printing away.
   */
  function toPaise(value) {
    const text = String(value ?? '').trim();
    if (!text) return undefined;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }

  // ------------------------------------------------------------------ dirty ---

  function isDirty() {
    return JSON.stringify(saved) !== JSON.stringify(draft);
  }

  function refreshSaveButton() {
    const btn = document.getElementById('btnSaveAll');
    if (btn) btn.disabled = !isDirty();
    refreshValidity();
    renderPreview();
  }

  window.addEventListener('beforeunload', (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // --------------------------------------------------------------- validity ---

  /**
   * Per-tab validity, shown on the tab itself.
   *
   * The point is that an incomplete tab is visible without opening it — the
   * competitor's setup screen does this and it is the reason a shop notices it
   * has no rates before a customer does.
   */
  function tabProblems() {
    const problems = {};

    const noRate = draft.rates.some((r) => r.enabled && (r.perPageCents === null || r.perPageCents === undefined));
    if (noRate) problems.tabRates = 'A configuration you offer has no rate';

    const services = draft.portal.enabledServices || [];
    if (!services.includes('bw') && !services.includes('colour')) {
      problems.tabProfile = 'Offer at least black & white or colour';
    }
    if (!services.some((k) => k.startsWith('paper-') || k.startsWith('photo-'))) {
      problems.tabProfile = 'Offer at least one paper size';
    }

    if (draft.card.bulkEnabled && !(draft.card.bulkThresholdCents > 0)) {
      problems.tabDiscounts = 'Set the amount the discount starts at';
    }

    // Required without asked is unsatisfiable — the field would never show and
    // every order would then be refused for missing it.
    const p = draft.portal;
    if ((p.customerNameRequired && !p.collectCustomerName) ||
        (p.customerPhoneRequired && !p.collectCustomerPhone)) {
      problems.tabPortal = 'A field cannot be required unless it is asked for';
    }

    return problems;
  }

  function refreshValidity() {
    const problems = tabProblems();

    document.querySelectorAll('.setup-tab-chip').forEach((chip) => {
      const tab = chip.getAttribute('data-chip');
      const bad = problems[tab];
      chip.textContent = bad ? '!' : '✓';
      chip.className = `setup-tab-chip ${bad ? 'is-invalid' : 'is-valid'}`;
      chip.title = bad || 'Looks complete';
    });

    const badge = document.getElementById('setupValidity');
    const count = Object.keys(problems).length;
    if (badge) {
      badge.textContent = count === 0 ? 'Ready' : `${count} to fix`;
      badge.className = `badge ${count === 0 ? 'badge-success' : 'badge-warning'}`;
    }

    return problems;
  }

  // --------------------------------------------------------------- services ---

  function renderServices() {
    const host = document.getElementById('serviceGroups');
    if (!host) return;

    const enabled = new Set(draft.portal.enabledServices || []);

    host.innerHTML = catalogue.groups.map((group) => {
      const items = catalogue.capabilities.filter((c) => c.group === group.id);
      if (items.length === 0) return '';

      const rows = items.map((c) => `
        <label class="service-item ${enabled.has(c.key) ? 'is-on' : ''}">
          <input type="checkbox" data-service="${escapeHtml(c.key)}" ${enabled.has(c.key) ? 'checked' : ''}>
          <span>
            <span class="service-label">${escapeHtml(c.label)}</span>
            ${c.hint ? `<span class="service-hint">${escapeHtml(c.hint)}</span>` : ''}
          </span>
        </label>`).join('');

      return `
        <section class="service-group">
          <h3 class="service-group-title">${escapeHtml(group.label)}</h3>
          <p class="service-group-blurb">${escapeHtml(group.blurb)}</p>
          <div class="service-grid">${rows}</div>
        </section>`;
    }).join('');

    host.querySelectorAll('input[data-service]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.getAttribute('data-service');
        const list = draft.portal.enabledServices.filter((k) => k !== key);

        if (input.checked) {
          // Re-inserted in catalogue order rather than appended, so the list a
          // shop sees does not reshuffle every time something is toggled.
          const order = catalogue.capabilities.map((c) => c.key);
          list.push(key);
          list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        }

        draft.portal.enabledServices = list;
        input.closest('.service-item').classList.toggle('is-on', input.checked);
        refreshSaveButton();
      });
    });
  }

  // ------------------------------------------------------------------ rates ---

  const rateKey = (r) => `${r.paperSize}|${r.isColor}|${r.isDuplex}`;

  function renderRates() {
    const body = document.getElementById('rateGridBody');
    if (!body) return;

    body.innerHTML = draft.rates.map((r) => `
      <tr data-rate="${escapeHtml(rateKey(r))}">
        <td>${escapeHtml(r.paperSize)}</td>
        <td>${r.isColor ? 'Colour' : 'B&amp;W'}</td>
        <td>${r.isDuplex ? 'Back-to-back' : 'Single'}</td>
        <td class="num"><input type="number" class="form-input rate-input" data-field="perPageCents"
                               min="0" step="0.01" value="${escapeHtml(toRupees(r.perPageCents))}"></td>
        <td class="num"><input type="number" class="form-input rate-input" data-field="bulkPerPageCents"
                               min="0" step="0.01" placeholder="—" value="${escapeHtml(toRupees(r.bulkPerPageCents))}"></td>
        <td class="num"><input type="number" class="form-input rate-input" data-field="additionalCopyPerPageCents"
                               min="0" step="0.01" placeholder="—" value="${escapeHtml(toRupees(r.additionalCopyPerPageCents))}"></td>
        <td><input type="checkbox" data-field="enabled" ${r.enabled ? 'checked' : ''}></td>
      </tr>`).join('');

    body.querySelectorAll('tr[data-rate]').forEach((row) => {
      const key = row.getAttribute('data-rate');
      const rate = draft.rates.find((r) => rateKey(r) === key);

      row.querySelectorAll('input').forEach((input) => {
        input.addEventListener('input', () => {
          const field = input.getAttribute('data-field');

          if (field === 'enabled') {
            rate.enabled = input.checked;
          } else {
            const paise = toPaise(input.value);
            input.classList.toggle('is-invalid', paise === null);

            if (paise !== null) {
              // Blank means "no discounted rate here" for the two discount
              // columns, and is not allowed for the rate itself.
              rate[field] = paise === undefined
                ? (field === 'perPageCents' ? null : null)
                : paise;
            }
          }

          refreshSaveButton();
        });
      });
    });
  }

  // ---------------------------------------------------------------- preview ---

  /**
   * What a customer would be shown, derived from the unsaved draft.
   *
   * The same two rules the server uses: the shop has to offer the service, and
   * a priced, enabled rate has to exist for the combination. Kept deliberately
   * small and duplicated rather than fetched — the whole point of the preview
   * is that it reflects edits that have not been saved, so there is nothing to
   * ask the server about yet. The server remains the authority at submit time.
   */
  function derivePreview() {
    const offers = new Set(draft.portal.enabledServices || []);
    const paperKeys = { A4: 'paper-a4', A3: 'paper-a3', Letter: 'paper-letter' };

    const sellable = (paper, colour, duplex) => draft.rates.some((r) =>
      r.paperSize === paper && r.isColor === colour && r.isDuplex === duplex &&
      r.enabled && typeof r.perPageCents === 'number' && r.perPageCents >= 0);

    const paperSizes = Object.keys(paperKeys).filter((size) =>
      offers.has(paperKeys[size]) &&
      [false, true].some((c) => [false, true].some((d) => sellable(size, c, d))));

    const colourModes = [];
    if (offers.has('bw') && paperSizes.some((p) => [false, true].some((d) => sellable(p, false, d)))) colourModes.push('bw');
    if (offers.has('colour') && paperSizes.some((p) => [false, true].some((d) => sellable(p, true, d)))) colourModes.push('colour');

    const sidedModes = [];
    if (offers.has('single-sided')) sidedModes.push('single');
    if (offers.has('duplex-auto') || offers.has('duplex-manual')) sidedModes.push('duplex');

    return {
      colourModes,
      sidedModes,
      paperSizes,
      allowMultipleCopies: offers.has('multiple-copies'),
      allowPageSelection: offers.has('page-selection'),
      asksName: !!draft.portal.collectCustomerName,
      nameRequired: !!draft.portal.customerNameRequired,
      asksPhone: !!draft.portal.collectCustomerPhone,
      phoneRequired: !!draft.portal.customerPhoneRequired,
    };
  }

  function renderPreview() {
    const body = document.getElementById('ppBody');
    if (!body || !draft) return;

    const o = derivePreview();
    const parts = [];

    parts.push('<div class="pp-drop">Tap to choose a document</div>');

    if (o.asksName || o.asksPhone) {
      const fields = [];
      if (o.asksName) fields.push(`<div class="pp-field">Name${o.nameRequired ? ' *' : ' (optional)'}</div>`);
      if (o.asksPhone) fields.push(`<div class="pp-field">Mobile number${o.phoneRequired ? ' *' : ' (optional)'}</div>`);
      parts.push(`<div class="pp-section"><div class="pp-label">Your details</div>${fields.join('')}</div>`);
    }

    // A control with one remaining choice is not shown, exactly as the customer
    // page does it: a question with one answer is not a question.
    if (o.colourModes.length > 1) {
      parts.push(`<div class="pp-section"><div class="pp-label">Colour</div><div class="pp-pills">
        ${o.colourModes.map((m, i) => `<span class="pp-pill ${i === 0 ? 'on' : ''}">${m === 'bw' ? 'B&amp;W' : 'Colour'}</span>`).join('')}
      </div></div>`);
    }

    if (o.sidedModes.length > 1) {
      parts.push(`<div class="pp-section"><div class="pp-label">Sides</div><div class="pp-pills">
        ${o.sidedModes.map((m, i) => `<span class="pp-pill ${i === 0 ? 'on' : ''}">${m === 'single' ? 'Single' : 'Back-to-back'}</span>`).join('')}
      </div></div>`);
    }

    if (o.paperSizes.length > 1) {
      parts.push(`<div class="pp-section"><div class="pp-label">Paper</div><div class="pp-pills">
        ${o.paperSizes.map((p, i) => `<span class="pp-pill ${i === 0 ? 'on' : ''}">${escapeHtml(p)}</span>`).join('')}
      </div></div>`);
    }

    if (o.allowMultipleCopies) parts.push('<div class="pp-section"><div class="pp-label">Copies</div><div class="pp-stepper">− 1 +</div></div>');
    if (o.allowPageSelection) parts.push('<div class="pp-section"><div class="pp-label">Pages</div><div class="pp-pills"><span class="pp-pill on">All</span><span class="pp-pill">Range</span></div></div>');

    // The one state worth shouting about: nothing sellable at all.
    if (o.colourModes.length === 0 || o.paperSizes.length === 0 || o.sidedModes.length === 0) {
      parts.push(`<div class="pp-empty">
        This shop currently offers nothing a customer could order.
        Check the services and that the matching rates are switched on.
      </div>`);
    } else {
      parts.push('<div class="pp-cta">Pay and print</div>');
    }

    body.innerHTML = parts.join('');
  }

  // ---------------------------------------------------------------- binding ---

  function bindCheckbox(id, read, write) {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = !!read();
    el.addEventListener('change', () => { write(el.checked); refreshSaveButton(); });
  }

  function bindDiscounts() {
    bindCheckbox('bulkEnabled', () => draft.card.bulkEnabled, (v) => { draft.card.bulkEnabled = v; });
    bindCheckbox('additionalCopyEnabled', () => draft.card.additionalCopyEnabled, (v) => { draft.card.additionalCopyEnabled = v; });

    const threshold = document.getElementById('bulkThreshold');
    if (threshold) {
      threshold.value = toRupees(draft.card.bulkThresholdCents);
      threshold.addEventListener('input', () => {
        const paise = toPaise(threshold.value);
        threshold.classList.toggle('is-invalid', paise === null);
        if (paise !== null && paise !== undefined) draft.card.bulkThresholdCents = paise;
        refreshSaveButton();
      });
    }
  }

  function bindPortal() {
    const p = () => draft.portal;
    bindCheckbox('collectCustomerName', () => p().collectCustomerName, (v) => {
      p().collectCustomerName = v;
      // Clearing "asked" clears "required" with it, rather than leaving a
      // combination the server would reject anyway.
      if (!v) {
        p().customerNameRequired = false;
        document.getElementById('customerNameRequired').checked = false;
      }
    });
    bindCheckbox('customerNameRequired', () => p().customerNameRequired, (v) => { p().customerNameRequired = v; });

    bindCheckbox('collectCustomerPhone', () => p().collectCustomerPhone, (v) => {
      p().collectCustomerPhone = v;
      if (!v) {
        p().customerPhoneRequired = false;
        document.getElementById('customerPhoneRequired').checked = false;
      }
    });
    bindCheckbox('customerPhoneRequired', () => p().customerPhoneRequired, (v) => { p().customerPhoneRequired = v; });
  }

  // ------------------------------------------------------------------- tabs ---

  function bindTabs() {
    const tabs = [...document.querySelectorAll('.setup-tab')];
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-tab');

        tabs.forEach((t) => {
          const on = t === tab;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
        });

        document.querySelectorAll('.setup-pane').forEach((pane) => {
          pane.classList.toggle('active', pane.id === target);
        });
      });
    });
  }

  // ------------------------------------------------------------------- save ---

  async function save() {
    const problems = refreshValidity();
    if (Object.keys(problems).length > 0) {
      const [tab, message] = Object.entries(problems)[0];
      document.querySelector(`.setup-tab[data-tab="${tab}"]`)?.click();
      toast('warning', 'Not saved', message);
      return;
    }

    const btn = document.getElementById('btnSaveAll');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      // Sequential, not parallel: if the rate card fails there is no reason to
      // have already changed what customers are asked for.
      const rates = await api(`/api/shops/${encodeURIComponent(shopId)}/rates`, {
        method: 'POST',
        body: JSON.stringify({
          rates: draft.rates,
          bulkEnabled: draft.card.bulkEnabled,
          bulkThresholdCents: draft.card.bulkThresholdCents,
          additionalCopyEnabled: draft.card.additionalCopyEnabled,
        }),
      });
      if (!rates.ok) throw new Error((await rates.json()).error || 'Could not save your rates.');

      const portal = await api(`/api/shops/${encodeURIComponent(shopId)}/portal-config`, {
        method: 'POST',
        body: JSON.stringify(draft.portal),
      });
      if (!portal.ok) throw new Error((await portal.json()).error || 'Could not save your portal settings.');

      saved = JSON.parse(JSON.stringify(draft));
      toast('success', 'Saved', 'Your shop is updated. Customers see the change on their next order.');
    } catch (err) {
      toast('danger', 'Not saved', err.message);
    } finally {
      btn.textContent = 'Save changes';
      refreshSaveButton();
    }
  }

  // ------------------------------------------------------------------- boot ---

  async function boot() {
    shopId = readShopId();

    if (!token() || !shopId) {
      document.getElementById('setupSignedOut').hidden = false;
      return;
    }

    try {
      const [cat, card, portal] = await Promise.all([
        api('/api/service-catalogue').then((r) => r.json()),
        api(`/api/shops/${encodeURIComponent(shopId)}/rates`).then((r) => r.json()),
        api(`/api/shops/${encodeURIComponent(shopId)}/portal-config`).then((r) => r.json()),
      ]);

      catalogue = cat;
      saved = {
        rates: card.rates,
        card: {
          bulkEnabled: card.bulkEnabled,
          bulkThresholdCents: card.bulkThresholdCents,
          additionalCopyEnabled: card.additionalCopyEnabled,
        },
        portal,
      };
      draft = JSON.parse(JSON.stringify(saved));

      document.getElementById('setupMain').hidden = false;
      renderServices();
      renderRates();
      bindDiscounts();
      bindPortal();
      bindTabs();
      refreshSaveButton();

      document.getElementById('btnSaveAll').addEventListener('click', save);
    } catch (err) {
      document.getElementById('setupSignedOut').hidden = false;
      toast('danger', 'Could not load', err.message || 'Your shop settings could not be loaded.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
