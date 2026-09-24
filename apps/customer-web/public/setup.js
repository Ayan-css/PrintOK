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

  // Framed inside the dashboard's Rates & discounts tab: the page keeps its
  // editor and its Save, and styles.css hides the rest (see .is-embedded).
  if (new URLSearchParams(window.location.search).has('embed')) {
    document.documentElement.classList.add('is-embedded');
  }

  const API_BASE = (function () {
    // Same rule as the dashboard: same-origin in development, the deployed API
    // otherwise. A relative path would hit Vercel, which serves no API.
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:4000';
    return 'https://prinok-api.onrender.com';
  })();

  // These must match app.js exactly. They are separate scripts with no shared
  // module, so the only thing keeping them in step is the routing test that
  // asserts both files use the same strings — which exists because getting this
  // wrong shows up as "sign in to set up your shop" on a page you just signed
  // into, with nothing in the console to say why.
  const SESSION_KEY = 'printok_merchant_token';
  const CONTEXT_KEY = 'printok.shopContext';

  let shopId = null;
  let catalogue = { capabilities: [], groups: [], defaults: [] };

  /** What was loaded, and what the shop has changed. Compared to detect edits. */
  let saved = null;
  let draft = null;
  let staff = [];

  // ------------------------------------------------------------------ utils ---

  /**
   * The merchant session, from localStorage.
   *
   * Matches app.js. It was sessionStorage in both, which is why a shop owner
   * signed in again every time they opened the browser: the token was usually
   * still valid, the browser had just discarded it. Falls back to the old
   * location once so an upgrade mid-shift does not sign anyone out.
   */
  function token() {
    try {
      const stored = localStorage.getItem(SESSION_KEY);
      if (stored) return stored;
      const legacy = sessionStorage.getItem(SESSION_KEY);
      if (legacy) {
        localStorage.setItem(SESSION_KEY, legacy);
        sessionStorage.removeItem(SESSION_KEY);
        return legacy;
      }
      return null;
    } catch { return null; }
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
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });

    // A session in continuous use renews itself server-side; store the new
    // token when one comes back, so a long setup session cannot expire
    // underneath the person filling it in.
    try {
      const renewed = res.headers.get('x-printok-session-renewed');
      if (renewed) localStorage.setItem(SESSION_KEY, renewed);
    } catch { /* header unreadable; the existing token is still good */ }

    return res;
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

    if (draft.portal.separatorMode !== 'none' && !(draft.portal.separatorMinQueue >= 1)) {
      problems.tabAutomation = 'Say how many waiting jobs counts as busy';
    }

    if (!String(draft.profile?.name || '').trim()) {
      problems.tabAccount = 'Your shop needs a name';
    } else if (draft.profile.gstin
               && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(String(draft.profile.gstin).toUpperCase())) {
      problems.tabAccount = 'That GSTIN does not look right';
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

  // ---------------------------------------------------------------- account ---

  const PROFILE_FIELDS = {
    shopName: 'name',
    shopPhone: 'contactPhone',
    shopStreet1: 'addressStreet1',
    shopStreet2: 'addressStreet2',
    shopCity: 'addressCity',
    shopState: 'addressState',
    shopPin: 'addressPostalCode',
    shopGstin: 'gstin',
  };

  function bindAccount() {
    for (const [inputId, field] of Object.entries(PROFILE_FIELDS)) {
      const el = document.getElementById(inputId);
      if (!el) continue;
      el.value = draft.profile[field] ?? '';
      el.addEventListener('input', () => {
        draft.profile[field] = el.value;
        refreshSaveButton();
      });
    }

    document.getElementById('btnChangePassword')?.addEventListener('click', changePassword);
    document.getElementById('btnAddStaff')?.addEventListener('click', addStaff);

    renderStaff();
  }

  /**
   * Password change is its own action, not part of Save.
   *
   * Saving the whole wizard should never carry a credential change along with
   * it: the two have different failure modes, and a rate card that saved while
   * a password quietly did not is the kind of thing nobody notices until they
   * cannot sign in.
   */
  async function changePassword() {
    const current = document.getElementById('pwCurrent');
    const next = document.getElementById('pwNew');
    if (!current.value || !next.value) {
      toast('warning', 'Both needed', 'Enter your current password and the new one.');
      return;
    }

    try {
      const res = await api('/api/merchant/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current.value, newPassword: next.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'The password could not be changed.');

      current.value = '';
      next.value = '';
      toast('success', 'Password changed', 'Use the new one next time you sign in.');
    } catch (err) {
      toast('danger', 'Not changed', err.message);
    }
  }

  function renderStaff() {
    const host = document.getElementById('staffList');
    if (!host) return;

    if (!staff.length) {
      host.innerHTML = '<p class="form-help">Only you can sign in to this shop.</p>';
      return;
    }

    host.innerHTML = staff.map((u) => {
      const isOwner = u.role === 'owner';
      const disabled = u.status !== 'active';

      return `<div class="staff-row ${disabled ? 'is-disabled' : ''}">
        <div>
          <div class="staff-name">${escapeHtml(u.name || u.email)}</div>
          <div class="staff-meta">${escapeHtml(u.email)} · ${isOwner ? 'Owner' : 'Staff'}${disabled ? ' · disabled' : ''}</div>
        </div>
        ${isOwner
          ? '<span class="form-help">Cannot be removed</span>'
          : `<button type="button" class="btn btn-outline btn-sm" data-staff="${escapeHtml(u.id)}"
                     data-next="${disabled ? 'active' : 'disabled'}">
               ${disabled ? 'Let back in' : 'Disable'}
             </button>`}
      </div>`;
    }).join('');

    host.querySelectorAll('[data-staff]').forEach((btn) => {
      btn.addEventListener('click', () => setStaffStatus(
        btn.getAttribute('data-staff'),
        btn.getAttribute('data-next'),
        btn
      ));
    });
  }

  async function setStaffStatus(userId, status, button) {
    const label = button.textContent;
    try {
      button.disabled = true;
      button.textContent = 'Saving…';

      const res = await api(`/api/shops/${encodeURIComponent(shopId)}/staff/${encodeURIComponent(userId)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'That could not be changed.');

      await loadStaff();
    } catch (err) {
      toast('danger', 'Not changed', err.message);
      button.disabled = false;
      button.textContent = label;
    }
  }

  async function addStaff() {
    const name = document.getElementById('staffName');
    const email = document.getElementById('staffEmail');
    const password = document.getElementById('staffPassword');

    if (!email.value.trim() || !password.value) {
      toast('warning', 'Almost', 'An email address and a password are needed.');
      return;
    }

    try {
      const res = await api(`/api/shops/${encodeURIComponent(shopId)}/staff`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.value.trim(),
          email: email.value.trim(),
          password: password.value,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'That person could not be added.');

      name.value = '';
      email.value = '';
      password.value = '';
      await loadStaff();
      toast('success', 'Added', 'Give them the password you set — they can sign in now.');
    } catch (err) {
      toast('danger', 'Not added', err.message);
    }
  }

  async function loadStaff() {
    try {
      const res = await api(`/api/shops/${encodeURIComponent(shopId)}/staff`);
      if (!res.ok) return;
      staff = ((await res.json()).staff) || [];
      renderStaff();
    } catch {
      // The list is supplementary; a failure here must not break the tab.
    }
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

    // Orientation is the same price on every rate, so unlike colour and paper it
    // is gated on the service toggles alone. All three off still prints: 'auto'
    // is what every job did before the choice existed, and the server falls back
    // to it rather than taking the shop offline over a setting nobody knew was
    // load-bearing.
    const orientations = [];
    if (offers.has('auto-orientation')) orientations.push('auto');
    if (offers.has('portrait')) orientations.push('portrait');
    if (offers.has('landscape')) orientations.push('landscape');

    return {
      colourModes,
      sidedModes,
      paperSizes,
      orientations: orientations.length > 0 ? orientations : ['auto'],
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

    if (o.orientations.length > 1) {
      const label = { auto: 'Auto', portrait: 'Portrait', landscape: 'Landscape' };
      parts.push(`<div class="pp-section"><div class="pp-label">Orientation</div><div class="pp-pills">
        ${o.orientations.map((m, i) => `<span class="pp-pill ${i === 0 ? 'on' : ''}">${label[m]}</span>`).join('')}
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

  function bindAutomation() {
    document.querySelectorAll('input[name="autoPrintMode"]').forEach((radio) => {
      radio.checked = radio.value === draft.portal.autoPrintMode;
      radio.addEventListener('change', () => {
        if (radio.checked) { draft.portal.autoPrintMode = radio.value; refreshSaveButton(); }
      });
    });

    const mode = document.getElementById('separatorMode');
    const queue = document.getElementById('separatorMinQueue');
    const group = document.getElementById('separatorQueueGroup');

    const syncSeparator = () => {
      // The threshold is meaningless with nothing to print between jobs, so it
      // goes away rather than sitting there inviting a pointless decision.
      if (group) group.hidden = draft.portal.separatorMode === 'none';
    };

    if (mode) {
      mode.value = draft.portal.separatorMode;
      mode.addEventListener('change', () => {
        draft.portal.separatorMode = mode.value;
        syncSeparator();
        refreshSaveButton();
      });
    }

    if (queue) {
      queue.value = String(draft.portal.separatorMinQueue ?? 3);
      queue.addEventListener('input', () => {
        const n = Number.parseInt(queue.value, 10);
        const bad = !Number.isInteger(n) || n < 1;
        queue.classList.toggle('is-invalid', bad);
        if (!bad) draft.portal.separatorMinQueue = n;
        refreshSaveButton();
      });
    }

    syncSeparator();
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

  function showTab(target) {
    const tabs = [...document.querySelectorAll('.setup-tab')];
    const wanted = tabs.find((t) => t.getAttribute('data-tab') === target);
    if (!wanted) return false;

    tabs.forEach((t) => {
      const on = t === wanted;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });

    document.querySelectorAll('.setup-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.id === target);
    });

    return true;
  }

  function bindTabs() {
    document.querySelectorAll('.setup-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-tab');
        if (!showTab(target)) return;

        // Replace rather than push: the back button should leave the setup
        // screen, not walk back through six tabs someone clicked to find one.
        // The hash is what makes a section linkable from the dashboard.
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${target}`);
      });
    });

    // Opened at a section: ?tab= from a link, or #hash from a shared URL.
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('tab') || window.location.hash.replace('#', '');
    if (wanted) showTab(wanted);
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

      const profile = await api(`/api/shops/${encodeURIComponent(shopId)}/profile`, {
        method: 'POST',
        body: JSON.stringify(draft.profile),
      });
      if (!profile.ok) throw new Error((await profile.json()).error || 'Could not save your shop details.');

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
      const [cat, card, portal, profileBody] = await Promise.all([
        api('/api/service-catalogue').then((r) => r.json()),
        api(`/api/shops/${encodeURIComponent(shopId)}/rates`).then((r) => r.json()),
        api(`/api/shops/${encodeURIComponent(shopId)}/portal-config`).then((r) => r.json()),
        api(`/api/shops/${encodeURIComponent(shopId)}/profile`).then((r) => r.json()),
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
        profile: profileBody.profile || {},
      };
      draft = JSON.parse(JSON.stringify(saved));

      const shopName = document.getElementById('setupShopName');
      if (shopName && saved.profile.name) shopName.textContent = saved.profile.name;

      document.getElementById('setupMain').hidden = false;
      renderServices();
      renderRates();
      bindDiscounts();
      bindAutomation();
      bindPortal();
      bindAccount();
      loadStaff();
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
