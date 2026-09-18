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
      '/privacy', '/terms', '/refund', '/404', '/p/prn_example', '/setup',
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

    // Every cdnjs script is pinned by hash.
    for (const file of ['print.html', 'index.html']) {
      const html = read(file);
      const cdnScripts = html.match(/<script[^>]*cdnjs\.cloudflare\.com[^>]*>/g) || [];
      assert.ok(cdnScripts.length > 0, `${file} should load at least one CDN script`);
      for (const tag of cdnScripts) {
        assert.match(tag, /integrity="sha384-/, `${file} must pin: ${tag.slice(0, 80)}`);
        assert.match(tag, /crossorigin=/, `${file} needs crossorigin for SRI to apply`);
      }
    }

    // Razorpay's checkout.js is deliberately NOT pinned: they ship it
    // unversioned and update it in place, so a hash would break every payment
    // on their next deploy.
    const printHtml = read('print.html');
    const razorpayTag = printHtml.match(/<script[^>]*checkout\.razorpay\.com[^>]*>/)?.[0];
    assert.ok(razorpayTag, 'the payment page must load Razorpay Checkout');
    assert.ok(
      !razorpayTag.includes('integrity='),
      'Razorpay Checkout must stay unpinned, per their documented requirement'
    );
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

  await new Promise((resolve) => server.close(resolve));
});
