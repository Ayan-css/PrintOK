import test from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

// Webhook signatures are verified for real now, so the suite signs its own
// payloads rather than relying on a bypass string.
const TEST_WEBHOOK_SECRET = 'printok_test_webhook_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

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
    // Get default shop pricing
    const pricingRes = await fetch(`${baseUrl}/api/shops/shop_test/pricing`);
    assert.strictEqual(pricingRes.status, 200);
    const pricingData = (await pricingRes.json()) as any;
    assert.strictEqual(pricingData.pricing.bwSinglePerPageCents, 200);

    // Update shop pricing
    const updateRes = await fetch(`${baseUrl}/api/shops/shop_test/pricing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bwSinglePerPageCents: 300,
        colorSinglePerPageCents: 1200,
      }),
    });
    assert.strictEqual(updateRes.status, 200);
    const updatedData = (await updateRes.json()) as any;
    assert.strictEqual(updatedData.pricing.bwSinglePerPageCents, 300);
    assert.strictEqual(updatedData.pricing.colorSinglePerPageCents, 1200);

    // Fetch shop stats
    const statsRes = await fetch(`${baseUrl}/api/shops/shop_test/stats`);
    assert.strictEqual(statsRes.status, 200);
    const statsData = (await statsRes.json()) as any;
    assert.ok(statsData.stats);
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
    assert.strictEqual(shops[0].plan.planTier, 'free', 'new shops default to the free tier');
    assert.strictEqual(shops[0].plan.commissionBps, 500);

    // Login works with the stored hash, and is case-insensitive on email.
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'OPS@printok.test', password: 'CorrectHorse99x' }),
    });
    assert.strictEqual(login.status, 200);

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
      body: JSON.stringify({ planTier: 'pro', commissionBps: 250 }),
    });
    assert.strictEqual(ok.status, 200);
    const { plan } = (await ok.json()) as any;
    assert.strictEqual(plan.planTier, 'pro');
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
      body: JSON.stringify({ planTier: 'enterprise' }),
    });
    assert.strictEqual(unknownTier.status, 400);
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
    const stillThere = await fetch(`${baseUrl}/api/shops/${createdShopId}/pricing`);
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

  server.close();
});


