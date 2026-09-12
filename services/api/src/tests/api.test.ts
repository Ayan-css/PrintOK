import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PLAN_CATALOGUE, PAYMENT_GATEWAY_FEE_BPS, calculateShopNetCents } from '@printok/shared-types';

// Webhook signatures are verified for real now, so the suite signs its own
// payloads rather than relying on a bypass string.
const TEST_WEBHOOK_SECRET = 'printok_test_webhook_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

// This suite imports ../app directly rather than booting the server, so it
// deliberately never loads .env and never touches real credentials. That also
// means it gets no JWT_SECRET, and without one every route that issues or
// checks a session answers 500 — which silently disabled the merchant and admin
// coverage below: those tests were asserting against error responses rather
// than the behaviour they describe.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'printok_test_jwt_secret_key';

/** Signs the exact bytes that will be sent, as Razorpay does. */
function signWebhook(rawBody: string): string {
  return crypto.createHmac('sha256', TEST_WEBHOOK_SECRET).update(rawBody).digest('hex');
}
import http from 'http';
import { createApp } from '../app';
import { MemoryStorage } from '../storage';
import { PrintState, PaymentState } from '@printok/shared-types';

test('PrintOk API Endpoints Integration Test', async (t) => {
  const storage = new MemoryStorage();
  const app = createApp(storage);
  
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://localhost:${address.port}`;

  let createdPrinterId = '';
  let createdShopId = '';
  let agentApiKey = '';
  let createdJobId = '';
  let merchantToken = '';
  let merchantAuth: Record<string, string> = {};

  await t.test('1. Shop Registration Endpoint generates QR code & Printer API Key', async () => {
    const res = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Metro Copy Center',
        ownerEmail: 'owner@metrocopy.com',
        printerName: 'Canon ImageRUNNER 2525',
      }),
    });

    assert.strictEqual(res.status, 201);
    const data = (await res.json()) as any;
    assert.ok(data.shop.id);
    assert.strictEqual(data.shop.name, 'Metro Copy Center');
    assert.ok(data.printer.id);
    assert.ok(data.printer.qrCodeDataUrl.startsWith('data:image/png;base64,') || data.printer.qrCodeDataUrl.startsWith('data:image/svg+xml;base64,'));
    assert.ok(data.printer.apiKey.startsWith('prn_key_'));

    createdPrinterId = data.printer.id;
    createdShopId = data.shop.id;
    agentApiKey = data.printer.apiKey;
  });

  await t.test('1b. The shop owner claims an account and gets a session', async () => {
    const res = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: createdShopId,
        ownerEmail: 'owner@metrocopy.com',
        password: 'ShopOwner99xy',
        name: 'Metro Owner',
      }),
    });
    assert.strictEqual(res.status, 201);

    const body = (await res.json()) as any;
    assert.strictEqual(body.user.shopId, createdShopId);
    assert.strictEqual(body.user.role, 'owner');
    assert.ok(!('passwordHash' in body.user), 'the hash must never leave the server');

    merchantToken = body.token;
    merchantAuth = { Authorization: `Bearer ${merchantToken}`, 'Content-Type': 'application/json' };

    // A shop can only be claimed once.
    const again = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: createdShopId, ownerEmail: 'owner@metrocopy.com', password: 'Attacker99xy',
      }),
    });
    assert.strictEqual(again.status, 409);
  });

  await t.test('2. Customer Creates Print Job linked to Printer QR (Server Tamper-Proof Verification)', async () => {
    const samplePdfBase64 = Buffer.from('%PDF-1.4 sample pdf content').toString('base64');
    
    const res = await fetch(`${baseUrl}/api/print-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId,
        fileName: 'resume.pdf',
        fileBase64: samplePdfBase64,
        pageCount: 3, // Client tried submitting 3, server overrides with verified 1
        copies: 1,
        isColor: false,
      }),
    });

    assert.strictEqual(res.status, 201);
    const data = (await res.json()) as any;
    assert.ok(data.job.id);
    assert.strictEqual(data.job.printState, PrintState.Queued);
    assert.strictEqual(data.job.pageCount, 1); // Tamper-proof server override
    assert.strictEqual(data.job.totalPriceInCents, 200); // 1 page * 200 cents

    createdJobId = data.job.id;
  });

  await t.test('3. Windows Agent Polls Pending Jobs with Authorized API Key', async () => {
    const res = await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': agentApiKey },
    });

    assert.strictEqual(res.status, 200);
    const data = (await res.json()) as any;
    assert.strictEqual(data.jobs.length, 1);
    assert.strictEqual(data.jobs[0].id, createdJobId);

    // Polling claims the job for the calling device rather than just flipping it
    // to Downloading, so a second agent cannot pick up the same work.
    const checkRes = await fetch(`${baseUrl}/api/print-jobs/${createdJobId}`);
    const checkData = (await checkRes.json()) as any;
    assert.strictEqual(checkData.job.printState, PrintState.Assigned);
    assert.ok(checkData.job.deviceId, 'claimed job must record the owning device');

    // A second poll must not hand the same job out again.
    const secondPoll = await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': agentApiKey },
    });
    const secondData = (await secondPoll.json()) as any;
    assert.strictEqual(secondData.jobs.length, 0, 'an assigned job must not be re-issued');
  });

  await t.test('4. Windows Agent Updates Job Status to Printed and Completed', async () => {
    const report = (printState: PrintState) =>
      fetch(`${baseUrl}/api/agent/jobs/${createdJobId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-api-key': agentApiKey },
        body: JSON.stringify({ jobId: createdJobId, printState }),
      });

    // Mirrors the real agent sequence: report Printing, spool, then Completed.
    const printingRes = await report(PrintState.Printing);
    assert.strictEqual(printingRes.status, 200);

    const res = await report(PrintState.Completed);
    assert.strictEqual(res.status, 200);
    const data = (await res.json()) as any;
    assert.strictEqual(data.job.printState, PrintState.Completed);
    assert.ok(data.job.completedAt, 'completedAt must be stamped');

    // Completed is terminal: a replayed or late report must be refused, not
    // silently accepted as a second print (PRD 11).
    const replay = await report(PrintState.Printing);
    assert.strictEqual(replay.status, 409);
  });

  await t.test('5. Payment Webhook confirms pending job & triggers queue state', async () => {
    const samplePdfBase64 = Buffer.from('%PDF-1.4 payment test').toString('base64');
    
    // Create job with autoApprove=false
    const createRes = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId,
        fileName: 'invoice.pdf',
        fileBase64: samplePdfBase64,
        pageCount: 2,
        copies: 1,
        isColor: true,
      }),
    });

    assert.strictEqual(createRes.status, 201);
    const createData = (await createRes.json()) as any;
    const pendingJobId = createData.job.id;
    assert.strictEqual(createData.job.printState, PrintState.AwaitingPayment);

    // Call Payment Webhook
    const webhookRaw = JSON.stringify({
      paymentId: 'pay_9988776655',
      jobId: pendingJobId,
      amountInCents: 2000,
    });

    const webhookRes = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(webhookRaw) },
      body: webhookRaw,
    });

    assert.strictEqual(webhookRes.status, 200);
    const webhookData = (await webhookRes.json()) as any;
    assert.strictEqual(webhookData.success, true);
    assert.strictEqual(webhookData.job.printState, PrintState.Queued);
  });

  await t.test('6. Multi-Format Upload (Image & Word Document)', async () => {
    const pngBase64 = Buffer.from('fake_png_data').toString('base64');
    
    // Image upload (PNG) -> should verify as 1 page
    const imgRes = await fetch(`${baseUrl}/api/print-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId,
        fileName: 'aadhaar_card.png',
        fileBase64: pngBase64,
        copies: 2,
        isColor: true,
      }),
    });

    assert.strictEqual(imgRes.status, 201);
    const imgData = (await imgRes.json()) as any;
    assert.strictEqual(imgData.job.pageCount, 1);
    assert.strictEqual(imgData.job.totalPriceInCents, 2000); // 1 page * 2 copies * 1000 cents (Color)

    // Unsupported format upload (.exe) -> should fail
    const badRes = await fetch(`${baseUrl}/api/print-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId,
        fileName: 'virus.exe',
        fileBase64: pngBase64,
        copies: 1,
        isColor: false,
      }),
    });

    assert.strictEqual(badRes.status, 400);
  });

  await t.test('7. Token Generation (#001 sequence), Duplex Pricing, & Manual Override', async () => {
    const samplePdfBase64 = Buffer.from('%PDF-1.4 token test').toString('base64');
    
    // Create job with isDuplex: true
    const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId,
        fileName: 'duplex_doc.pdf',
        fileBase64: samplePdfBase64,
        copies: 1,
        isColor: false,
        isDuplex: true,
      }),
    });

    assert.strictEqual(res.status, 201);
    const data = (await res.json()) as any;
    assert.ok(data.job.tokenNumber);
    assert.strictEqual(data.job.tokenNumber, '#004'); // Previous tests created #001, #002, #003
    assert.strictEqual(data.job.totalPriceInCents, 150); // B&W Duplex = 150 cents per page

    // Manual Override Endpoint
    const overrideRes = await fetch(`${baseUrl}/api/print-jobs/${data.job.id}/manual-override`, {
      method: 'POST',
    });
    assert.strictEqual(overrideRes.status, 200);
    const overrideData = (await overrideRes.json()) as any;
    assert.strictEqual(overrideData.job.printState, PrintState.Queued);
  });

  await t.test('8. Agent Heartbeat & Telemetry Status', async () => {
    // Send Agent Heartbeat
    const heartbeatRes = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-api-key': agentApiKey,
      },
      body: JSON.stringify({ paperStatus: 'OK' }),
    });

    assert.strictEqual(heartbeatRes.status, 200);
    const hbData = (await heartbeatRes.json()) as any;
    assert.strictEqual(hbData.telemetry.isOnline, true);
    assert.strictEqual(hbData.telemetry.paperStatus, 'OK');

    // Fetch Printer Telemetry via Public API
    const telemRes = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/telemetry`);
    assert.strictEqual(telemRes.status, 200);
    const telemData = (await telemRes.json()) as any;
    assert.strictEqual(telemData.isOnline, true);
  });

  await t.test('9. Shop Pricing Matrix CRUD & Shop Stats', async () => {
    const pricingRes = await fetch(`${baseUrl}/api/shops/${createdShopId}/pricing`, { headers: merchantAuth });
    assert.strictEqual(pricingRes.status, 200);
    const pricingData = (await pricingRes.json()) as any;
    assert.strictEqual(pricingData.pricing.bwSinglePerPageCents, 200);

    const updateRes = await fetch(`${baseUrl}/api/shops/${createdShopId}/pricing`, {
      method: 'POST',
      headers: merchantAuth,
      body: JSON.stringify({ bwSinglePerPageCents: 300, colorSinglePerPageCents: 1200 }),
    });
    assert.strictEqual(updateRes.status, 200);
    const updatedData = (await updateRes.json()) as any;
    assert.strictEqual(updatedData.pricing.bwSinglePerPageCents, 300);
    assert.strictEqual(updatedData.pricing.colorSinglePerPageCents, 1200);

    const statsRes = await fetch(`${baseUrl}/api/shops/${createdShopId}/stats`, { headers: merchantAuth });
    assert.strictEqual(statsRes.status, 200);
    assert.ok(((await statsRes.json()) as any).stats);
  });

  await t.test('9b. Shop data is not readable without the right account', async () => {
    // These endpoints were entirely unauthenticated before merchant accounts:
    // anyone who knew a shop id could read its revenue and payout details,
    // change its prices, or trigger a withdrawal.
    const openPaths = [
      `/api/shops/${createdShopId}/pricing`,
      `/api/shops/${createdShopId}/stats`,
      `/api/shops/${createdShopId}/jobs`,
      `/api/shops/${createdShopId}/payout-summary`,
    ];

    for (const path of openPaths) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.strictEqual(res.status, 401, `${path} must require a session`);
    }

    const withdraw = await fetch(`${baseUrl}/api/shops/${createdShopId}/withdraw`, { method: 'POST' });
    assert.strictEqual(withdraw.status, 401, 'withdrawal must require a session');

    // A second shop, with its own owner.
    const other = await fetch(`${baseUrl}/api/merchant/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Rival Prints', ownerEmail: 'rival@example.com',
        printerName: 'HP', password: 'RivalOwner99xy',
      }),
    });
    assert.strictEqual(other.status, 201);
    const rival = (await other.json()) as any;

    // A valid session for one shop must not reach another shop's data.
    const crossShop = await fetch(`${baseUrl}/api/shops/${createdShopId}/payout-summary`, {
      headers: { Authorization: `Bearer ${rival.token}` },
    });
    assert.strictEqual(crossShop.status, 403, 'one shop must not read another');
  });

  await t.test('10. Agent Installer Endpoint redirects to release binary', async () => {
    const res = await fetch(`${baseUrl}/api/agent-installer`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location && location.includes('github.com'));

    const zipRes = await fetch(`${baseUrl}/api/agent-installer?format=zip`, { redirect: 'manual' });
    assert.strictEqual(zipRes.status, 302);
    const zipLocation = zipRes.headers.get('location');
    assert.ok(zipLocation && zipLocation.endsWith('PrintAgent-win-x64.zip'));
  });

  await t.test('12. Agent pairing issues a device-scoped token that can be revoked', async () => {
    // 1. Merchant generates a short-lived pairing code.
    const codeRes = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/pairing-code`, {
      method: 'POST',
    });
    assert.strictEqual(codeRes.status, 201);
    const { code } = (await codeRes.json()) as any;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'code must be human-transcribable');

    // 2. The shop PC exchanges it for its own token.
    const pairRes = await fetch(`${baseUrl}/api/agent/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingCode: code.toLowerCase(),   // normalisation must accept this
        deviceName: 'SHOP-PC-01',
        osVersion: 'Windows 11',
        agentVersion: '1.2.0',
      }),
    });
    assert.strictEqual(pairRes.status, 201);
    const paired = (await pairRes.json()) as any;
    assert.ok(paired.deviceToken.startsWith('dvt_'));
    assert.ok(paired.deviceId.startsWith('dev_'));
    assert.strictEqual(paired.printerId, createdPrinterId);

    const deviceHeaders = { 'x-agent-device-token': paired.deviceToken };

    // 3. The token authenticates agent endpoints.
    const beat = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders },
      body: JSON.stringify({ paperStatus: 'OK' }),
    });
    assert.strictEqual(beat.status, 200);

    // 4. A pairing code is single use.
    const replay = await fetch(`${baseUrl}/api/agent/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: code }),
    });
    assert.strictEqual(replay.status, 401, 'a used pairing code must not pair a second machine');

    // 5. Revoking one device must not affect the printer's other credentials.
    const revoke = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/devices/${paired.deviceId}/revoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Shop PC replaced' }),
      }
    );
    assert.strictEqual(revoke.status, 200);

    const afterRevoke = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deviceHeaders },
      body: JSON.stringify({ paperStatus: 'OK' }),
    });
    assert.strictEqual(afterRevoke.status, 401, 'a revoked device must lose access immediately');

    // The legacy printer key still works, so revocation is genuinely scoped.
    const legacyStillWorks = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-api-key': agentApiKey },
      body: JSON.stringify({ paperStatus: 'OK' }),
    });
    assert.strictEqual(legacyStillWorks.status, 200);

    // 6. Everything above is auditable.
    const auditRes = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/security-events`);
    const { events } = (await auditRes.json()) as any;
    const types = events.map((e: any) => e.type);
    assert.ok(types.includes('PAIRED'), 'pairing must be audited');
    assert.ok(types.includes('REVOKED'), 'revocation must be audited');
    assert.ok(types.includes('LEGACY_KEY_USED'), 'shared-key use must be flagged');
  });

  await t.test('14. Admin console: bootstrap, login and authorization', async () => {
    // The console is unclaimed until the first operator is created.
    const status = await fetch(`${baseUrl}/api/admin/status`);
    assert.deepStrictEqual(await status.json(), { needsBootstrap: true });

    // Weak passwords are refused outright.
    const weak = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'short' }),
    });
    assert.strictEqual(weak.status, 400);

    const boot = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Ops@PrintOk.test', password: 'CorrectHorse99x', name: 'Ops' }),
    });
    assert.strictEqual(boot.status, 201);
    const { token, user } = (await boot.json()) as any;
    assert.strictEqual(user.email, 'ops@printok.test', 'email must be normalised');
    assert.strictEqual(user.role, 'owner');
    assert.ok(!('passwordHash' in user), 'the password hash must never leave the server');

    // Bootstrap closes permanently once an operator exists.
    const second = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@evil.test', password: 'CorrectHorse99x' }),
    });
    assert.strictEqual(second.status, 409, 'bootstrap must not create a second admin');

    // Admin data is not readable without a token.
    const anon = await fetch(`${baseUrl}/api/admin/overview`);
    assert.strictEqual(anon.status, 401);

    const forged = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: 'Bearer not.a.token' },
    });
    assert.strictEqual(forged.status, 401);

    // A token with a tampered payload must fail signature verification.
    const [h, , sig] = token.split('.');
    const evil = Buffer.from(JSON.stringify({
      sub: 'adm_x', email: 'x@x', role: 'owner',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const tampered = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${h}.${evil}.${sig}` },
    });
    assert.strictEqual(tampered.status, 401, 'a re-signed payload must be rejected');

    const auth = { Authorization: `Bearer ${token}` };

    const overviewRes = await fetch(`${baseUrl}/api/admin/overview`, { headers: auth });
    assert.strictEqual(overviewRes.status, 200);
    const { overview } = (await overviewRes.json()) as any;
    assert.ok(overview.totalShops >= 1);
    assert.ok('commissionCents' in overview);

    const shopsRes = await fetch(`${baseUrl}/api/admin/shops`, { headers: auth });
    const { shops } = (await shopsRes.json()) as any;
    assert.ok(shops.length >= 1);
    assert.strictEqual(shops[0].plan.planTier, 'start', 'new shops default to the entry tier');
    assert.strictEqual(shops[0].plan.commissionBps, 800);

    // Login works with the stored hash, and is case-insensitive on email.
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'OPS@printok.test', password: 'CorrectHorse99x' }),
    });
    assert.strictEqual(login.status, 200);

    // Admin and merchant sessions share a signing secret, so the audience claim
    // is the only thing stopping one from authenticating the other.
    const asMerchant = await fetch(`${baseUrl}/api/shops/${createdShopId}/stats`, { headers: auth });
    assert.strictEqual(asMerchant.status, 401, 'an admin token is not a merchant token');

    const asAdmin = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
    });
    assert.strictEqual(asAdmin.status, 401, 'a merchant token is not an admin token');

    const badLogin = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'WrongPassword1' }),
    });
    assert.strictEqual(badLogin.status, 401);
    const badBody = (await badLogin.json()) as any;
    assert.strictEqual(badBody.error, 'Incorrect email or password.',
      'the message must not reveal whether the account exists');
  });

  await t.test('15. Admin can change a shop plan, within guard rails', async () => {
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    });
    const { token } = (await login.json()) as any;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const shopsRes = await fetch(`${baseUrl}/api/admin/shops`, { headers: auth });
    const { shops } = (await shopsRes.json()) as any;
    const shopId = shops[0].shop.id;

    const ok = await fetch(`${baseUrl}/api/admin/shops/${shopId}/plan`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ planTier: 'business', commissionBps: 250 }),
    });
    assert.strictEqual(ok.status, 200);
    const { plan } = (await ok.json()) as any;
    assert.strictEqual(plan.planTier, 'business');
    assert.strictEqual(plan.commissionBps, 250);

    // A typo must not be able to charge a shop everything it earns.
    const absurd = await fetch(`${baseUrl}/api/admin/shops/${shopId}/plan`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ commissionBps: 10000 }),
    });
    assert.strictEqual(absurd.status, 400, 'commission above 50% must be refused');

    const unknownTier = await fetch(`${baseUrl}/api/admin/shops/${shopId}/plan`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ planTier: 'platinum' }),
    });
    assert.strictEqual(unknownTier.status, 400);

    // Moving tier without naming a fee adopts that tier's published rate, so a
    // shop is never left paying its old rate on a new plan.
    const moved = await fetch(`${baseUrl}/api/admin/shops/${shopId}/plan`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ planTier: 'enterprise' }),
    });
    assert.strictEqual(moved.status, 200);
    const movedPlan = ((await moved.json()) as any).plan;
    assert.strictEqual(movedPlan.planTier, 'enterprise');
    assert.strictEqual(movedPlan.commissionBps, 50, 'Enterprise publishes a 0.5% fee');
  });

  await t.test('16. Cash jobs wait for the shop, and are not auto-approved', async () => {
    const pdf = Buffer.from('%PDF-1.4 cash flow test').toString('base64');

    // This is what the "Pay Cash at Counter" button now sends.
    const createRes = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId, fileName: 'cash.pdf', fileBase64: pdf,
        pageCount: 1, copies: 1, isColor: false,
      }),
    });
    const { job } = (await createRes.json()) as any;

    // Previously the cash button sent autoApprove=true, so the document printed
    // before any money changed hands and the shop never saw it to approve.
    assert.strictEqual(job.paymentState, PaymentState.Pending);
    assert.strictEqual(job.printState, PrintState.AwaitingPayment,
      'a cash job must wait for the shop to confirm payment');

    // The shop sees it and approves it.
    const approve = await fetch(`${baseUrl}/api/print-jobs/${job.id}/manual-override`, { method: 'POST' });
    assert.strictEqual(approve.status, 200);
    const approved = (await approve.json()) as any;
    assert.strictEqual(approved.job.paymentState, PaymentState.Paid);
    assert.strictEqual(approved.job.printState, PrintState.Queued);
  });

  await t.test('17. Payment webhooks cannot be forged', async () => {
    const pdf = Buffer.from('%PDF-1.4 forgery test').toString('base64');
    const createRes = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId, fileName: 'forge.pdf', fileBase64: pdf,
        pageCount: 1, copies: 1, isColor: false,
      }),
    });
    const { job } = (await createRes.json()) as any;

    // The old code returned true for this exact string, so anyone who knew it
    // could mark any job paid and print for free.
    const forgeRaw = JSON.stringify({ paymentId: 'pay_x', jobId: job.id });

    const mock = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'valid_mock_signature' },
      body: forgeRaw,
    });
    assert.strictEqual(mock.status, 400, "'valid_mock_signature' must no longer be accepted");

    const wrong = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
      body: forgeRaw,
    });
    assert.strictEqual(wrong.status, 400);

    // The job must still be unpaid after both attempts.
    const check = await fetch(`${baseUrl}/api/print-jobs/${job.id}`);
    const checked = (await check.json()) as any;
    assert.strictEqual(checked.job.paymentState, PaymentState.Pending,
      'a rejected webhook must not mark the job paid');

    // A correctly signed webhook is accepted.
    const goodRaw = JSON.stringify({ paymentId: 'pay_real', jobId: job.id, amountInCents: 200 });
    const ok = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(goodRaw) },
      body: goodRaw,
    });
    assert.strictEqual(ok.status, 200);
  });

  await t.test('18. Checkout confirmation requires a valid Razorpay signature', async () => {
    const pdf = Buffer.from('%PDF-1.4 verify test').toString('base64');
    const createRes = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId, fileName: 'verify.pdf', fileBase64: pdf,
        pageCount: 1, copies: 1, isColor: false,
      }),
    });
    const { job } = (await createRes.json()) as any;

    // A customer claiming success without a valid signature must not get a print.
    const forged = await fetch(`${baseUrl}/api/payments/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        razorpayOrderId: 'order_fake',
        razorpayPaymentId: 'pay_fake',
        razorpaySignature: 'not_a_real_signature',
      }),
    });
    assert.strictEqual(forged.status, 400);

    const check = await fetch(`${baseUrl}/api/print-jobs/${job.id}`);
    const checked = (await check.json()) as any;
    assert.strictEqual(checked.job.paymentState, PaymentState.Pending);
    assert.strictEqual(checked.job.printState, PrintState.AwaitingPayment);
  });

  await t.test('19. A shop with paid jobs cannot be deleted, only archived', async () => {
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    });
    const { token } = (await login.json()) as any;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // The suite's first shop has paid jobs by this point.
    const safetyRes = await fetch(
      `${baseUrl}/api/admin/shops/${createdShopId}/removal-safety`, { headers: auth });
    const { safety } = (await safetyRes.json()) as any;
    assert.ok(safety.paidJobCount > 0, 'precondition: this shop has taken payment');
    assert.strictEqual(safety.canHardDelete, false);

    // Deleting it would destroy payment records, so it must be refused.
    const del = await fetch(`${baseUrl}/api/admin/shops/remove`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ shopIds: [createdShopId], mode: 'delete' }),
    });
    const delBody = (await del.json()) as any;
    assert.strictEqual(delBody.succeeded, 0);
    assert.strictEqual(delBody.results[0].action, 'refused');
    assert.match(delBody.results[0].reason, /paid job/i);

    // The shop must still be there.
    const stillThere = await fetch(`${baseUrl}/api/shops/${createdShopId}/pricing`, { headers: merchantAuth });
    assert.strictEqual(stillThere.status, 200, 'a refused delete must not remove anything');

    // Archiving is allowed, and hides it from the default listing.
    const arch = await fetch(`${baseUrl}/api/admin/shops/remove`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ shopIds: [createdShopId], mode: 'archive', reason: 'test cleanup' }),
    });
    assert.strictEqual(((await arch.json()) as any).succeeded, 1);

    const listed = (await (await fetch(`${baseUrl}/api/admin/shops`, { headers: auth })).json()) as any;
    assert.ok(!listed.shops.some((x: any) => x.shop.id === createdShopId),
      'archived shops are hidden by default');

    const withArchived = (await (await fetch(
      `${baseUrl}/api/admin/shops?includeArchived=true`, { headers: auth })).json()) as any;
    const archivedRow = withArchived.shops.find((x: any) => x.shop.id === createdShopId);
    assert.ok(archivedRow?.archivedAt, 'and are visible when explicitly requested');

    // Restore puts it back.
    const restore = await fetch(`${baseUrl}/api/admin/shops/remove`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ shopIds: [createdShopId], mode: 'restore' }),
    });
    assert.strictEqual(((await restore.json()) as any).succeeded, 1);
  });

  await t.test('20. Test shops delete cleanly, in bulk, and are audited', async () => {
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    });
    const { token } = (await login.json()) as any;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Three shops that never took payment — the case this feature exists for.
    const throwaway: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/api/shops/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopName: `Throwaway ${i}`, ownerEmail: `throwaway${i}@test.com`, printerName: 'P',
        }),
      });
      throwaway.push(((await res.json()) as any).shop.id);
    }

    const del = await fetch(`${baseUrl}/api/admin/shops/remove`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ shopIds: throwaway, mode: 'delete', reason: 'test data' }),
    });
    const body = (await del.json()) as any;
    assert.strictEqual(body.succeeded, 3, 'all three unpaid shops delete');
    assert.strictEqual(body.refused, 0);

    // Gone from the listing.
    const listed = (await (await fetch(
      `${baseUrl}/api/admin/shops?includeArchived=true`, { headers: auth })).json()) as any;
    for (const id of throwaway) {
      assert.ok(!listed.shops.some((x: any) => x.shop.id === id), `${id} must be gone`);
    }

    // And recorded, so a deletion is explainable after the row is gone.
    const audit = (await (await fetch(`${baseUrl}/api/admin/audit`, { headers: auth })).json()) as any;
    const deletions = audit.entries.filter((e: any) => e.action === 'SHOP_DELETED');
    assert.ok(deletions.length >= 3);
    assert.strictEqual(deletions[0].actorEmail, 'ops@printok.test');
    assert.ok(deletions[0].detail, 'the audit entry records what was removed');
  });

  await t.test('21. A mixed bulk delete removes what it can and refuses the rest', async () => {
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    });
    const { token } = (await login.json()) as any;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const res = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Unpaid', ownerEmail: 'unpaid@test.com', printerName: 'P' }),
    });
    const unpaidShopId = ((await res.json()) as any).shop.id;

    // One deletable, one protected: the protected one must not block the other.
    const del = await fetch(`${baseUrl}/api/admin/shops/remove`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ shopIds: [unpaidShopId, createdShopId], mode: 'delete' }),
    });
    const body = (await del.json()) as any;
    assert.strictEqual(body.succeeded, 1);
    assert.strictEqual(body.refused, 1);

    const byId = Object.fromEntries(body.results.map((r: any) => [r.shopId, r.action]));
    assert.strictEqual(byId[unpaidShopId], 'deleted');
    assert.strictEqual(byId[createdShopId], 'refused');
  });

  await t.test('22. Contact form stores enquiries and rejects junk', async () => {
    const valid = {
      name: 'Ramesh Kumar',
      email: 'Ramesh@Example.com',
      phone: '9876543210',
      shopName: 'Kumar Stationery',
      message: 'I have a Canon printer and want to connect it to PrintOk.',
    };

    const ok = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valid),
    });
    assert.strictEqual(ok.status, 201);
    assert.ok(((await ok.json()) as any).enquiryId.startsWith('enq_'));

    // Missing required fields.
    const bare = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Only a name' }),
    });
    assert.strictEqual(bare.status, 400);

    const badEmail = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, email: 'not-an-email' }),
    });
    assert.strictEqual(badEmail.status, 400);

    const tooShort = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, email: 'b@c.com', message: 'hi' }),
    });
    assert.strictEqual(tooShort.status, 400);

    // A bot filling the hidden field is accepted so it cannot detect rejection,
    // but nothing is stored.
    const honeypot = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bot', email: 'bot@spam.test',
        message: 'Buy cheap things from this link right now.',
        website: 'http://spam.example',
      }),
    });
    assert.strictEqual(honeypot.status, 201, 'the honeypot must not reveal itself');

    // Enquiries are operator-only data.
    const anon = await fetch(`${baseUrl}/api/admin/contact-enquiries`);
    assert.strictEqual(anon.status, 401);

    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    });
    const { token } = (await login.json()) as any;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const listed = (await (await fetch(
      `${baseUrl}/api/admin/contact-enquiries?status=all`, { headers: auth })).json()) as any;

    const stored = listed.enquiries.find((e: any) => e.name === 'Ramesh Kumar');
    assert.ok(stored, 'the valid enquiry must be stored');
    assert.strictEqual(stored.email, 'ramesh@example.com', 'email is normalised');
    assert.strictEqual(stored.status, 'new');
    assert.ok(!listed.enquiries.some((e: any) => e.name === 'Bot'),
      'the honeypot submission must not be stored');

    // Status moves through the workflow.
    const patched = await fetch(`${baseUrl}/api/admin/contact-enquiries/${stored.id}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'replied' }),
    });
    assert.strictEqual(patched.status, 200);
    assert.strictEqual(((await patched.json()) as any).enquiry.status, 'replied');

    const badStatus = await fetch(`${baseUrl}/api/admin/contact-enquiries/${stored.id}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'nonsense' }),
    });
    assert.strictEqual(badStatus.status, 400);
  });

  await t.test('23. Published plans match what the API charges', async () => {
    const res = await fetch(`${baseUrl}/api/plans`);
    assert.strictEqual(res.status, 200);
    const { plans, paymentGateway } = (await res.json()) as any;

    // The agreed catalogue, asserted explicitly rather than against itself, so
    // an accidental edit to the numbers fails here.
    assert.deepStrictEqual(
      plans.map((p: any) => [p.tier, p.monthlyPriceCents, p.commissionBps, p.maxOrdersPerMonth, p.maxPrinters]),
      [
        ['start', 0, 800, 100, 1],
        ['smart', 7900, 400, 500, 2],
        ['business', 24900, 200, 2500, 5],
        ['enterprise', 59900, 50, 10000, 10],
      ]
    );

    assert.strictEqual(plans.filter((p: any) => p.popular).length, 1, 'exactly one tier is featured');
    assert.strictEqual(plans.find((p: any) => p.popular).tier, 'business');
    assert.strictEqual(paymentGateway.feeBps, PAYMENT_GATEWAY_FEE_BPS);
  });

  await t.test('24. The landing page cannot drift from the plan catalogue', async () => {
    // The landing page keeps a static fallback so pricing still renders when
    // the API is asleep. If that copy disagrees with the catalogue, a shop is
    // shown a price it will not be charged.
    const landing = fs.readFileSync(
      path.join(__dirname, '../../../../apps/customer-web/public/landing.js'), 'utf8'
    );

    for (const plan of PLAN_CATALOGUE) {
      const block = new RegExp(
        `tier: '${plan.tier}'[\\s\\S]{0,400}?monthlyPriceCents: ${plan.monthlyPriceCents}` +
        `[\\s\\S]{0,80}?commissionBps: ${plan.commissionBps}` +
        `[\\s\\S]{0,120}?maxOrdersPerMonth: ${plan.maxOrdersPerMonth}` +
        `[\\s\\S]{0,60}?maxPrinters: ${plan.maxPrinters}`
      );
      assert.match(landing, block,
        `landing.js fallback for '${plan.tier}' does not match PLAN_CATALOGUE`);
    }
  });

  await t.test('25. A shop keeps order value minus gateway and service fees', async () => {
    // ₹100 order on Business: 2.36% gateway, 2% service fee.
    const { gatewayFeeCents, serviceFeeCents, netCents } = calculateShopNetCents(10000, 200);
    assert.strictEqual(gatewayFeeCents, 236);
    assert.strictEqual(serviceFeeCents, 200);
    assert.strictEqual(netCents, 9564);

    // On Enterprise the gateway takes nearly five times what PrintOk does,
    // which is exactly why the landing page states it separately.
    const enterprise = calculateShopNetCents(10000, 50);
    assert.strictEqual(enterprise.serviceFeeCents, 50);
    assert.ok(enterprise.gatewayFeeCents > enterprise.serviceFeeCents * 4);

    // Fees never exceed the order.
    const tiny = calculateShopNetCents(100, 800);
    assert.ok(tiny.netCents >= 0);
  });

  await t.test('26. Route splits the order and never silently pretends to', async () => {
    const { RazorpayRouteService } = await import('../razorpayRoute');
    const route = new RazorpayRouteService();

    // Route stays off until Razorpay enables it AND we opt in, so the platform
    // cannot believe a split happened when it did not.
    assert.strictEqual(route.isEnabled, false, 'Route is off without explicit opt-in');

    const attempt = await route.createLinkedAccount({
      shopId: 'shop_x', shopName: 'X', ownerEmail: 'x@y.com', phone: '9876543210',
    });
    assert.strictEqual(attempt.ok, false);
    assert.strictEqual(attempt.routeUnavailable, true);

    // ₹100 on Business (2%): both fees come off the shop's share, exactly as
    // the published terms say. Shop gets ₹95.64, PrintOk retains ₹4.36 and pays
    // ₹2.36 of that to Razorpay.
    const { transfer, serviceFeeCents, gatewayFeeCents } =
      route.buildTransfer('acc_test', 10000, 200, 'job_1');
    assert.strictEqual(transfer.account, 'acc_test');
    assert.strictEqual(transfer.amount, 9564);
    assert.strictEqual(serviceFeeCents, 200);
    assert.strictEqual(gatewayFeeCents, 236);
    assert.strictEqual(
      transfer.amount + serviceFeeCents + gatewayFeeCents, 10000,
      'the split must account for every paisa'
    );

    // A transfer can never go negative, even at the highest permitted fee.
    const maxFee = route.buildTransfer('acc_test', 100, 5000, 'job_2');
    assert.ok(maxFee.transfer.amount >= 0);
  });

  await t.test('27. What the shop is told matches what it is paid', async () => {
    const { RazorpayRouteService } = await import('../razorpayRoute');
    const route = new RazorpayRouteService();

    // The published terms, the payout summary and the actual Route transfer
    // must agree. They did not: the summary deducted both fees while the
    // transfer deducted only the service fee, so a shop was paid more than it
    // was told and PrintOk lost the difference.
    for (const plan of PLAN_CATALOGUE) {
      const gross = 10000;
      const told = calculateShopNetCents(gross, plan.commissionBps);
      const { transfer } = route.buildTransfer('acc_test', gross, plan.commissionBps, 'job_x');

      assert.strictEqual(
        transfer.amount, told.netCents,
        `${plan.tier}: the transfer must equal what the payout summary states`
      );
    }

    // PrintOk retains both fees and pays the gateway out of that, so its margin
    // is the service fee on every tier — including Enterprise at 0.5%.
    const enterprise = route.estimatePlatformMargin(10000, 50);
    assert.strictEqual(enterprise.marginCents, enterprise.serviceFeeCents);
    assert.strictEqual(
      enterprise.retainedCents,
      enterprise.serviceFeeCents + enterprise.gatewayFeeCents
    );
    assert.ok(enterprise.marginCents > 0, 'no tier should lose money per order');
  });

  await t.test('13. An unknown device token is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-device-token': 'dvt_deadbeef' },
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('11. Agent Config download uses keys the Windows agent actually binds', async () => {
    const res = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/agent-config`);
    assert.strictEqual(res.status, 200);

    const config = (await res.json()) as any;

    // The agent resolves the flat keys first...
    assert.ok(config.PrintOkApiUrl, 'PrintOkApiUrl must be present');
    assert.ok(config.AgentApiKey, 'AgentApiKey must be present');
    assert.strictEqual(config.PrinterId, createdPrinterId);

    // ...and falls back to the nested PrintOk section, which agents released
    // before v1.1.0 read exclusively. Dropping either shape silently sends the
    // agent back to its localhost defaults, so pin both.
    assert.ok(config.PrintOk, 'nested PrintOk section must be present');
    assert.strictEqual(config.PrintOk.ApiBaseUrl, config.PrintOkApiUrl);
    assert.strictEqual(config.PrintOk.ApiKey, config.AgentApiKey);
    assert.strictEqual(config.PrintOk.PrinterId, createdPrinterId);
  });

  await t.test('28. A brand new shop can find itself from its session alone', async () => {
    // The dashboard has no shop id of its own when a merchant signs in: not in
    // the URL, and nothing in localStorage on a fresh browser. It asks this
    // endpoint who it is. If that answer is incomplete the dashboard falls back
    // to its "No Shop Connected" state and shows nothing at all — which is what
    // every newly registered shop used to see, since the printer was previously
    // derived from the shop's most recent job and a new shop has none.
    const signup = await fetch(`${baseUrl}/api/merchant/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Fresh Prints', ownerEmail: 'fresh@example.com',
        printerName: 'Brother HL-L2350DW', password: 'FreshOwner77xy',
      }),
    });
    assert.strictEqual(signup.status, 201);
    const { token } = (await signup.json()) as any;

    const me = await fetch(`${baseUrl}/api/merchant/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(me.status, 200);
    const body = (await me.json()) as any;

    assert.ok(body.shop && body.shop.id, 'the session must resolve to a shop');
    assert.strictEqual(body.shop.name, 'Fresh Prints');

    // A shop that has never printed still has the printer it registered with,
    // and the dashboard needs all of this to render its QR and pairing panels.
    assert.ok(Array.isArray(body.printers) && body.printers.length > 0,
      'a shop with no jobs must still report its printer');
    const [printer] = body.printers;
    assert.strictEqual(printer.printerName, 'Brother HL-L2350DW');
    assert.ok(printer.qrCodeDataUrl, 'the QR tab needs the printer QR');
    assert.ok(printer.apiKey.startsWith('prn_key_'),
      'the pairing panel needs the agent key, which only this route may give it');
  });

  await t.test('29. The public printer record leaks neither the agent key nor the owner', async () => {
    // This endpoint has to stay public — the printer id is printed on the QR
    // poster and the customer page reads the shop name and status from it. So
    // it must carry nothing an attacker could use. It used to return the agent
    // API key, which is all that is needed to poll a shop's queue, claim its
    // jobs and report false statuses, along with the owner's email address.
    const res = await fetch(`${baseUrl}/api/printers/${createdPrinterId}`);
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;

    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes(agentApiKey),
      'the agent API key must never appear in an unauthenticated response');
    assert.ok(!serialised.includes('owner@metrocopy.com'),
      'the owner email must never appear in an unauthenticated response');
    assert.strictEqual(body.printer.apiKey, undefined);
    assert.strictEqual(body.shop.ownerEmail, undefined);

    // What the customer page legitimately needs is still there.
    assert.strictEqual(body.printer.id, createdPrinterId);
    assert.ok(body.printer.printerName);
    assert.ok(body.printer.status);
    assert.strictEqual(body.shop.id, createdShopId);
    assert.ok(body.shop.name);
  });

  await t.test('30. Everything the landing page boot calls actually exists', async () => {
    // landing.js runs as one IIFE: the DOMContentLoaded handler calls each
    // wiring function in turn, so a single undefined name throws a
    // ReferenceError that abandons every step after it. That is not a visible
    // failure — the page still renders, it just quietly stops doing things.
    //
    // It has happened: a refactor dropped four animation functions while
    // leaving their calls in place, which killed the hero animations and, with
    // them, the contact form handler further down the same list.
    const landing = fs.readFileSync(
      path.join(__dirname, '../../../../apps/customer-web/public/landing.js'), 'utf8'
    );

    const boot = landing.match(/DOMContentLoaded[\s\S]*?\{([\s\S]*?)\n  \}\);/);
    assert.ok(boot, 'could not find the DOMContentLoaded handler in landing.js');

    const called = [...boot[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\(\);/gm)].map((m) => m[1]);
    assert.ok(called.length >= 4, `expected the boot sequence to call several functions, saw ${called.length}`);

    for (const name of called) {
      assert.match(
        landing,
        new RegExp(`function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=`),
        `landing.js boot calls ${name}(), but nothing in the file defines it — ` +
        'every step after it will be skipped at runtime'
      );
    }
  });

  await t.test('31. A sub-rupee job is refused before it reaches Razorpay', async () => {
    // Razorpay rejects an order below 100 paise. A shop's own rate card can
    // produce one — pricing accepts whatever it is given — and without this
    // check the customer meets an opaque gateway error at the moment they pay,
    // having already uploaded and configured the document.
    const shop = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Penny Prints', ownerEmail: 'penny@example.com', printerName: 'HP',
      }),
    });
    const { shop: pennyShop, printer: pennyPrinter } = (await shop.json()) as any;

    // Half a rupee a page: a one-page job comes to 50 paise.
    const merchant = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: pennyShop.id, ownerEmail: 'penny@example.com', password: 'PennyOwner55xy',
      }),
    });
    const { token: pennyToken } = (await merchant.json()) as any;

    await fetch(`${baseUrl}/api/shops/${pennyShop.id}/pricing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pennyToken}` },
      body: JSON.stringify({ bwSinglePerPageCents: 50 }),
    });

    // autoApprove=false is the online-payment path: the job waits for money
    // rather than being marked paid on creation.
    const jobRes = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: pennyPrinter.id,
        fileName: 'one-page.pdf',
        fileBase64: Buffer.from('%PDF-1.4 single page').toString('base64'),
        copies: 1,
        isColor: false,
        isDuplex: false,
      }),
    });
    const job = (await jobRes.json()) as any;
    assert.ok(job.job, `job was not created: ${JSON.stringify(job)}`);
    assert.ok(job.job.totalPriceInCents < 100,
      `expected a sub-rupee total, got ${job.job.totalPriceInCents}`);

    const order = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.job.id }),
    });

    assert.strictEqual(order.status, 400, 'a sub-rupee order must be refused, not sent to Razorpay');
    const body = (await order.json()) as any;
    assert.match(body.error, /counter/i, 'the refusal should point the customer at cash payment');
  });

  await t.test('32. A Razorpay failure reports why, not "undefined"', async () => {
    // The SDK rejects with { statusCode, error: { code, description } } and no
    // `message`, so reading err.message gave undefined. Customers were shown
    // "Razorpay order creation failed: undefined", which named neither the
    // cause nor anything to do about it, and the logs said the same.
    const { describeRazorpayError } = await import('../razorpayService');

    // The two shapes that actually reach us, taken from live responses.
    const rejected = {
      statusCode: 400,
      error: { code: 'BAD_REQUEST_ERROR', description: 'Order amount less than minimum amount allowed' },
    };
    assert.match(describeRazorpayError(rejected), /Order amount less than minimum amount allowed/);
    assert.match(describeRazorpayError(rejected), /400/);

    const badKeys = {
      statusCode: 401,
      error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' },
    };
    assert.match(describeRazorpayError(badKeys), /Authentication failed/);

    // It must never produce the string that started this.
    for (const shape of [rejected, badKeys, new Error('socket hang up'), {}, null]) {
      assert.doesNotMatch(describeRazorpayError(shape), /undefined/,
        `describeRazorpayError produced "undefined" for ${JSON.stringify(shape)}`);
    }

    // A plain Error still reports its own message.
    assert.match(describeRazorpayError(new Error('socket hang up')), /socket hang up/);
  });

  await t.test('33. The rate limiter sees the caller, not the proxy', async () => {
    // Behind Render's proxy req.ip is the proxy unless Express is told to trust
    // it, which put every visitor in one shared rate-limit bucket — 60 print
    // jobs a minute for the whole platform, and five contact enquiries an hour
    // for the entire internet. Production logged
    // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR for exactly this.
    assert.strictEqual(app.get('trust proxy'), 1,
      'Express must trust exactly one proxy hop');

    // Never `true`: that trusts the whole X-Forwarded-For chain, so a caller
    // can present a fresh address per request and bypass the limiter entirely.
    assert.notStrictEqual(app.get('trust proxy'), true,
      'trusting every hop makes the rate limiter bypassable');

    // The limiter must read the forwarded address rather than the socket's.
    const res = await fetch(`${baseUrl}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
      body: JSON.stringify({ name: 'Proxy Test', email: 'proxy@example.com', message: 'Checking the forwarded address is used.' }),
    });
    assert.notStrictEqual(res.status, 500, 'a forwarded request must not error');
  });

  await t.test('34. Production never falls back to the public webhook secret', async () => {
    // The development fallback is a literal in a public repository. If
    // production used it, anyone could read it, sign their own
    // "payment.captured" webhook and mark any job paid — free printing for
    // whoever noticed. Production must fail closed instead.
    const { RazorpayService } = await import('../razorpayService');

    const realEnv = process.env.NODE_ENV;
    const realSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    try {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      process.env.NODE_ENV = 'production';

      const service = new RazorpayService();
      const forged = JSON.stringify({ payload: { payment: { entity: { notes: { jobId: 'x' } } } } });
      const signature = crypto
        .createHmac('sha256', 'printok_webhook_secret_dev')
        .update(forged)
        .digest('hex');

      assert.strictEqual(service.verifyWebhookSignature(forged, signature), false,
        'a webhook signed with the public dev secret must not verify in production');
    } finally {
      process.env.NODE_ENV = realEnv;
      if (realSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
      else process.env.RAZORPAY_WEBHOOK_SECRET = realSecret;
    }
  });

  await t.test('35. A failed payment webhook never marks a job paid', async () => {
    // The handler ignored `event` entirely and confirmed any signed webhook
    // carrying a job reference. `payment.failed` carries the same payment
    // entity and the same notes as `payment.captured`, so subscribing to it —
    // which production does — meant a declined card queued the job anyway:
    // the customer collected their printout and nobody was charged.
    const printerRes = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Webhook Event Shop', ownerEmail: 'wh@example.com', printerName: 'HP',
      }),
    });
    const { printer: whPrinter } = (await printerRes.json()) as any;

    const jobRes = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: whPrinter.id,
        fileName: 'declined.pdf',
        fileBase64: Buffer.from('%PDF-1.4 one page').toString('base64'),
        copies: 1, isColor: false, isDuplex: false,
      }),
    });
    const { job: whJob } = (await jobRes.json()) as any;
    assert.strictEqual(whJob.paymentState, PaymentState.Pending);

    const failedRaw = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_declined', notes: { jobId: whJob.id } } } },
    });

    const failed = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(failedRaw) },
      body: failedRaw,
    });

    // 200, so Razorpay stops retrying an event that was understood.
    assert.strictEqual(failed.status, 200, 'an understood event must be acknowledged');
    const failedBody = (await failed.json()) as any;
    assert.strictEqual(failedBody.ignored, 'payment.failed');

    const afterFail = await fetch(`${baseUrl}/api/print-jobs/${whJob.id}`);
    const { job: stillPending } = (await afterFail.json()) as any;
    assert.strictEqual(stillPending.paymentState, PaymentState.Pending,
      'a failed payment must leave the job unpaid');
    assert.notStrictEqual(stillPending.printState, PrintState.Queued,
      'a failed payment must never queue the job for printing');

    // The captured event for the same job still works.
    const capturedRaw = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_ok', notes: { jobId: whJob.id } } } },
    });
    const captured = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(capturedRaw) },
      body: capturedRaw,
    });
    assert.strictEqual(captured.status, 200);

    const afterCapture = await fetch(`${baseUrl}/api/print-jobs/${whJob.id}`);
    const { job: paid } = (await afterCapture.json()) as any;
    assert.strictEqual(paid.paymentState, PaymentState.Paid,
      'payment.captured must still confirm the payment');
  });

  server.close();
});


