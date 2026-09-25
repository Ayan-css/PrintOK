const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../server');

/**
 * Routing contract for the customer web app.
 *
 * These exist because the server previously ended in a catch-all that answered
 * every unknown path with the landing page and HTTP 200 — an SPA fallback on a
 * site that is not an SPA. That is invisible in manual testing (the homepage
 * looks fine) and breaks three things at once: crawlers index unlimited
 * duplicate URLs, missing assets report as HTML instead of absent, and a
 * relative /api call gets a web page it then fails to parse.
 *
 * vercel.json is the production equivalent of the table below; when a route is
 * added to one it has to be added to the other, and these tests are what makes
 * a drift visible.
 */
test('customer web routing', async (t) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;

  const get = (path) => fetch(`${base}${path}`, { redirect: 'manual' });

  await t.test('the homepage loads', async () => {
    const res = await get('/');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  await t.test('every clean URL resolves to its page', async () => {
    // Direct navigation and a refresh are the same request to the server, so
    // this covers both: there is no client-side router to fall out of step.
    const routes = [
      '/register', '/registration', '/print', '/admin', '/dashboard',
      '/privacy', '/terms', '/refund', '/contact', '/404', '/p/prn_example', '/setup',
    ];

    for (const route of routes) {
      const res = await get(route);
      assert.strictEqual(res.status, 200, `${route} must load`);
      assert.match(res.headers.get('content-type'), /text\/html/, `${route} must be HTML`);
    }
  });

  await t.test('an unknown page is a real 404, not the landing page', async () => {
    const res = await get('/this-page-does-not-exist');
    assert.strictEqual(res.status, 404, 'the status must say not-found');

    const body = await res.text();
    assert.match(body, /Page not found/i, 'the not-found page must be served');
    assert.doesNotMatch(
      body,
      /Turn your shop into an instant print station/,
      'the landing page must not stand in for a missing page'
    );
  });

  await t.test('a missing asset is not answered with HTML', async () => {
    // The failure this prevents: a mistyped <link href> returns 200 text/html,
    // the browser cannot parse it as CSS, and nothing says the file is missing.
    const res = await get('/styles-that-do-not-exist.css');
    assert.strictEqual(res.status, 404);
  });

  await t.test('the SPA fallback does not swallow API calls', async () => {
    // The API is a separate origin. A relative call here is a misconfigured
    // client and must be told so as JSON, not handed a web page with 200.
    const res = await get('/api/health');
    assert.strictEqual(res.status, 404, 'an API path must not return the landing page');
    assert.match(res.headers.get('content-type'), /application\/json/);

    const body = await res.json();
    assert.ok(body.error, 'the client needs a parseable error, not HTML');
  });

  await t.test('real static assets are still served', async () => {
    const res = await get('/styles.css');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /css/);
  });

  await t.test('the dashboard and the setup page agree on storage keys', async () => {
    // app.js and setup.js are separate scripts with no shared module. When they
    // disagreed about the session key, the setup page showed "sign in to set up
    // your shop" to someone who had just signed in — and nothing anywhere said
    // why, because a missing key is indistinguishable from a missing session.
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

    const app = read('app.js');
    const setup = read('setup.js');

    const sessionKey = app.match(/KEY:\s*'([^']*merchant[^']*)'/)?.[1];
    assert.ok(sessionKey, 'app.js must define a merchant session key');
    assert.ok(
      setup.includes(`'${sessionKey}'`),
      `setup.js must read the same session key as app.js ('${sessionKey}')`
    );

    const contextKey = app.match(/localStorage\.getItem\('([^']*shopContext[^']*)'\)/)?.[1];
    assert.ok(contextKey, 'app.js must define a shop context key');
    assert.ok(
      setup.includes(`'${contextKey}'`),
      `setup.js must read the same shop context key as app.js ('${contextKey}')`
    );
  });

  await t.test('the merchant session survives a browser restart, the admin one does not', async () => {
    // A shop owner signed in again every morning because both merchant scripts
    // kept the token in sessionStorage, which the browser discards on close —
    // the token itself was usually still valid. Moving one file and not the
    // other would sign people out of exactly one screen, so both are asserted.
    //
    // The admin console is deliberately the other way round: its token shows
    // every shop's revenue and should die with the tab.
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

    const app = read('app.js');
    const setup = read('setup.js');
    const admin = read('admin.js');

    const sessionKey = app.match(/KEY:\s*'([^']*merchant[^']*)'/)?.[1];
    assert.ok(sessionKey, 'app.js must define a merchant session key');

    for (const [name, source] of [['app.js', app], ['setup.js', setup]]) {
      assert.match(
        source,
        /localStorage\.getItem\(\s*(this\.KEY|SESSION_KEY|'printok_merchant_token')/,
        `${name} must read the merchant token from localStorage, or the session dies with the browser`
      );
      assert.match(
        source,
        /localStorage\.setItem\(\s*(this\.KEY|SESSION_KEY|'printok_merchant_token')/,
        `${name} must persist the merchant token to localStorage`
      );
    }

    // And the renewed-token header is honoured, or a long session still lapses
    // mid-use however it is stored.
    for (const [name, source] of [['app.js', app], ['setup.js', setup]]) {
      assert.ok(
        source.includes('x-printok-session-renewed'),
        `${name} must adopt a server-renewed session token`
      );
    }

    assert.ok(
      !admin.includes('localStorage.setItem'),
      'the admin console token must stay in sessionStorage'
    );
  });

  await t.test('the money screen invents no prices or payout destinations', async () => {
    // The subscription tiles were hardcoded at "₹149 Starter" and "₹299
    // Growth" with commission rates to match — none of which exist in
    // PLAN_CATALOGUE, which is 8% / ₹79 / ₹249 / ₹599. Real shops were shown
    // invented terms. The payout box likewise hardcoded someone's UPI id.
    const fs = require('fs');
    const path = require('path');
    const dashboard = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8'
    );

    // Strip HTML comments: this file explains the bug it fixed, and that
    // explanation necessarily names the values it removed.
    const markup = dashboard.replace(/<!--[\s\S]*?-->/g, '');

    assert.ok(
      !/metroprint@upi/.test(markup),
      'the payout box must not hardcode a UPI id'
    );

    for (const invented of ['₹149', '₹299', 'Starter Plan', 'Growth Plan']) {
      assert.ok(
        !markup.includes(invented),
        `the money screen must not hardcode '${invented}' — plan figures come from /plan`
      );
    }

    // And the containers the real figures are rendered into must exist.
    // settlementNotice, not a second explanation inside the payout card: the
    // screen briefly carried both, saying the same thing in two wordings.
    for (const id of ['planOptions', 'planCurrentBadge', 'settlementNotice', 'settlementBadge', 'payoutDetailsForm']) {
      assert.ok(markup.includes(`id="${id}"`), `dashboard.html must contain #${id}`);
    }
  });

  await t.test('security headers are served, and the payment page pins its CDN scripts', async () => {
    // A CDN response with no integrity attribute executes with full origin
    // privileges on the page where customers upload documents and authorise
    // payment, and the browser cannot tell it from the real thing.
    const res = await fetch(`${base}/print`);
    assert.strictEqual(res.status, 200);

    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.ok(res.headers.get('x-frame-options'), 'an anti-framing header must be present');

    // Report-Only for now: five pages carry an inline <script> and static
    // hosting cannot mint a nonce, so enforcing it needs one live checkout to
    // confirm the payment path is clean first.
    const csp = res.headers.get('content-security-policy-report-only');
    assert.ok(csp, 'a policy must be reported even before it is enforced');
    assert.match(csp, /checkout\.razorpay\.com/, 'Razorpay Checkout must be allowed to load');
    assert.match(csp, /object-src 'none'/);

    // Merchant screens are never framed.
    const dash = await fetch(`${base}/dashboard`);
    assert.strictEqual(dash.headers.get('x-frame-options'), 'DENY');

    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

    // Every cdnjs script in markup is pinned by hash.
    for (const file of ['index.html']) {
      const html = read(file);
      const cdnScripts = html.match(/<script[^>]*cdnjs\.cloudflare\.com[^>]*>/g) || [];
      assert.ok(cdnScripts.length > 0, `${file} should load at least one CDN script`);
      for (const tag of cdnScripts) {
        assert.match(tag, /integrity="sha384-/, `${file} must pin: ${tag.slice(0, 80)}`);
        assert.match(tag, /crossorigin=/, `${file} needs crossorigin for SRI to apply`);
      }
    }

    // The payment page loads neither pdf.js nor Razorpay in its head any more:
    // both used to be render-blocking there, on the one page opened on a phone
    // by someone who has just scanned a QR code. They are fetched when they are
    // actually needed instead.
    const printHtml = read('print.html');
    assert.ok(
      !/<script[^>]*src="https?:\/\//.test(printHtml),
      'the payment page must not block first paint on a third-party script'
    );
    assert.match(printHtml, /<script src="\/app\.js" defer><\/script>/,
      'and its own script must not block parsing either');

    // Lazily loaded is not less worth verifying: pdf.js keeps its hash.
    const app = read('app.js');
    const pinned = app.match(/PDFJS_INTEGRITY\s*=\s*'(sha384-[^']+)'/)?.[1];
    assert.ok(pinned, 'app.js must pin pdf.js by content hash when it loads it');

    // Razorpay's checkout.js is deliberately NOT pinned: they ship it
    // unversioned and update it in place, so a hash would break every payment
    // on their next deploy.
    const razorpayLoad = app.match(/loadScript\('https:\/\/checkout\.razorpay\.com[^)]*\)/)?.[0];
    assert.ok(razorpayLoad, 'app.js must load Razorpay Checkout when paying');
    assert.ok(
      !razorpayLoad.includes('integrity'),
      'Razorpay Checkout must stay unpinned, per their documented requirement'
    );
  });

  await t.test('the deployed config carries the headers, not only the dev server', async () => {
    // The test above passes against server.js, which sets these headers
    // correctly. Production does not run server.js — Vercel serves the static
    // files and reads vercel.json — so for one deploy the suite was green while
    // the live site sent no security headers at all, and the merchant dashboard
    // was framable by anyone.
    //
    // The cause was two config files: the repo root carried the headers and
    // apps/customer-web/vercel.json, the one Vercel actually reads because that
    // is the project root, did not. Nothing compared them, so nothing noticed.
    //
    // This asserts the deployed file itself. It cannot catch a wrong Vercel
    // project setting, but it catches the headers going missing from the config
    // that setting points at.
    const fs = require('fs');
    const path = require('path');
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8')
    );

    const headerRoutes = (config.routes || []).filter(
      (r) => r.headers && r.headers['X-Frame-Options']
    );
    assert.ok(headerRoutes.length >= 2,
      'vercel.json must set security headers; the dev server agreeing is not enough');

    // Every header route must continue, or it answers the request itself and
    // the page is never served.
    for (const route of headerRoutes) {
      assert.strictEqual(route.continue, true,
        `${route.src} sets headers and must fall through to the route that serves the page`);
    }

    // The privileged rule targets the merchant screens; the general rule is the
    // one that excludes them by lookahead.
    const privileged = headerRoutes.find((r) => !/\(\?!/.test(r.src) && /dashboard/.test(r.src));
    const general = headerRoutes.find((r) => /\(\?!/.test(r.src));

    assert.ok(privileged, 'the merchant screens need their own rule');
    assert.strictEqual(privileged.headers['X-Frame-Options'], 'DENY',
      'nothing legitimately frames the dashboard or admin screens (setup is framed by the dashboard)');

    assert.ok(general, 'the remaining pages need a rule too');
    assert.strictEqual(general.headers['X-Frame-Options'], 'SAMEORIGIN');

    // The two patterns must not overlap, or which one wins depends on how
    // Vercel merges headers across matching routes — and the answer would be
    // "whichever, silently".
    assert.match(general.src, /\(\?!/,
      'the general rule must exclude the privileged paths by negative lookahead');

    // Both rules carry the full set, since a route that matches sets only its
    // own headers.
    for (const route of headerRoutes) {
      for (const key of [
        'X-Content-Type-Options',
        'Referrer-Policy',
        'Permissions-Policy',
        'Content-Security-Policy-Report-Only',
      ]) {
        assert.ok(route.headers[key], `${route.src} is missing ${key}`);
      }
      assert.strictEqual(route.headers['X-Content-Type-Options'], 'nosniff');
      assert.match(route.headers['Content-Security-Policy-Report-Only'],
        /checkout\.razorpay\.com/, 'Razorpay Checkout must still be able to load');
      assert.match(route.headers['Content-Security-Policy-Report-Only'], /object-src 'none'/);
    }

    // Legacy `routes` and modern `headers`/`rewrites` are mutually exclusive in
    // Vercel: a top-level `headers` key alongside `routes` fails the build, so
    // the obvious fix is the one that does not deploy.
    assert.ok(!config.headers,
      'a top-level headers key cannot be combined with routes — Vercel rejects it');
  });

  await t.test('a locked-out owner can actually reach the recovery flow', async () => {
    // The endpoints for this were built, tested and deployed, email delivery
    // was confirmed to a real inbox, and the whole thing was still unusable:
    // there was no "forgot password" link anywhere, and nothing read the
    // ?reset= token the emailed link carries. The API being right is not the
    // same as a person being able to reach it, and only this end catches that.
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

    const dashboard = read('dashboard.html');
    const app = read('app.js');

    // A way in from the sign-in screen.
    assert.match(dashboard, /id="linkForgotPassword"/,
      'the sign-in screen needs a way to start a password reset');
    assert.match(dashboard, /id="formForgotPassword"/);

    // And a way to finish, which is the half that was missing entirely.
    assert.match(dashboard, /id="formResetPassword"/,
      'the emailed link needs somewhere to land that can set a new password');

    // Both endpoints are actually called.
    assert.match(app, /password-reset\/request/, 'nothing requested a reset link');
    assert.match(app, /password-reset\/confirm/, 'nothing spent the reset token');

    // The token arrives as /dashboard?reset=<token>; without this read, the
    // link lands on the sign-in page and silently appears to do nothing.
    assert.match(app, /URLSearchParams\(window\.location\.search\)\.get\('reset'\)/,
      'the reset token in the emailed link must be read from the URL');

    // Spent tokens do not belong in browser history or in a screenshot.
    assert.match(app, /history\.replaceState/,
      'the used token should be stripped from the address bar');
  });

  await t.test('a merchant can sign out, and signing out clears the whole session', async () => {
    // There was no sign-out at all on either merchant page: the way to hand a
    // shared counter PC to the next person was to close the tab. This checks
    // both that the button exists and that it clears every key the session is
    // actually made of — a sign-out that leaves the shop context behind points
    // the next person at the previous shop.
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

    const app = read('app.js');
    const session = read('session.js');

    const sessionKey = app.match(/KEY:\s*'([^']*merchant[^']*)'/)?.[1];
    const contextKey = app.match(/localStorage\.getItem\('([^']*shopContext[^']*)'\)/)?.[1];

    for (const key of [sessionKey, contextKey]) {
      assert.ok(
        session.includes(`'${key}'`),
        `session.js must clear '${key}' or a stale session survives sign-out`
      );
    }
    assert.match(session, /removeItem/, 'session.js must actually remove the keys');
    // The theme belongs to the machine, not the person signed in.
    assert.doesNotMatch(session, /removeItem\(['"`]?printok\.theme/);

    for (const page of ['dashboard.html', 'setup.html']) {
      const html = read(page);
      assert.match(html, /id="btnSignOut"/, `${page} needs a sign-out control`);
      assert.match(html, /src="\/session\.js"/, `${page} must load session.js`);
    }
  });

  // -------------------------------------------------------------------------
  // Marketplace transparency (Razorpay payer–payee disclosure)
  // -------------------------------------------------------------------------

  const fs = require('fs');
  const path = require('path');
  const readPublic = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

  await t.test('the ordering page names the shop, the fee and the total before payment', async () => {
    const markup = stripComments(readPublic('print.html'));

    // The shop identity card, filled from the API.
    assert.match(markup, /id="shopIdentityCard"/);
    assert.match(markup, /You are ordering from/);
    assert.match(markup, /Fulfils your order/);
    assert.match(markup, /Ordering and payments by PrintOk/);

    // The review box sits before the pay buttons and answers the four questions.
    const review = markup.indexOf('id="orderReview"');
    const payButton = markup.indexOf('id="btnPayRazorpay"');
    assert.ok(review > 0 && payButton > review, 'the review must come immediately before the pay buttons');
    const box = markup.slice(review, payButton);
    for (const text of ['Shop', 'Fulfilled by', 'Printing charge', 'PrintOk fee to you', 'Total payable']) {
      assert.ok(box.includes(text), `the review must show '${text}'`);
    }
    assert.match(box, /PrintOk fee to you<\/span>\s*<strong>₹0\.00<\/strong>/);
    assert.match(box, /PrintOk's service fee is paid by the shop and\s+is not added to your bill/);
    assert.match(box, /href="\/terms"/);
    assert.match(box, /href="\/refund"/);

    // No shop name or amount is written into the page itself.
    assert.doesNotMatch(markup, /PrintOk Shop/);
  });

  await t.test('no invented rates, no dead demo printer, no PrintOk-as-printer wording', async () => {
    const markup = stripComments(readPublic('print.html'));
    assert.doesNotMatch(markup, /Standard Printing Rates/);
    assert.doesNotMatch(markup, /prn_test/);
    for (const price of ['₹2.00', '₹1.50', '₹10.00', '₹8.00']) {
      assert.ok(!markup.includes(price), `print.html must not hardcode ${price}`);
    }
    for (const page of ['print.html', 'index.html', 'register.html', '404.html']) {
      const html = stripComments(readPublic(page));
      for (const phrase of [/Instant Mobile Printing/i, /Hardware-Free Printing/i, /prints automatically/i,
                            /PrintOk never holds/i, /instant direct payments/i]) {
        assert.doesNotMatch(html, phrase, `${page} must not say ${phrase}`);
      }
    }
    const app = readPublic('app.js');
    assert.doesNotMatch(app, /'PrintOk Shop'/, 'a missing shop must not be shown as a PrintOk shop');
    assert.match(app, /Print order from \$\{payeeName\}, via PrintOk/, 'checkout names the shop');
  });

  await t.test('the ordering page links every policy and names the operator', async () => {
    const markup = stripComments(readPublic('print.html'));
    const footer = markup.slice(markup.indexOf('<footer'));
    for (const href of ['/terms', '/privacy', '/refund', '/contact']) {
      assert.ok(footer.includes(`href="${href}"`), `the ordering page footer must link ${href}`);
      const res = await get(href);
      assert.strictEqual(res.status, 200, `${href} must load`);
    }
    assert.match(footer, /PrintOk is operated by Mohd Ayan Nasruddin Ansari, trading as BitWise/);
  });

  await t.test('one real support address, everywhere, and no placeholder', async () => {
    const config = readPublic('site-config.js');
    const email = (config.match(/email:\s*'([^']+)'/) || [])[1];
    assert.ok(email && !/example\.com/.test(email), 'site-config.js must hold a real address');
    for (const page of ['terms.html', 'privacy.html', 'contact.html']) {
      assert.ok(readPublic(page).includes(email), `${page} must publish the same support address`);
    }
    for (const file of ['index.html', 'landing.js', 'print.html', 'contact.html']) {
      assert.doesNotMatch(readPublic(file), /your-support-address@example\.com|not monitored/i, `${file} must not show a placeholder`);
    }
    assert.match(readPublic('landing.js'), /PRINTOK_SUPPORT/, 'the landing page reads the shared config');
  });

  await t.test('the design mock-up is not on the public site', async () => {
    const res = await get('/example');
    assert.strictEqual(res.status, 404);
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'example.html')));
  });

  await t.test('shop sign-up requires accepting the Terms', async () => {
    const register = stripComments(readPublic('register.html'));
    assert.match(register, /id="regAcceptTerms"[^>]*required/);
    assert.match(register, /href="\/terms"/);
    assert.match(readPublic('app.js'), /acceptTerms:/);
  });

  await new Promise((resolve) => server.close(resolve));
});
