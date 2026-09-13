const express = require('express');
const path = require('path');

/**
 * Local development server for the customer web app.
 *
 * PrintOk's frontend is a multi-page static site, not a single-page app: each
 * screen is its own HTML file and there is no client-side router. That matters
 * here, because this server used to end with
 *
 *     app.get('*', (_req, res) => res.sendFile('index.html'))
 *
 * which is the fallback an SPA needs and precisely the wrong thing for a
 * multi-page site. It answered *every* unknown path with the landing page and
 * HTTP 200, so:
 *
 *   * a mistyped or dead link looked like the homepage instead of a 404, and
 *     search engines indexed unlimited duplicate URLs (a soft 404);
 *   * a missing stylesheet or script returned an HTML page with 200, so the
 *     browser failed to parse it instead of reporting the file as absent —
 *     which turns a one-line typo into a silent, confusing breakage;
 *   * a relative fetch('/api/...') got the landing page with 200 rather than a
 *     404, so the client tried to JSON.parse a web page and reported a parse
 *     error instead of a missing endpoint.
 *
 * The routing below is deliberately explicit and mirrors vercel.json, so what a
 * developer sees locally is what production does.
 */

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Clean URL -> the file that serves it. Keep in step with vercel.json. */
const PAGES = {
  '/register': 'register.html',
  '/registration': 'register.html',
  '/print': 'print.html',
  '/admin': 'admin.html',
  '/dashboard': 'dashboard.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/refund': 'refund.html',
  '/example': 'example.html',
  '/404': '404.html',
};

app.use(express.static(PUBLIC_DIR));

for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, file)));
}

// Per-printer customer entry point, matching vercel.json's /p/:printerId.
app.get('/p/:printerId', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'print.html')));

/**
 * The API lives on its own origin (Render). Anything under /api here is a
 * misconfigured client, and it must be told so in the format it is expecting
 * rather than handed a web page — returning HTML to a fetch() is how a wrong
 * base URL turns into an unreadable "Unexpected token <" in the console.
 */
app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'The PrintOk API is not served from the web app. Point the client at the API origin.',
  });
});

/**
 * Genuine 404 for everything else: the not-found page, with a 404 status so
 * crawlers, monitoring and the browser all agree the page does not exist.
 */
app.use((_req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[PrintOk Web App] Listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
