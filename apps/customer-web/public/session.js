/**
 * Ending a merchant session, from anywhere that has one.
 *
 * There was no way to sign out. The dashboard and Business Setup both held a
 * signed-in session and neither offered a way to end it — only the platform
 * admin console did. That matters more here than it would on a personal
 * account: this runs on a counter PC that staff share, and the way to hand the
 * machine to the next person was to close the tab and hope, which leaves the
 * shop id sitting in localStorage for whoever opens it next.
 *
 * Both keys go. The token is the session; the shop context is who the session
 * was for, and leaving it behind means the next person at the counter opens
 * the dashboard already pointed at the last one's shop. The theme is not
 * touched: that is a preference belonging to the machine, not to whoever is
 * signed in.
 */
(function (global) {
  'use strict';

  const Session = {
    TOKEN_KEY: 'printok_merchant_token',
    CONTEXT_KEY: 'printok.shopContext',

    /** Wipes the session. Safe to call when there is nothing to wipe. */
    clear() {
      // Both stores. The token lives in localStorage now, so that a shop owner
      // is not signed out every time they close the browser — which makes this
      // button the way to hand a shared counter PC to the next person, rather
      // than closing the tab and hoping. sessionStorage is still cleared, to
      // catch a token left there by an older build.
      try { localStorage.removeItem(this.TOKEN_KEY); } catch { /* private browsing */ }
      try { sessionStorage.removeItem(this.TOKEN_KEY); } catch { /* private browsing */ }
      try { localStorage.removeItem(this.CONTEXT_KEY); } catch { /* private browsing */ }
    },

    /**
     * Signs out and lands on the dashboard's sign-in gate.
     *
     * Always a fresh navigation rather than re-rendering in place: a page that
     * has already drawn one shop's queue, earnings and printer keys should not
     * be the page the next person is handed.
     */
    signOut() {
      this.clear();
      global.location.href = '/dashboard';
    },

    /** Wires any #btnSignOut on the page. */
    init() {
      const btn = document.getElementById('btnSignOut');
      if (btn) btn.addEventListener('click', () => this.signOut());
    },
  };

  global.PrintOkSession = Session;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Session.init());
  } else {
    Session.init();
  }
})(window);
