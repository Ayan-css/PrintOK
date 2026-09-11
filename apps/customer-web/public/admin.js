(function () {
  'use strict';

  const API_BASE = window.PRINTOK_API_BASE
    || (location.hostname === 'localhost' ? 'http://localhost:4000' : 'https://prinok-api.onrender.com');

  // The session token is deliberately kept in sessionStorage, not localStorage:
  // it dies with the tab, which is the right default for a console that shows
  // every shop's revenue and contact details.
  const TOKEN_KEY = 'printok_admin_token';

  const getToken = () => {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  };
  const setToken = (t) => {
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** Money is stored in integer paise; format only at the edge. */
  function rupees(cents) {
    return '₹' + ((cents || 0) / 100).toLocaleString('en-IN', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  function relativeTime(iso) {
    if (!iso) return 'never';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function toast(kind, title, message) {
    const stack = $('toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.innerHTML = `<strong>${escapeHtml(title)}</strong><div>${escapeHtml(message)}</div>`;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  async function api(path, options = {}) {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });

    // An expired or revoked session must drop straight back to sign-in rather
    // than leaving a console full of stale data on screen.
    if (res.status === 401) {
      setToken(null);
      showAuth();
      throw new Error('Your session has ended. Sign in again.');
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  }

  // ----------------------------------------------------------------- views ---

  let isBootstrapMode = false;

  function showAuth() {
    $('adminAuthView').hidden = false;
    $('adminConsoleView').hidden = true;
  }

  function showConsole() {
    $('adminAuthView').hidden = true;
    $('adminConsoleView').hidden = false;
  }

  async function detectMode() {
    try {
      const { needsBootstrap } = await (await fetch(`${API_BASE}/api/admin/status`)).json();
      isBootstrapMode = Boolean(needsBootstrap);
    } catch {
      isBootstrapMode = false;
    }

    if (isBootstrapMode) {
      $('adminAuthSubtitle').textContent =
        'No administrator exists yet. Create the first account — this form closes permanently afterwards.';
      $('btnAdminAuth').textContent = 'Create Administrator';
      $('adminNameGroup').hidden = false;
      $('adminPassword').setAttribute('autocomplete', 'new-password');
      $('adminPassword').setAttribute('minlength', '12');
    }
  }

  // --------------------------------------------------------------- console ---

  let allShops = [];

  function renderOverview(o) {
    $('statShops').textContent = o.totalShops;
    $('statShopsSub').textContent = `${o.activeShops} active in last 30 days`;
    $('statPrinters').textContent = `${o.onlinePrinters}/${o.totalPrinters}`;
    $('statPrintersSub').textContent = o.totalPrinters
      ? `${Math.round((o.onlinePrinters / o.totalPrinters) * 100)}% of fleet reachable`
      : 'No printers yet';
    $('statJobsToday').textContent = o.jobsToday;
    $('statJobsSub').textContent = `${o.totalJobs} all time`;
    $('statGross').textContent = rupees(o.grossRevenueCents);
    $('statCommission').textContent = rupees(o.commissionCents);
    $('statAction').textContent = o.jobsRequiringAction;

    // Only draw the eye when something actually needs a person.
    $('statActionTile').classList.toggle('stat-tile--warn', o.jobsRequiringAction > 0);
  }

  function renderShops(shops) {
    const tbody = $('adminShopRows');

    if (!shops.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="meta-text" style="padding:16px;">No shops match.</td></tr>';
      return;
    }

    tbody.innerHTML = shops.map((s) => {
      const shop = s.shop;
      const online = s.onlinePrinterCount > 0;
      const statusLabel = s.plan.planStatus !== 'active'
        ? s.plan.planStatus
        : (online ? 'online' : 'offline');
      const statusClass = s.plan.planStatus !== 'active'
        ? 'badge-danger'
        : (online ? 'badge-success' : 'badge-muted');

      return `
        <tr>
          <td>
            <div class="cell-title">${escapeHtml(shop.name)}</div>
            <div class="meta-text">${escapeHtml(shop.ownerEmail)}</div>
            <div class="meta-text mono">${escapeHtml(shop.id)}</div>
          </td>
          <td>
            <select class="form-input form-input--compact" data-plan-tier="${escapeHtml(shop.id)}" aria-label="Plan tier">
              ${['free', 'starter', 'pro'].map((t) =>
                `<option value="${t}"${s.plan.planTier === t ? ' selected' : ''}>${t}</option>`).join('')}
            </select>
          </td>
          <td>
            <div class="commission-cell">
              <input type="number" class="form-input form-input--compact" min="0" max="50" step="0.25"
                     value="${(s.plan.commissionBps / 100).toFixed(2)}"
                     data-commission="${escapeHtml(shop.id)}" aria-label="Commission percent">
              <span class="meta-text">%</span>
            </div>
          </td>
          <td>${s.onlinePrinterCount}/${s.printerCount}
            <div class="meta-text">${s.pairedDeviceCount} paired PC${s.pairedDeviceCount === 1 ? '' : 's'}</div>
          </td>
          <td>${s.jobsLast30Days}
            <div class="meta-text">${s.totalJobs} all time</div>
          </td>
          <td>${rupees(s.grossRevenueCents)}</td>
          <td class="cell-accent">${rupees(s.commissionCents)}</td>
          <td>
            <span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span>
            ${s.jobsRequiringAction > 0
              ? `<div class="meta-text warn-text">${s.jobsRequiringAction} need attention</div>`
              : ''}
            <div class="meta-text">last job ${escapeHtml(relativeTime(s.lastJobAt))}</div>
          </td>
        </tr>`;
    }).join('');
  }

  function applyFilter() {
    const q = ($('adminShopFilter').value || '').trim().toLowerCase();
    if (!q) return renderShops(allShops);

    renderShops(allShops.filter((s) =>
      s.shop.name.toLowerCase().includes(q) ||
      s.shop.ownerEmail.toLowerCase().includes(q) ||
      s.shop.id.toLowerCase().includes(q)));
  }

  async function loadConsole() {
    try {
      const [{ overview }, { shops }] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/shops'),
      ]);
      allShops = shops;
      renderOverview(overview);
      applyFilter();
    } catch (err) {
      toast('danger', 'Could not load', err.message);
    }
  }

  async function savePlan(shopId, patch) {
    try {
      await api(`/api/admin/shops/${encodeURIComponent(shopId)}/plan`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      toast('success', 'Plan updated', 'The change applies to future jobs.');
      await loadConsole();
    } catch (err) {
      toast('danger', 'Update failed', err.message);
      await loadConsole();
    }
  }

  // ----------------------------------------------------------------- wiring ---

  document.addEventListener('DOMContentLoaded', async () => {
    await detectMode();

    if (getToken()) {
      try {
        const { user } = await api('/api/admin/me');
        $('adminWhoami').textContent = `${user.name || user.email} · ${user.role}`;
        showConsole();
        await loadConsole();
      } catch {
        showAuth();
      }
    } else {
      showAuth();
    }

    $('formAdminAuth').addEventListener('submit', async (event) => {
      event.preventDefault();
      const errorBox = $('adminAuthError');
      errorBox.hidden = true;

      const button = $('btnAdminAuth');
      button.disabled = true;

      try {
        const path = isBootstrapMode ? '/api/admin/bootstrap' : '/api/admin/login';
        const payload = {
          email: $('adminEmail').value.trim(),
          password: $('adminPassword').value,
          ...(isBootstrapMode ? { name: $('adminName').value.trim() } : {}),
        };

        const res = await fetch(`${API_BASE}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Sign in failed.');

        setToken(body.token);
        $('adminWhoami').textContent = `${body.user.name || body.user.email} · ${body.user.role}`;
        $('adminPassword').value = '';
        isBootstrapMode = false;

        showConsole();
        await loadConsole();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      } finally {
        button.disabled = false;
      }
    });

    $('btnAdminSignOut').addEventListener('click', () => {
      setToken(null);
      location.reload();
    });

    $('btnAdminRefresh').addEventListener('click', loadConsole);
    $('adminShopFilter').addEventListener('input', applyFilter);

    // Plan edits are delegated, so re-rendering the table never loses handlers.
    $('adminShopRows').addEventListener('change', (event) => {
      const tierSelect = event.target.closest('[data-plan-tier]');
      if (tierSelect) {
        return savePlan(tierSelect.getAttribute('data-plan-tier'), { planTier: tierSelect.value });
      }

      const commissionInput = event.target.closest('[data-commission]');
      if (commissionInput) {
        const percent = Number(commissionInput.value);
        if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
          toast('warning', 'Invalid commission', 'Enter a percentage between 0 and 50.');
          return loadConsole();
        }
        return savePlan(commissionInput.getAttribute('data-commission'), {
          commissionBps: Math.round(percent * 100),
        });
      }
    });
  });
})();
