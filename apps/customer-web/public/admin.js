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
  const selected = new Set();

  function updateBulkBar() {
    const bar = $('adminBulkBar');
    bar.hidden = selected.size === 0;
    $('adminBulkCount').textContent =
      `${selected.size} shop${selected.size === 1 ? '' : 's'} selected`;
  }

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
      tbody.innerHTML = '<tr><td colspan="10" class="meta-text" style="padding:24px;">No shops match.</td></tr>';
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
        <tr class="${s.archivedAt ? 'row--archived' : ''}">
          <td class="col-select">
            <input type="checkbox" data-select="${escapeHtml(shop.id)}"
                   ${selected.has(shop.id) ? 'checked' : ''}
                   aria-label="Select ${escapeHtml(shop.name)}">
          </td>
          <td>
            <div class="cell-title">${escapeHtml(shop.name)}</div>
            <div class="meta-text">${escapeHtml(shop.ownerEmail)}</div>
            <div class="meta-text mono">${escapeHtml(shop.id)}</div>
          </td>
          <td>
            <select class="form-input form-input--compact" data-plan-tier="${escapeHtml(shop.id)}" aria-label="Plan tier">
              ${(planTiers.length ? planTiers : [s.plan.planTier]).map((t) =>
                `<option value="${escapeHtml(t)}"${s.plan.planTier === t ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('')}
            </select>
          </td>
          <td>
            <div class="commission-cell">
              <input type="number" class="form-input form-input--compact" min="0" max="50" step="0.25"
                     value="${(s.plan.commissionBps / 100).toFixed(2)}"
                     data-commission="${escapeHtml(shop.id)}" aria-label="PrintOk platform fee percent">
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
          <td>
            <div class="row-actions">
              ${s.archivedAt
                ? `<button class="btn btn-outline btn-sm" data-restore="${escapeHtml(shop.id)}" type="button">Restore</button>`
                : `<button class="btn btn-outline btn-sm" data-archive="${escapeHtml(shop.id)}" type="button">Archive</button>`}
              ${s.canHardDelete
                ? `<button class="btn btn-danger btn-sm" data-delete="${escapeHtml(shop.id)}" type="button">Delete</button>`
                : `<span class="meta-text protected-note" title="This shop has taken payment, so deleting it would destroy payment records.">Protected</span>`}
            </div>
          </td>
        </tr>`;
    }).join('');

    // Re-rendering replaces the checkboxes, so reflect the current selection.
    tbody.querySelectorAll('[data-select]').forEach((box) => {
      box.checked = selected.has(box.getAttribute('data-select'));
    });
    updateBulkBar();
  }

  /**
   * Applies a removal to one or more shops.
   *
   * Deletion is irreversible, so the confirmation names the shops and states
   * plainly what will be lost rather than asking "are you sure?".
   */
  async function removeShops(shopIds, mode, options = {}) {
    if (!shopIds.length) return;

    const names = shopIds
      .map((id) => allShops.find((x) => x.shop.id === id)?.shop.name || id)
      .slice(0, 8);
    const more = shopIds.length > names.length ? ` and ${shopIds.length - names.length} more` : '';

    if (mode === 'delete') {
      const ok = window.confirm(
        `Permanently delete ${shopIds.length} shop${shopIds.length === 1 ? '' : 's'}?\n\n` +
        `${names.join(', ')}${more}\n\n` +
        'Their printers, print jobs and history will be destroyed. This cannot be undone.\n' +
        'Shops that have taken a payment will be refused automatically.'
      );
      if (!ok) return;
    } else if (mode === 'archive' && !options.skipConfirm) {
      const ok = window.confirm(
        `Archive ${shopIds.length} shop${shopIds.length === 1 ? '' : 's'}?\n\n` +
        `${names.join(', ')}${more}\n\nThey will be hidden but keep all their data. You can restore them later.`
      );
      if (!ok) return;
    }

    try {
      const body = await api('/api/admin/shops/remove', {
        method: 'POST',
        body: JSON.stringify({ shopIds, mode, reason: options.reason }),
      });

      const refused = body.results.filter((r) => !r.ok);
      if (body.succeeded) {
        toast('success', `${body.succeeded} shop${body.succeeded === 1 ? '' : 's'} ${mode}d`,
          refused.length ? `${refused.length} were refused.` : 'Done.');
      }
      // Every refusal has a specific reason; surface the first one rather than
      // a generic failure.
      if (refused.length) {
        toast('warning', `${refused.length} refused`, refused[0].reason || 'Not permitted.');
      }

      selected.clear();
      await loadConsole();
    } catch (err) {
      toast('danger', 'Action failed', err.message);
    }
  }

  /**
   * Contact enquiries from the public form.
   *
   * The message is shown in full rather than truncated: an operator deciding
   * whether to reply needs to read it, and these are short by design.
   */
  async function loadEnquiries() {
    const list = $('adminEnquiryList');
    const status = $('enquiryFilter').value;

    try {
      const { enquiries, newCount } = await api(
        `/api/admin/contact-enquiries?status=${encodeURIComponent(status)}&limit=100`
      );

      const badge = $('enquiryNewBadge');
      badge.hidden = !newCount;
      badge.textContent = `${newCount} new`;

      if (!enquiries.length) {
        list.innerHTML = '<p class="meta-text">No enquiries here.</p>';
        return;
      }

      list.innerHTML = enquiries.map((e) => `
        <article class="enquiry-row enquiry-row--${escapeHtml(e.status)}">
          <div class="enquiry-head">
            <div>
              <span class="cell-title">${escapeHtml(e.name)}</span>
              ${e.shopName ? `<span class="meta-text"> · ${escapeHtml(e.shopName)}</span>` : ''}
            </div>
            <span class="badge ${e.status === 'new' ? 'badge-danger' : 'badge-muted'}">
              ${escapeHtml(e.status)}
            </span>
          </div>

          <div class="meta-text enquiry-contact">
            <a href="mailto:${escapeHtml(e.email)}">${escapeHtml(e.email)}</a>
            ${e.phone ? ` · ${escapeHtml(e.phone)}` : ''}
            · ${escapeHtml(relativeTime(e.createdAt))}
          </div>

          <p class="enquiry-message">${escapeHtml(e.message)}</p>

          <div class="enquiry-actions">
            ${['read', 'replied', 'archived']
              .filter((s) => s !== e.status)
              .map((s) => `<button class="btn btn-outline btn-sm" type="button"
                             data-enquiry="${escapeHtml(e.id)}" data-status="${s}">
                             Mark ${s}
                           </button>`).join('')}
          </div>
        </article>`).join('');
    } catch (err) {
      list.innerHTML = `<p class="meta-text">Could not load: ${escapeHtml(err.message)}</p>`;
    }
  }

  async function loadAudit() {
    const list = $('adminAuditList');
    try {
      const { entries } = await api('/api/admin/audit?limit=50');
      if (!entries.length) {
        list.innerHTML = '<p class="meta-text">No admin activity recorded yet.</p>';
        return;
      }

      list.innerHTML = entries.map((e) => `
        <div class="audit-row">
          <span class="badge ${e.action === 'SHOP_DELETED' ? 'badge-danger' : 'badge-muted'}">
            ${escapeHtml(e.action.replace(/_/g, ' ').toLowerCase())}
          </span>
          <span class="mono">${escapeHtml(e.targetId)}</span>
          <span class="meta-text">by ${escapeHtml(e.actorEmail)}</span>
          <span class="meta-text">${escapeHtml(relativeTime(e.createdAt))}</span>
        </div>`).join('');
    } catch (err) {
      list.innerHTML = `<p class="meta-text">Could not load: ${escapeHtml(err.message)}</p>`;
    }
  }

  function applyFilter() {
    const q = ($('adminShopFilter').value || '').trim().toLowerCase();
    if (!q) return renderShops(allShops);

    renderShops(allShops.filter((s) =>
      s.shop.name.toLowerCase().includes(q) ||
      s.shop.ownerEmail.toLowerCase().includes(q) ||
      s.shop.id.toLowerCase().includes(q)));
  }

  /**
   * Tier ids, from the API rather than from a list kept here.
   *
   * This dropdown used to hardcode ['free', 'starter', 'pro'] — three ids that
   * were not in PLAN_CATALOGUE at all, and no 'business'. Every plan change an
   * operator made from this console was therefore rejected as an unknown tier,
   * and the console reloaded without saying why. Read from /api/plans so the
   * options are whatever the backend will actually accept.
   */
  let planTiers = [];

  /**
   * Fleet view and publication.
   *
   * Built with DOM nodes rather than innerHTML: version strings and device
   * names come from agents, which is to say from other people's machines, and
   * a device named with a <script> tag should be a funny name rather than a
   * script running in the operator console.
   */
  async function loadFleet() {
    const box = $('adminFleetSummary');
    if (!box) return;

    try {
      const data = await api('/api/admin/agent-releases');
      const active = data.active;
      const fleet = data.fleet || { total: 0, outdated: 0, byVersion: [] };

      const rows = [];

      const current = document.createElement('p');
      current.className = 'meta-text';
      if (!active) {
        current.textContent =
          'No build has been published. Every agent is told it is up to date, and nothing updates itself.';
      } else {
        current.textContent =
          `Published: ${active.version} · ${active.mode === 'auto' ? 'installs automatically' : 'notify only'}`
          + `${active.paused ? ' · PAUSED, offered to nobody' : ''}`
          + ` · ${fleet.outdated} of ${fleet.total} device${fleet.total === 1 ? '' : 's'} behind`;
      }
      rows.push(current);

      if (fleet.byVersion.length) {
        const list = document.createElement('div');
        list.className = 'plan-usage';
        for (const entry of fleet.byVersion) {
          const row = document.createElement('div');
          // Behind the published build is the state worth colouring; being on
          // it is the normal case and needs no decoration.
          const behind = active && entry.version !== active.version;
          row.className = 'plan-usage-row' + (behind ? ' is-over' : '');
          const name = document.createElement('span');
          name.textContent = entry.version === 'unknown' ? 'version not reported' : entry.version;
          const count = document.createElement('strong');
          count.textContent = `${entry.count} device${entry.count === 1 ? '' : 's'}`;
          row.append(name, count);
          list.append(row);
        }
        rows.push(list);
      }

      box.replaceChildren(...rows);
    } catch (err) {
      box.replaceChildren(
        Object.assign(document.createElement('p'), {
          className: 'meta-text',
          textContent: `Could not load the fleet: ${err.message}`,
        })
      );
    }
  }

  async function loadConsole() {
    try {
      const includeArchived = $('adminShowArchived').checked;
      const [{ overview }, { shops }, catalogue] = await Promise.all([
        api('/api/admin/overview'),
        api(`/api/admin/shops?includeArchived=${includeArchived}`),
        // Public, so it needs no operator token; failing here must not take the
        // whole console down, so an empty list falls back to the shop's own tier.
        fetch(`${API_BASE}/api/plans`).then((r) => (r.ok ? r.json() : { plans: [] })).catch(() => ({ plans: [] })),
      ]);
      planTiers = (catalogue.plans || []).map((p) => p.tier);
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
    $('adminShowArchived').addEventListener('change', loadConsole);
    $('btnLoadAudit').addEventListener('click', loadAudit);
    $('btnLoadEnquiries').addEventListener('click', loadEnquiries);
    $('enquiryFilter').addEventListener('change', loadEnquiries);

    $('adminEnquiryList').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-enquiry]');
      if (!button) return;

      button.disabled = true;
      try {
        await api(`/api/admin/contact-enquiries/${encodeURIComponent(button.getAttribute('data-enquiry'))}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: button.getAttribute('data-status') }),
        });
        await loadEnquiries();
      } catch (err) {
        toast('danger', 'Update failed', err.message);
        button.disabled = false;
      }
    });

    $('adminSelectAll').addEventListener('change', (event) => {
      // Only the rows currently visible after filtering.
      document.querySelectorAll('[data-select]').forEach((box) => {
        const id = box.getAttribute('data-select');
        if (event.target.checked) selected.add(id); else selected.delete(id);
        box.checked = event.target.checked;
      });
      updateBulkBar();
    });

    const bulk = (mode) => () => removeShops([...selected], mode);
    $('btnBulkArchive').addEventListener('click', bulk('archive'));
    $('btnBulkDelete').addEventListener('click', bulk('delete'));
    $('btnBulkRestore').addEventListener('click', bulk('restore'));
    $('btnBulkClear').addEventListener('click', () => {
      selected.clear();
      document.querySelectorAll('[data-select]').forEach((b) => { b.checked = false; });
      $('adminSelectAll').checked = false;
      updateBulkBar();
    });

    $('adminShopRows').addEventListener('click', (event) => {
      const del = event.target.closest('[data-delete]');
      if (del) return removeShops([del.getAttribute('data-delete')], 'delete');

      const arch = event.target.closest('[data-archive]');
      if (arch) return removeShops([arch.getAttribute('data-archive')], 'archive');

      const rest = event.target.closest('[data-restore]');
      if (rest) return removeShops([rest.getAttribute('data-restore')], 'restore');
    });

    // Plan edits are delegated, so re-rendering the table never loses handlers.
    $('adminShopRows').addEventListener('change', (event) => {
      const selectBox = event.target.closest('[data-select]');
      if (selectBox) {
        const id = selectBox.getAttribute('data-select');
        if (selectBox.checked) selected.add(id); else selected.delete(id);
        updateBulkBar();
        return;
      }

      const tierSelect = event.target.closest('[data-plan-tier]');
      if (tierSelect) {
        return savePlan(tierSelect.getAttribute('data-plan-tier'), { planTier: tierSelect.value });
      }

      const commissionInput = event.target.closest('[data-commission]');
      if (commissionInput) {
        const percent = Number(commissionInput.value);
        if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
          toast('warning', 'Invalid platform fee', 'Enter a percentage between 0 and 50.');
          return loadConsole();
        }
        return savePlan(commissionInput.getAttribute('data-commission'), {
          commissionBps: Math.round(percent * 100),
        });
      }
    });
  });

  // Fleet panel wiring. Loaded on demand rather than with the console, because
  // it is a second round trip an operator does not always need.
  document.getElementById('btnLoadFleet')?.addEventListener('click', loadFleet);

  document.getElementById('agentReleaseForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const hint = $('releaseFormHint');
    const value = (id) => (document.getElementById(id)?.value || '').trim();

    try {
      const { release } = await api('/api/admin/agent-releases', {
        method: 'POST',
        body: JSON.stringify({
          version: value('releaseVersion'),
          downloadUrl: value('releaseUrl'),
          sha256: value('releaseSha'),
          mode: value('releaseMode'),
          notes: value('releaseNotes'),
          paused: document.getElementById('releasePaused')?.checked === true,
        }),
      });

      if (hint) {
        hint.textContent =
          `Published ${release.version}. `
          + (release.paused
            ? 'It is paused, so no agent is being offered it yet.'
            : release.mode === 'auto'
              ? 'Agents will install it as they check in.'
              : 'Agents will report it as available and install nothing.');
      }
      toast('success', 'Published', `Agent ${release.version} is now the published build.`);
      loadFleet();
    } catch (err) {
      if (hint) hint.textContent = err.message;
      toast('danger', 'Not published', err.message);
    }
  });

})();
