/*
 * Public support contact — the one place the site's pages read it from.
 *
 * The address is the one the Terms (§1) and Privacy Policy (§11) already
 * publish for customer care and grievances; those pages state it in their own
 * text so it reads without JavaScript, and a routing test asserts they match
 * this. Change it here and there together.
 *
 * phone is deliberately empty: no support number has been published anywhere
 * in the project, and a number is not something to guess. Set it here once
 * there is one and every [data-support-phone] element shows it.
 */
(function () {
  'use strict';

  var SUPPORT = {
    email: 'ayan48311@gmail.com',
    phone: '',
  };

  window.PRINTOK_SUPPORT = SUPPORT;

  function fill() {
    document.querySelectorAll('[data-support-email]').forEach(function (el) {
      if (!SUPPORT.email) return;
      el.textContent = SUPPORT.email;
      if (el.tagName === 'A') el.setAttribute('href', 'mailto:' + SUPPORT.email);
    });
    document.querySelectorAll('[data-support-phone]').forEach(function (el) {
      // Hidden unless a number is configured, so no page shows an empty line.
      var row = el.closest('[data-support-phone-row]') || el;
      if (!SUPPORT.phone) { row.hidden = true; return; }
      row.hidden = false;
      el.textContent = SUPPORT.phone;
      if (el.tagName === 'A') el.setAttribute('href', 'tel:' + SUPPORT.phone.replace(/\s+/g, ''));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();
})();
