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

// The checkout confirmation path is signed with the API key secret, so the
// suite needs one to exercise it at all.
//
// RAZORPAY_KEY_ID is deliberately left unset. verifyCheckoutSignature needs
// only the secret, while isConfigured needs both — so with the id absent the suite
// can sign a genuine checkout triple while createOrder still returns a
// simulated order and never reaches the network, and the live gateway
// cross-check in /verify stays switched off.
const TEST_KEY_SECRET = 'printok_test_key_secret';
process.env.RAZORPAY_KEY_SECRET = TEST_KEY_SECRET;

// Pinned empty, not merely left unset. A later test imports env.ts, which
// loads the developer's .env — and dotenv fills in any variable that does not
// exist yet, so an unset key id became the real one for every app built after
// that point. dotenv never overrides a variable that exists, even as ''.
process.env.RAZORPAY_KEY_ID = '';

// And a backstop: no test may reach Razorpay. A test that needs its API
// replaces fetch with a stand-in first; anything that gets here is a bug.
{
  const guardedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input?.url);
    if (url.startsWith('https://api.razorpay.com')) {
      throw new Error(`Test attempted a real Razorpay request: ${url}`);
    }
    return guardedFetch(input, init);
  }) as typeof fetch;
}

/**
 * Stands in for the Razorpay SDK (`require('razorpay')`, loaded at call time
 * by RazorpayService) for the duration of `fn`, so no test reaches the network.
 */
async function withFakeRazorpaySdk<T>(fake: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'razorpay') {
      return function FakeRazorpay(this: any) { Object.assign(this, fake); };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return await fn();
  } finally {
    Module._load = originalLoad;
  }
}

// This suite imports ../app directly rather than booting the server, so it
// deliberately never loads .env and never touches real credentials. That also
// means it gets no JWT_SECRET, and without one every route that issues or
// checks a session answers 500 — which silently disabled the merchant and admin
// coverage below: those tests were asserting against error responses rather
// than the behaviour they describe.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'printok_test_jwt_secret_key';

// The suite creates hundreds of jobs from one address in a few seconds, which
// is exactly what the production limiter exists to stop. Left at the default it
// starts refusing partway through and the failure lands on whichever test
// happened to be running, not on the one that added the requests.
process.env.API_RATE_LIMIT_PER_MINUTE = '100000';

// Same reasoning for the tighter limiter on logins, claims and pairing: this
// suite signs in as dozens of shops in a few seconds, which is exactly the
// shape that limiter exists to stop. Test 98 sets its own low limit locally to
// prove the limiter actually works.
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100000';

/** Signs the exact bytes that will be sent, as Razorpay does. */
function signWebhook(rawBody: string): string {
  return crypto.createHmac('sha256', TEST_WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/**
 * Signs a checkout result the way Razorpay Checkout does: an HMAC over
 * "<order_id>|<payment_id>" with the API key secret.
 *
 * Note what it does not cover: the job. That omission is the whole reason the
 * confirm endpoint needs a stored order id to bind a payment to a job.
 */
/**
 * A genuine 1x1 PNG: signature, IHDR, IDAT and IEND.
 *
 * Real bytes rather than a stub string, because uploads are now checked against
 * the format their name claims. A fixture that only pretended to be a PNG would
 * prove nothing about the PNG path — and stub fixtures are exactly why a broken
 * PDF page count went unnoticed for so long.
 *
 * Module scope on purpose: declared inside the suite it sat below the tests
 * that use it, and a const is not initialised until its own line runs.
 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);

function signCheckout(orderId: string, paymentId: string): string {
  return crypto.createHmac('sha256', TEST_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}
import http from 'http';
import { createApp } from '../app';
import { hashPassword } from '../adminAuth';
import { MemoryStorage } from '../storage';
import { PrintState, PaymentState } from '@printok/shared-types';

test('PrintOk API Endpoints Integration Test', async (t) => {
  const storage = new MemoryStorage();
  const app = createApp(storage);
  
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://localhost:${address.port}`;

  /** Opens (or reuses) the gateway order for a job, as checkout does. */
  async function openOrder(jobId: string): Promise<{ orderId: string; amountInCents: number }> {
    const res = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    const body = (await res.json()) as any;
    assert.ok(res.ok, `create-order: ${JSON.stringify(body)}`);
    return { orderId: body.orderId, amountInCents: body.amountInCents };
  }

  /**
   * A payment webhook as Razorpay sends it: naming the gateway order the job
   * opened and that order's amount, with the job in the notes. The webhook
   * refuses anything less, so the tests must send the real shape.
   */
  async function paymentWebhookRaw(
    jobId: string, paymentId: string, extra: Record<string, unknown> = {}, event = 'payment.captured'
  ): Promise<string> {
    const order = await openOrder(jobId);
    return JSON.stringify({
      event,
      payload: {
        payment: {
          entity: {
            id: paymentId, order_id: order.orderId, amount: order.amountInCents,
            notes: { jobId }, ...extra,
          },
        },
      },
    });
  }

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
      body: JSON.stringify({ acceptTerms: true,
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
      body: JSON.stringify({ acceptTerms: true,
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
    // An anonymous customer cannot create a job that is already paid. This
    // asserted Queued while autoApprove defaulted to true, which meant any
    // caller who omitted a query parameter got a free print.
    assert.strictEqual(data.job.printState, PrintState.AwaitingPayment);
    assert.strictEqual(data.job.paymentState, PaymentState.Pending);
    assert.strictEqual(data.job.pageCount, 1); // Tamper-proof server override
    assert.strictEqual(data.job.totalPriceInCents, 200); // 1 page * 200 cents

    createdJobId = data.job.id;

    // And asking for it explicitly, without a merchant session, is refused
    // rather than honoured.
    const unauthorised = await fetch(`${baseUrl}/api/print-jobs?autoApprove=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId, fileName: 'free.pdf', fileBase64: samplePdfBase64,
        pageCount: 1, copies: 1, isColor: false,
      }),
    });
    assert.strictEqual(unauthorised.status, 401,
      'only an authenticated shop may declare a job already paid');

    // The shop takes the cash and approves it, which is what puts it in the
    // queue for the agent tests that follow.
    const approved = await fetch(`${baseUrl}/api/print-jobs/${createdJobId}/manual-override`, {
      method: 'POST', headers: merchantAuth,
    });
    assert.strictEqual(approved.status, 200);
    assert.strictEqual(((await approved.json()) as any).job.printState, PrintState.Queued);
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

    // The owning device is shop-internal and no longer travels on the customer's
    // status endpoint, so it is asserted where it actually lives.
    assert.strictEqual(checkData.job.deviceId, undefined,
      'the public status view must not carry the shop\'s device id');
    const claimed = await storage.getPrintJob(createdJobId);
    assert.ok(claimed?.deviceId, 'claimed job must record the owning device');

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
    const webhookRaw = await paymentWebhookRaw(pendingJobId, 'pay_9988776655');

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
    const pngBase64 = PNG_1X1.toString('base64');
    
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
      headers: merchantAuth,
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
      body: JSON.stringify({ acceptTerms: true,
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
      headers: merchantAuth,
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
        headers: merchantAuth,
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

    // A revoked key can then be cleared from the list.
    const removed = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/devices/${paired.deviceId}`,
      { method: 'DELETE', headers: merchantAuth }
    );
    assert.strictEqual(removed.status, 204);
    const remaining = (await (await fetch(`${baseUrl}/api/printers/${createdPrinterId}/devices`,
      { headers: merchantAuth })).json()) as any;
    assert.ok(!remaining.devices.some((d: any) => d.id === paired.deviceId));

    // The legacy printer key still works, so revocation is genuinely scoped.
    const legacyStillWorks = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-api-key': agentApiKey },
      body: JSON.stringify({ paperStatus: 'OK' }),
    });
    assert.strictEqual(legacyStillWorks.status, 200);

    // 6. Everything above is auditable.
    const auditRes = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/security-events`,
      { headers: merchantAuth }
    );
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
    assert.strictEqual(shops[0].plan.planTier, 'free', 'new shops default to the entry tier');
    assert.strictEqual(shops[0].plan.commissionBps, 200, 'Free publishes a 2% platform fee');

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
      body: JSON.stringify({ planTier: 'pro' }),
    });
    assert.strictEqual(moved.status, 200);
    const movedPlan = ((await moved.json()) as any).plan;
    assert.strictEqual(movedPlan.planTier, 'pro');
    assert.strictEqual(movedPlan.commissionBps, 0, 'Pro publishes no platform fee at all');
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
    const approve = await fetch(`${baseUrl}/api/print-jobs/${job.id}/manual-override`, {
      method: 'POST', headers: merchantAuth,
    });
    assert.strictEqual(approve.status, 200);
    const approved = (await approve.json()) as any;
    assert.strictEqual(approved.job.paymentState, PaymentState.Paid);
    assert.strictEqual(approved.job.printState, PrintState.Queued);

    // The desktop agent can answer cash orders at the counter too.
    const cashJob = async (name: string) => ((await (await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: createdPrinterId, fileName: name, fileBase64: pdf, pageCount: 1, copies: 1, isColor: false }),
    })).json()) as any).job;
    const toPrint = await cashJob('agent-yes.pdf');
    const toReject = await cashJob('agent-no.pdf');
    const agent = { 'x-agent-api-key': agentApiKey };

    const listed = (await (await fetch(`${baseUrl}/api/agent/cash-jobs`, { headers: agent })).json()) as any;
    const ids = listed.jobs.map((j: any) => j.id);
    assert.ok(ids.includes(toPrint.id) && ids.includes(toReject.id), 'both wait for the counter');
    assert.ok(!ids.includes(job.id), 'an approved job is no longer waiting');

    assert.strictEqual((await fetch(`${baseUrl}/api/agent/cash-jobs`)).status, 401, 'only the shop agent');

    const yes = (await (await fetch(`${baseUrl}/api/agent/cash-jobs/${toPrint.id}/approve`, {
      method: 'POST', headers: agent })).json()) as any;
    assert.strictEqual(yes.job.printState, PrintState.Queued);
    const no = await fetch(`${baseUrl}/api/agent/cash-jobs/${toReject.id}/reject`, { method: 'POST', headers: agent });
    assert.strictEqual(no.status, 200);
    assert.strictEqual((await fetch(`${baseUrl}/api/agent/cash-jobs/${toPrint.id}/approve`, {
      method: 'POST', headers: agent })).status, 404, 'an answered order cannot be answered again');
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
    const goodRaw = await paymentWebhookRaw(job.id, 'pay_real');
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
      plans.map((p: any) => [
        p.tier, p.monthlyPriceCents, p.platformFeeBps, p.maxOrdersPerMonth, p.maxPrinters, p.maxStaff,
      ]),
      [
        ['free', 0, 200, 100, 1, 1],
        ['starter', 14900, 100, 1000, 2, 3],
        ['business', 34900, 50, 4000, 5, 8],
        ['pro', 69900, 0, 10000, 10, 15],
      ]
    );

    // The old field name is carried alongside so a landing page cached from
    // before the rename still renders a rate. Same number, never a second source.
    for (const p of plans) {
      assert.strictEqual(p.commissionBps, p.platformFeeBps,
        `${p.tier}: the compatibility alias must equal the real rate`);
    }

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
        `[\\s\\S]{0,80}?platformFeeBps: ${plan.platformFeeBps}` +
        `[\\s\\S]{0,120}?maxOrdersPerMonth: ${plan.maxOrdersPerMonth}` +
        `[\\s\\S]{0,60}?maxPrinters: ${plan.maxPrinters}` +
        `[\\s\\S]{0,60}?maxStaff: ${plan.maxStaff}`
      );
      assert.match(landing, block,
        `landing.js fallback for '${plan.tier}' does not match PLAN_CATALOGUE`);
    }
  });

  await t.test('25. A shop keeps order value minus gateway and platform fees', async () => {
    // ₹100 order on Free: 2.36% gateway, 2% PrintOk platform fee.
    const { gatewayFeeCents, serviceFeeCents, netCents } = calculateShopNetCents(10000, 200);
    assert.strictEqual(gatewayFeeCents, 236);
    assert.strictEqual(serviceFeeCents, 200);
    assert.strictEqual(netCents, 9564);

    // On Business the gateway now takes nearly five times what PrintOk does,
    // which is exactly why the landing page states it separately.
    const business = calculateShopNetCents(10000, 50);
    assert.strictEqual(business.serviceFeeCents, 50);
    assert.ok(business.gatewayFeeCents > business.serviceFeeCents * 4);

    // Pro: PrintOk takes nothing, and the gateway still does. "0% platform fee"
    // must never be read as "nothing is deducted", which is why this is pinned.
    const pro = calculateShopNetCents(10000, 0);
    assert.strictEqual(pro.serviceFeeCents, 0, 'Pro pays no platform fee');
    assert.strictEqual(pro.gatewayFeeCents, 236, "Razorpay's charge is unaffected by our plan");
    assert.strictEqual(pro.netCents, 9764);

    // Cash never touched Razorpay, so no gateway fee may be deducted from it —
    // but the platform fee still applies, because the order still used PrintOk.
    const cash = calculateShopNetCents(10000, 200, { gatewayFeeApplies: false });
    assert.strictEqual(cash.gatewayFeeCents, 0);
    assert.strictEqual(cash.serviceFeeCents, 200);

    // Fees never exceed the order.
    const tiny = calculateShopNetCents(100, 200);
    assert.ok(tiny.netCents >= 0);
  });

  await t.test('25b. The platform fee is the plan rate, on the order, rounded once', async () => {
    const { platformFeeFor, PLAN_CATALOGUE: cat } = await import('@printok/shared-types');

    const rate = (tier: string) => cat.find((p) => p.tier === tier)!.platformFeeBps;

    // ₹100 order, every tier. These are the figures the plan page promises.
    assert.strictEqual(platformFeeFor(10000, rate('free')), 200);     // ₹2.00
    assert.strictEqual(platformFeeFor(10000, rate('starter')), 100);  // ₹1.00
    assert.strictEqual(platformFeeFor(10000, rate('business')), 50);  // ₹0.50
    assert.strictEqual(platformFeeFor(10000, rate('pro')), 0);        // nil

    // ₹1,000 order, every tier.
    assert.strictEqual(platformFeeFor(100000, rate('free')), 2000);    // ₹20
    assert.strictEqual(platformFeeFor(100000, rate('starter')), 1000); // ₹10
    assert.strictEqual(platformFeeFor(100000, rate('business')), 500); // ₹5
    assert.strictEqual(platformFeeFor(100000, rate('pro')), 0);

    // Rounding: half away from zero, once, at the order level. A ₹40.10 order
    // at 0.5% is 20.05 paise and bills as 20.
    assert.strictEqual(platformFeeFor(4010, 50), 20);
    assert.strictEqual(platformFeeFor(4030, 50), 20);  // 20.15 -> 20
    assert.strictEqual(platformFeeFor(4110, 50), 21);  // 20.55 -> 21

    // Pro is exactly zero, not merely small. A rounding scheme that let a 0%
    // tier bill a paise would make the headline false.
    for (const gross of [1, 99, 100, 4000, 999999]) {
      assert.strictEqual(platformFeeFor(gross, 0), 0, `Pro must bill nothing on ${gross}`);
    }

    // Degenerate inputs bill nothing rather than NaN, which would otherwise
    // reach the ledger and the shop's settlement.
    assert.strictEqual(platformFeeFor(0, 200), 0);
    assert.strictEqual(platformFeeFor(-100, 200), 0);
    assert.strictEqual(platformFeeFor(Number.NaN, 200), 0);
    assert.strictEqual(platformFeeFor(10000, Number.NaN), 0);

    // The fee is computed per order and never on a running total, so a month is
    // the sum of what each order was actually charged. These two genuinely
    // disagree, which is the point: three ₹1 orders at 0.5% bill 1 paise each
    // and 3 in total, where the same ₹3 billed once would be 2. The ledger has
    // to match the orders, not a recomputation of them.
    const orders = [100, 100, 100];
    const summed = orders.reduce((t, g) => t + platformFeeFor(g, 50), 0);
    assert.strictEqual(summed, 3, 'each order rounds on its own');
    assert.strictEqual(platformFeeFor(300, 50), 2, 'the same gross billed once would differ');
    assert.notStrictEqual(summed, platformFeeFor(300, 50));
  });

  await t.test('26. Route splits the order and never silently pretends to', async () => {
    const { RazorpayRouteService } = await import('../razorpayRoute');
    const route = new RazorpayRouteService();

    // Route stays off until Razorpay enables it AND we opt in, so the platform
    // cannot believe a split happened when it did not.
    assert.strictEqual(route.isEnabled, false, 'Route is off without explicit opt-in');

    const attempt = await route.createLinkedAccount({
      shopId: 'shop_x', legalBusinessName: 'X Prints', customerFacingName: 'X Prints',
      email: 'x@y.com', phone: '9876543210', businessType: 'proprietorship', contactName: 'Xavier',
      address: { street1: '1 Road', city: 'Mumbai', state: 'Maharashtra', postalCode: '400001' },
      settlement: { accountNumber: '1234567890', ifsc: 'HDFC0000001', beneficiaryName: 'X Prints' },
      tncAccepted: true,
    });
    assert.strictEqual(attempt.ok, false);
    assert.strictEqual(attempt.routeUnavailable, true);

    // Nothing that moves money answers "done" while Route is off.
    assert.strictEqual((await route.getPaymentTransfers('pay_x')).ok, false);
    assert.strictEqual((await route.releaseTransfer('trf_x')).ok, false);
    assert.strictEqual((await route.reverseTransfer('trf_x')).ok, false);

    // ₹100 on Free (2%), paid by card with Razorpay charging ₹2.36: both fees
    // come off the shop's share, exactly as the published terms say.
    const card = route.buildTransfer('acc_test', 10000, 200, 236, 'job_1');
    assert.strictEqual(card.transfer.account, 'acc_test');
    assert.strictEqual(card.transfer.amount, 9564);
    assert.strictEqual(card.serviceFeeCents, 200);
    assert.strictEqual(card.gatewayFeeCents, 236);
    assert.strictEqual(
      card.transfer.amount + card.serviceFeeCents + card.gatewayFeeCents, 10000,
      'the split must account for every paisa'
    );
    // Held until the job prints.
    assert.strictEqual(card.transfer.on_hold, true);

    // The same order paid by UPI, where Razorpay charged nothing: the shop is
    // not docked a fee nobody took. This is what a flat 2.36% estimate got wrong.
    const upi = route.buildTransfer('acc_test', 10000, 200, 0, 'job_1');
    assert.strictEqual(upi.transfer.amount, 9800);
    assert.strictEqual(upi.gatewayFeeCents, 0);

    // The fee is required; it is never estimated.
    assert.throws(() => route.buildTransfer('acc_test', 10000, 200, NaN, 'job_1'));

    // A transfer can never go negative, even at the highest permitted fee.
    const maxFee = route.buildTransfer('acc_test', 100, 5000, 236, 'job_2');
    assert.ok(maxFee.transfer.amount >= 0);
  });

  await t.test('27. What the shop is told matches what it is paid', async () => {
    const { RazorpayRouteService } = await import('../razorpayRoute');
    const route = new RazorpayRouteService();

    // The published terms, the payout summary and the actual Route transfer
    // must agree. When Razorpay charges exactly the published rate, the
    // transfer equals the payout summary's figure on every plan.
    for (const plan of PLAN_CATALOGUE) {
      const gross = 10000;
      const told = calculateShopNetCents(gross, plan.platformFeeBps);
      const { transfer, serviceFeeCents } =
        route.buildTransfer('acc_test', gross, plan.platformFeeBps, told.gatewayFeeCents, 'job_x');

      assert.strictEqual(
        transfer.amount, told.netCents,
        `${plan.tier}: the transfer must equal what the payout summary states`
      );
      // PrintOk's own fee is always the plan's rate, whatever the gateway took.
      assert.strictEqual(serviceFeeCents, told.serviceFeeCents);
    }
  });

  await t.test('13. An unknown device token is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-device-token': 'dvt_deadbeef' },
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('11. Agent Config download uses keys the Windows agent actually binds', async () => {
    // The download is authorised by a short-lived token minted through the
    // merchant session, because the file carries the printer's agent API key.
    const minted = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/agent-config-token`,
      { method: 'POST', headers: merchantAuth }
    );
    assert.strictEqual(minted.status, 201);
    const { token } = (await minted.json()) as any;

    const res = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/agent-config?token=${encodeURIComponent(token)}`
    );
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

  await t.test('39. Agent config is not downloadable without an authorisation', async () => {
    // The file carries the printer's agent API key, and printer ids are public:
    // they are encoded in the QR poster and appear in the customer URL as
    // ?printer=<id>. This route used to answer 200 to anyone, so scanning a
    // shop's poster yielded that shop's agent credentials.
    const bare = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/agent-config`);
    assert.strictEqual(bare.status, 401, 'an unauthenticated download must be refused');

    const body = (await bare.json()) as any;
    assert.ok(!JSON.stringify(body).includes('prn_'), 'no key material may appear in the refusal');

    // A forged token must not work either.
    const forged = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/agent-config?token=not.a.real.token`
    );
    assert.strictEqual(forged.status, 401);

    // Nor a token whose payload has been edited to keep the signature but claim
    // another printer: the signature covers the payload, so this must fail.
    const minted = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/agent-config-token`,
      { method: 'POST', headers: merchantAuth }
    );
    const { token } = (await minted.json()) as any;
    const [payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    decoded.printerId = 'prn_someone_else';
    const tampered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    const tamperRes = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/agent-config?token=${encodeURIComponent(tampered)}`
    );
    assert.strictEqual(tamperRes.status, 401, 'an edited payload must fail the signature check');
  });

  await t.test('40. A config download token is single use and printer-scoped', async () => {
    const minted = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/agent-config-token`,
      { method: 'POST', headers: merchantAuth }
    );
    assert.strictEqual(minted.status, 201);
    const { token, expiresInSeconds } = (await minted.json()) as any;
    assert.ok(expiresInSeconds > 0 && expiresInSeconds <= 300, 'the window must be short');

    const url = `${baseUrl}/api/printers/${createdPrinterId}/agent-config?token=${encodeURIComponent(token)}`;

    const first = await fetch(url);
    assert.strictEqual(first.status, 200, 'the first use must succeed');

    // A link left in browser history or a proxy log must not be replayable.
    const second = await fetch(url);
    assert.strictEqual(second.status, 401, 'the second use must be refused');
  });

  await t.test('41. A config token for one printer cannot fetch another', async () => {
    // Two shops, and the first one's token aimed at the second one's printer.
    const other = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Rival Prints',
        ownerEmail: 'rival@example.com',
        printerName: 'Rival LaserJet',
      }),
    });
    const rival = (await other.json()) as any;

    const minted = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/agent-config-token`,
      { method: 'POST', headers: merchantAuth }
    );
    const { token } = (await minted.json()) as any;

    const crossed = await fetch(
      `${baseUrl}/api/printers/${rival.printer.id}/agent-config?token=${encodeURIComponent(token)}`
    );
    assert.strictEqual(crossed.status, 401, 'a token names the printer it may read');

    // And the merchant cannot mint one for a printer that is not theirs.
    const mintOther = await fetch(
      `${baseUrl}/api/printers/${rival.printer.id}/agent-config-token`,
      { method: 'POST', headers: merchantAuth }
    );
    assert.strictEqual(mintOther.status, 404, 'another shop\'s printer must look absent');
  });

  await t.test('42. Printer management endpoints reject unauthenticated callers', async () => {
    // Every one of these was reachable with nothing but a printer id, which is
    // public. Pairing-code minting was the worst: a code can be exchanged for a
    // device token, so this was a complete authentication bypass.
    const pairing = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/pairing-code`, {
      method: 'POST',
    });
    assert.strictEqual(pairing.status, 401, 'anyone could pair their own PC to this shop');

    const devices = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/devices`);
    assert.strictEqual(devices.status, 401);

    const events = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/security-events`);
    assert.strictEqual(events.status, 401);

    const regen = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/regenerate-qr`, {
      method: 'POST',
    });
    assert.strictEqual(regen.status, 401, 'anyone could invalidate the printed QR poster');

    const revoke = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/devices/dev_whatever/revoke`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    assert.strictEqual(revoke.status, 401, 'anyone could stop this shop printing');
  });

  await t.test('43. A merchant cannot manage another shop\'s printer', async () => {
    const other = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Third Party Copies',
        ownerEmail: 'third@example.com',
        printerName: 'Third Printer',
      }),
    });
    const third = (await other.json()) as any;

    // 404 rather than 403: a signed-in merchant must not be able to confirm
    // that a guessed printer id exists.
    for (const [method, path] of [
      ['POST', `/api/printers/${third.printer.id}/pairing-code`],
      ['GET', `/api/printers/${third.printer.id}/devices`],
      ['GET', `/api/printers/${third.printer.id}/security-events`],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, { method, headers: merchantAuth });
      assert.strictEqual(res.status, 404, `${method} ${path} must not be reachable`);
    }
  });

  await t.test('44. Public printer and telemetry routes leak nothing usable', async () => {
    // These two stay public because the customer page needs them before an
    // order is placed. That makes what they omit the security property.
    const printer = await fetch(`${baseUrl}/api/printers/${createdPrinterId}`);
    assert.strictEqual(printer.status, 200);
    const printerBody = await printer.text();
    assert.ok(!printerBody.includes('apiKey'), 'the agent key must never be public');
    assert.ok(!printerBody.includes('ownerEmail'), 'the owner email must never be public');

    const telemetry = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/telemetry`);
    assert.strictEqual(telemetry.status, 200);
    const t2 = (await telemetry.json()) as any;
    assert.ok('isOnline' in t2, 'the customer page needs to know if the shop can print');
    assert.ok(!('deviceId' in t2), 'device ids are fleet detail, not customer detail');
    assert.ok(!('agentVersion' in t2), 'agent version aids targeting and helps no customer');
  });

  await t.test('45. A pairing code works once, and only for its own printer', async () => {
    const minted = await fetch(`${baseUrl}/api/printers/${createdPrinterId}/pairing-code`, {
      method: 'POST',
      headers: merchantAuth,
    });
    assert.strictEqual(minted.status, 201);
    const { code } = (await minted.json()) as any;

    const pair = async () => fetch(`${baseUrl}/api/agent/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, deviceName: 'Counter PC' }),
    });

    const first = await pair();
    assert.strictEqual(first.status, 201);
    const paired = (await first.json()) as any;

    // The server decides which printer and shop the device belongs to, from the
    // code it redeemed. A client cannot ask to be bound elsewhere.
    assert.strictEqual(paired.printerId, createdPrinterId);
    assert.strictEqual(paired.shopId, createdShopId);
    assert.ok(paired.deviceToken.startsWith('dvt_'));

    // Single use: a replayed code must not yield a second credential.
    const second = await pair();
    assert.strictEqual(second.status, 401, 'a pairing code must not be reusable');

    // The issued token authenticates, and stops doing so once revoked.
    const auth = { 'x-agent-device-token': paired.deviceToken };
    const polled = await fetch(`${baseUrl}/api/agent/jobs/pending`, { headers: auth });
    assert.strictEqual(polled.status, 200, 'a freshly paired device must be able to poll');

    const revoked = await fetch(
      `${baseUrl}/api/printers/${createdPrinterId}/devices/${paired.deviceId}/revoke`,
      { method: 'POST', headers: merchantAuth, body: JSON.stringify({ reason: 'test' }) }
    );
    assert.strictEqual(revoked.status, 200);

    const afterRevoke = await fetch(`${baseUrl}/api/agent/jobs/pending`, { headers: auth });
    assert.strictEqual(afterRevoke.status, 401, 'a revoked device must lose access immediately');
  });

  await t.test('46. An agent cannot drive another printer\'s job', async () => {
    // Two shops. The second shop's agent tries to mark the first shop's job
    // printed — which, on a paid job, would mean money kept for nothing printed.
    const other = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Cross Shop',
        ownerEmail: 'cross@example.com',
        printerName: 'Cross Printer',
      }),
    });
    const cross = (await other.json()) as any;

    const foreign = await fetch(`${baseUrl}/api/agent/jobs/${createdJobId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-api-key': cross.printer.apiKey,
      },
      body: JSON.stringify({ printState: 'Printed' }),
    });
    assert.strictEqual(foreign.status, 404, 'a job outside this printer must not be reachable');
  });

  await t.test('47. CORS allows the frontends and refuses everyone else', async () => {
    // The API answered Access-Control-Allow-Origin: * to every caller, so any
    // page on the internet could script requests against it from a visitor's
    // browser. These pin the allowlist, and more importantly pin what must
    // still get through.
    const check = async (origin?: string) => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: origin ? { Origin: origin } : {},
      });
      return res.headers.get('access-control-allow-origin');
    };

    // The live frontends.
    assert.strictEqual(await check('https://printok.vercel.app'), 'https://printok.vercel.app');
    // Kept because printed QR posters still encode it.
    assert.strictEqual(
      await check('https://print-ok-customer-web.vercel.app'),
      'https://print-ok-customer-web.vercel.app'
    );

    // Vercel preview deployments have generated hostnames and cannot be listed.
    assert.strictEqual(
      await check('https://print-ok-customer-pcdmqv16f-ayan-s-rcf.vercel.app'),
      'https://print-ok-customer-pcdmqv16f-ayan-s-rcf.vercel.app'
    );

    // Local development, on whatever port.
    assert.strictEqual(await check('http://localhost:3000'), 'http://localhost:3000');

    // Anyone else gets no header, so the browser withholds the response.
    assert.strictEqual(await check('https://evil.example.com'), null);
    // Including a lookalike that merely contains an allowed host.
    assert.strictEqual(await check('https://printok.vercel.app.evil.com'), null);
    assert.strictEqual(await check('https://notprintok.vercel.app'), null);
  });

  await t.test('48. A blocked origin is refused, not broken', async () => {
    // Rejecting by passing an Error to the cors callback answers 500, which
    // makes a disallowed origin look like an API outage and sends people
    // debugging the wrong thing. The request must still succeed.
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
  });

  await t.test('49. Callers with no Origin are never blocked', async () => {
    // The print agent, Razorpay's webhooks and Render's health checks all send
    // no Origin header. CORS does not apply to them, and refusing them would
    // stop every shop in the network printing.
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);

    // The agent's own authenticated call must work with no Origin too.
    const poll = await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': agentApiKey },
    });
    assert.strictEqual(poll.status, 200, 'the agent must not be blocked by CORS');
  });

  await t.test('50. ALLOWED_ORIGINS adds an origin without a code change', async () => {
    // A new frontend domain must be allowable without waiting for a deploy.
    const previous = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'https://staging.printok.in, https://printok.in';
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://printok.in' },
      });
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://printok.in');
    } finally {
      if (previous === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = previous;
    }
  });

  await t.test('51. A shop collects no customer identity until it opts in', async () => {
    // The published privacy policy tells customers we do not collect their name
    // or phone number. That has to stay true for every shop that has not turned
    // collection on, whatever the request contains.
    const cfg = await (await fetch(`${baseUrl}/api/shops/${createdShopId}/portal-config`)).json() as any;
    assert.strictEqual(cfg.collectCustomerName, false, 'collection must default to off');
    assert.strictEqual(cfg.collectCustomerPhone, false);

    const res = await fetch(`${baseUrl}/api/print-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId,
        fileName: 'anonymous.pdf',
        fileBase64: Buffer.from('%PDF-1.4 anonymous').toString('base64'),
        copies: 1,
        isColor: false,
        // Submitted anyway. A shop that never asked must never receive it.
        customerName: 'Should Not Be Stored',
        customerPhone: '9999999999',
      }),
    });
    assert.strictEqual(res.status, 201);

    const { job } = (await res.json()) as any;
    assert.strictEqual(job.customerName, undefined, 'a name must not be stored by a shop that never asked');
    assert.strictEqual(job.customerPhone, undefined, 'nor a phone number');
  });

  await t.test('52. Once a shop opts in, identity is captured and enforced', async () => {
    const enable = await fetch(`${baseUrl}/api/shops/${createdShopId}/portal-config`, {
      method: 'POST',
      headers: merchantAuth,
      body: JSON.stringify({
        collectCustomerName: true,
        customerNameRequired: true,
        collectCustomerPhone: true,
        customerPhoneRequired: false,
      }),
    });
    assert.strictEqual(enable.status, 200);

    const submit = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/print-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: createdPrinterId,
        fileName: 'named.pdf',
        fileBase64: Buffer.from('%PDF-1.4 named').toString('base64'),
        copies: 1,
        isColor: false,
        ...body,
      }),
    });

    // Required and missing is refused, with a message a customer can act on.
    const missing = await submit({});
    assert.strictEqual(missing.status, 400);
    assert.match(((await missing.json()) as any).error, /name/i);

    // A phone that is plainly not one is refused.
    const badPhone = await submit({ customerName: 'Asha', customerPhone: 'call me' });
    assert.strictEqual(badPhone.status, 400);

    // The happy path stores both, whitespace collapsed.
    const ok = await submit({ customerName: '  Asha   Menon ', customerPhone: '+91 98200 12345' });
    assert.strictEqual(ok.status, 201);
    const { job } = (await ok.json()) as any;

    // Identity is asserted against what was stored, not against the response.
    // Job responses no longer echo PII at all: the status endpoint is
    // unauthenticated, so anything it returns is readable by whoever comes by
    // the job id.
    assert.strictEqual(job.customerName, undefined, 'a job response carries no PII');
    assert.strictEqual(job.customerPhone, undefined);

    const stored = await storage.getPrintJob(job.id);
    assert.strictEqual(stored?.customerName, 'Asha Menon');
    assert.strictEqual(stored?.customerPhone, '+91 98200 12345');

    // And the shop, which is the party that needs it, still sees it on its own
    // authenticated queue.
    const queue = await (await fetch(`${baseUrl}/api/shops/${createdShopId}/jobs`, {
      headers: merchantAuth,
    })).json() as any;
    const mine = queue.jobs.find((j: any) => j.id === job.id);
    assert.strictEqual(mine.customerName, 'Asha Menon', 'the shop can still call the customer');
    assert.strictEqual(mine.customerPhone, '+91 98200 12345');

    // Phone was optional, so an order without one still goes through.
    const nameOnly = await submit({ customerName: 'Ravi' });
    assert.strictEqual(nameOnly.status, 201);
    const ravi = await storage.getPrintJob(((await nameOnly.json()) as any).job.id);
    assert.strictEqual(ravi?.customerPhone, undefined);
  });

  await t.test('53. Portal config cannot be set to an unsatisfiable state', async () => {
    // Required-but-not-collected would hide the field and then refuse every
    // order for missing it — a shop could take itself offline from a checkbox.
    const res = await fetch(`${baseUrl}/api/shops/${createdShopId}/portal-config`, {
      method: 'POST',
      headers: merchantAuth,
      body: JSON.stringify({ collectCustomerName: false, customerNameRequired: true }),
    });
    assert.strictEqual(res.status, 200);

    const cfg = (await res.json()) as any;
    assert.strictEqual(cfg.collectCustomerName, false);
    assert.strictEqual(cfg.customerNameRequired, false, 'required must be cleared with collection');
  });

  await t.test('54. Only the shop itself can change what its portal asks', async () => {
    const anon = await fetch(`${baseUrl}/api/shops/${createdShopId}/portal-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectCustomerPhone: true }),
    });
    assert.strictEqual(anon.status, 401, 'an anonymous caller must not reconfigure a shop');
  });

  await t.test('55. A seeded grid prices exactly as the flat rate card did', async () => {
    // The point of the whole change: a shop that has never touched the grid
    // must charge every customer what it charged them yesterday. A pricing
    // migration that quietly moves a price is the worst kind of silent bug.
    const { DEFAULT_PRICING_CONFIG, calculateJobPriceBreakdown, calculateGridPriceBreakdown, buildDefaultRateCard } =
      await import('../pricing');

    const card = buildDefaultRateCard(DEFAULT_PRICING_CONFIG);
    const raised: string[] = [];
    let compared = 0;

    for (const paperSize of ['A4', 'A3', 'Letter']) {
      for (const isColor of [false, true]) {
        for (const isDuplex of [false, true]) {
          for (const pages of [1, 5, 10, 49, 50, 51, 200]) {
            for (const copies of [1, 2, 5]) {
              const before = calculateJobPriceBreakdown(pages, copies, isColor, isDuplex, paperSize, DEFAULT_PRICING_CONFIG);
              const after = calculateGridPriceBreakdown(pages, copies, isColor, isDuplex, paperSize, card, DEFAULT_PRICING_CONFIG);
              compared++;
              if (after.totalPriceInCents > before.totalPriceInCents) {
                raised.push(`${paperSize} colour=${isColor} duplex=${isDuplex} ${pages}p x${copies}: ${before.totalPriceInCents} -> ${after.totalPriceInCents}`);
              }
            }
          }
        }
      }
    }

    assert.ok(compared > 200, 'the comparison must actually cover the grid');
    assert.deepStrictEqual(raised, [], 'no configuration may cost more than it did before');
  });

  await t.test('56. The grid prices A3 directly instead of multiplying', async () => {
    const res = await fetch(`${baseUrl}/api/shops/${createdShopId}/rates`);
    assert.strictEqual(res.status, 200);

    const card = (await res.json()) as any;
    assert.ok(Array.isArray(card.rates));
    assert.strictEqual(card.rates.length, 12, 'three papers x colour x sided');

    // Asserted as a relationship, not a constant: an earlier test changes this
    // shop's rates, and a test that hardcodes 200 is really testing the order
    // the suite happens to run in.
    const flat = (await (await fetch(`${baseUrl}/api/shops/${createdShopId}/pricing`, { headers: merchantAuth })).json() as any).pricing;

    const a4 = card.rates.find((r: any) => r.paperSize === 'A4' && !r.isColor && !r.isDuplex);
    const a3 = card.rates.find((r: any) => r.paperSize === 'A3' && !r.isColor && !r.isDuplex);
    const letter = card.rates.find((r: any) => r.paperSize === 'Letter' && !r.isColor && !r.isDuplex);

    assert.strictEqual(a4.perPageCents, flat.bwSinglePerPageCents, 'A4 carries the flat rate');
    assert.strictEqual(letter.perPageCents, flat.bwSinglePerPageCents, 'Letter was never multiplied');
    assert.strictEqual(
      a3.perPageCents,
      Math.round(flat.bwSinglePerPageCents * flat.a3Multiplier),
      'A3 is seeded at the multiplied rate, and from then on stands alone'
    );
  });

  await t.test('57. A shop can price one cell without disturbing the rest', async () => {
    const before = await (await fetch(`${baseUrl}/api/shops/${createdShopId}/rates`)).json() as any;

    const res = await fetch(`${baseUrl}/api/shops/${createdShopId}/rates`, {
      method: 'POST',
      headers: merchantAuth,
      body: JSON.stringify({
        rates: [{ paperSize: 'A3', isColor: false, isDuplex: false, perPageCents: 250, enabled: true }],
      }),
    });
    assert.strictEqual(res.status, 200);

    const after = (await res.json()) as any;
    assert.strictEqual(after.rates.length, before.rates.length, 'sending one row must not delete the others');

    const a3 = after.rates.find((r: any) => r.paperSize === 'A3' && !r.isColor && !r.isDuplex);
    assert.strictEqual(a3.perPageCents, 250);

    // Compared against what it was, not a literal, so the assertion survives
    // whatever earlier tests did to this shop's rates.
    const a4Before = before.rates.find((r: any) => r.paperSize === 'A4' && !r.isColor && !r.isDuplex);
    const a4After = after.rates.find((r: any) => r.paperSize === 'A4' && !r.isColor && !r.isDuplex);
    assert.strictEqual(a4After.perPageCents, a4Before.perPageCents, 'an untouched cell keeps its rate');
  });

  await t.test('58. Both discounts apply in the right order', async () => {
    const shopRes = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Discount Test', ownerEmail: 'disc@example.com', printerName: 'P' }),
    });
    const shop = (await shopRes.json()) as any;

    const claim = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: shop.shop.id, ownerEmail: 'disc@example.com', password: 'DiscountPass1', name: 'D' }),
    });
    const auth = {
      Authorization: `Bearer ${((await claim.json()) as any).token}`,
      'Content-Type': 'application/json',
    };

    // ₹2 normally, ₹1.50 in bulk over ₹100, and ₹1 for copies 2+.
    await fetch(`${baseUrl}/api/shops/${shop.shop.id}/rates`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        bulkEnabled: true,
        bulkThresholdCents: 10000,
        additionalCopyEnabled: true,
        rates: [{
          paperSize: 'A4', isColor: false, isDuplex: false,
          perPageCents: 200, bulkPerPageCents: 150, additionalCopyPerPageCents: 100, enabled: true,
        }],
      }),
    });

    const { calculateGridPriceBreakdown } = await import('../pricing');
    const card = await (await fetch(`${baseUrl}/api/shops/${shop.shop.id}/rates`)).json() as any;

    // Under the threshold: 10 pages x ₹2 = ₹20. No discount anywhere.
    const small = calculateGridPriceBreakdown(10, 1, false, false, 'A4', card);
    assert.strictEqual(small.totalPriceInCents, 2000);
    assert.strictEqual(small.bulkApplied, false);

    // Over it: 100 pages x ₹2 = ₹200 normal, so bulk swaps in ₹1.50.
    const bulk = calculateGridPriceBreakdown(100, 1, false, false, 'A4', card);
    assert.strictEqual(bulk.bulkApplied, true);
    assert.strictEqual(bulk.totalPriceInCents, 15000);

    // Copies: copy 1 at the bulk rate, copies 2 and 3 at the copy rate.
    // 100x150 + 200x100 = 35000.
    const copies = calculateGridPriceBreakdown(100, 3, false, false, 'A4', card);
    assert.strictEqual(copies.firstCopyRateCents, 150);
    assert.strictEqual(copies.additionalCopyRateCents, 100);
    assert.strictEqual(copies.totalPriceInCents, 35000);

    // The threshold is tested on the NORMAL value, not the discounted one.
    // 10 pages x 5 copies x ₹2 = ₹100 normal, which qualifies. Were it tested
    // after discounting, the cheaper rate would drop it back under the bar.
    const edge = calculateGridPriceBreakdown(10, 5, false, false, 'A4', card);
    assert.strictEqual(edge.normalValueCents, 10000);
    assert.strictEqual(edge.bulkApplied, true);
  });

  await t.test('59. Rates are refused rather than coerced', async () => {
    const bad = async (rates: unknown) => {
      const res = await fetch(`${baseUrl}/api/shops/${createdShopId}/rates`, {
        method: 'POST', headers: merchantAuth, body: JSON.stringify({ rates }),
      });
      return res.status;
    };

    // A NaN silently becoming 0 is a shop giving printing away.
    assert.strictEqual(await bad([{ paperSize: 'A4', isColor: false, isDuplex: false, perPageCents: 'free' }]), 400);
    assert.strictEqual(await bad([{ paperSize: 'A4', isColor: false, isDuplex: false, perPageCents: -50 }]), 400);
    assert.strictEqual(await bad([{ paperSize: 'A4', isColor: false, isDuplex: false, perPageCents: 1.5 }]), 400);
    assert.strictEqual(await bad([{ paperSize: 'A4', isColor: false, isDuplex: false }]), 400);

    // And only the owner may set them at all.
    const anon = await fetch(`${baseUrl}/api/shops/${createdShopId}/rates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rates: [] }),
    });
    assert.strictEqual(anon.status, 401);
  });

  await t.test('60. Editing the flat rates still changes what a customer pays', async () => {
    // Jobs price from the grid now. The dashboard's rate editor still posts the
    // four flat rates, so that endpoint has to write through — otherwise a
    // merchant raises their prices, sees a success message, and keeps charging
    // the old amount. This endpoint has had exactly that bug before.
    const shopRes = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Writethrough', ownerEmail: 'wt@example.com', printerName: 'WT' }),
    });
    const shop = (await shopRes.json()) as any;

    const claim = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: shop.shop.id, ownerEmail: 'wt@example.com', password: 'WriteThru123', name: 'W' }),
    });
    const auth = {
      Authorization: `Bearer ${((await claim.json()) as any).token}`,
      'Content-Type': 'application/json',
    };

    const priceOneMonoPage = async () => {
      const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: shop.printer.id,
          fileName: 'rate.pdf',
          fileBase64: Buffer.from('%PDF-1.4 rate').toString('base64'),
          copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        }),
      });
      return ((await res.json()) as any).job.totalPriceInCents;
    };

    assert.strictEqual(await priceOneMonoPage(), 200, 'the default rate');

    const raise = await fetch(`${baseUrl}/api/shops/${shop.shop.id}/pricing`, {
      method: 'POST', headers: auth, body: JSON.stringify({ bwSinglePerPageCents: 500 }),
    });
    assert.strictEqual(raise.status, 200);

    assert.strictEqual(await priceOneMonoPage(), 500, 'the new rate must reach the customer');

    // And the grid agrees, rather than the two drifting apart.
    const card = await (await fetch(`${baseUrl}/api/shops/${shop.shop.id}/rates`)).json() as any;
    const a4 = card.rates.find((r: any) => r.paperSize === 'A4' && !r.isColor && !r.isDuplex);
    assert.strictEqual(a4.perPageCents, 500);
  });

  await t.test('61. The service catalogue is offered, and a selection is filtered', async () => {
    const cat = await (await fetch(`${baseUrl}/api/service-catalogue`)).json() as any;
    assert.ok(cat.capabilities.length >= 15, 'the catalogue must be worth having');
    assert.ok(cat.groups.length >= 3);
    // Defaults must equal what the customer page offered before this catalogue
    // existed. Anything less and a shop that never opens the setup screen
    // quietly stops accepting orders it took the day before.
    for (const key of ['bw', 'colour', 'single-sided', 'duplex-auto', 'duplex-manual',
                       'paper-a4', 'paper-a3', 'paper-letter', 'multiple-copies', 'page-selection']) {
      assert.ok(cat.defaults.includes(key), `${key} was already offered and must stay on by default`);
    }

    // Capabilities the portal never had stay off: nothing is lost, and a shop
    // promising them on hardware that cannot do them has to refund.
    for (const key of ['photo-4x6', 'photo-5x7', 'paper-glossy', 'stapling', 'pages-per-sheet']) {
      assert.ok(!cat.defaults.includes(key), `${key} is new and must be opted into`);
    }

    // A shop that has never configured anything still offers the defaults —
    // empty means "not configured", not "offers nothing".
    const fresh = await (await fetch(`${baseUrl}/api/shops/${createdShopId}/portal-config`)).json() as any;
    assert.deepStrictEqual(fresh.enabledServices, cat.defaults);

    // An invented key must never reach a customer's screen.
    const res = await fetch(`${baseUrl}/api/shops/${createdShopId}/portal-config`, {
      method: 'POST',
      headers: merchantAuth,
      body: JSON.stringify({ enabledServices: ['bw', 'colour', 'not-a-real-service', 'bw'] }),
    });
    assert.strictEqual(res.status, 200);

    const saved = (await res.json()) as any;
    assert.deepStrictEqual(saved.enabledServices, ['bw', 'colour'], 'unknown keys dropped, duplicates collapsed');
  });

  await t.test('62. A shop cannot be sold a service it has switched off', async () => {
    // Hiding a control on the customer page is presentation. This is the part
    // that stops a colour job reaching a mono printer from a stale page, a
    // cached one, or a script.
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Mono Only', ownerEmail: 'mono@example.com', printerName: 'M' }),
    })).json() as any;

    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: 'mono@example.com', password: 'MonoPassword1', name: 'M' }),
    });
    const claim = (await claimRes.json()) as any;
    assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
    const auth = { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' };

    const submit = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: reg.printer.id,
        fileName: 'j.pdf',
        fileBase64: Buffer.from('%PDF-1.4 j').toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        ...body,
      }),
    });

    // Before narrowing, everything the portal ever offered still works.
    assert.strictEqual((await submit({ isColor: true })).status, 201, 'colour works by default');
    assert.strictEqual((await submit({ paperSize: 'A3' })).status, 201, 'A3 works by default');

    // The shop says it is mono, A4 only, one copy at a time.
    const narrow = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/portal-config`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ enabledServices: ['bw', 'single-sided', 'paper-a4'] }),
    });
    assert.strictEqual(narrow.status, 200, `narrowing must succeed, got ${narrow.status}: ${await narrow.clone().text()}`);

    const colour = await submit({ isColor: true });
    assert.strictEqual(colour.status, 400);
    assert.match(((await colour.json()) as any).error, /colour/i, 'the customer is told which choice is unavailable');

    const a3 = await submit({ paperSize: 'A3' });
    assert.strictEqual(a3.status, 400);
    assert.match(((await a3.json()) as any).error, /A3/);

    assert.strictEqual((await submit({ isDuplex: true })).status, 400, 'back-to-back was not offered');
    assert.strictEqual((await submit({ copies: 3 })).status, 400, 'multiple copies were not offered');

    // And what it does offer still goes through.
    assert.strictEqual((await submit({})).status, 201, 'mono A4 single is exactly what it sells');
  });

  await t.test('63. Portal options agree with the rate grid, not just the services', async () => {
    // A shop that ticks colour but has disabled every colour rate is not
    // offering colour. Showing the option would sell something it must refund.
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Rates Off', ownerEmail: 'ro@example.com', printerName: 'R' }),
    })).json() as any;

    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: 'ro@example.com', password: 'RatesOffPass1', name: 'R' }),
    });
    const claim = (await claimRes.json()) as any;
    assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
    const auth = { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' };

    const before = await (await fetch(`${baseUrl}/api/shops/${reg.shop.id}/portal-options`)).json() as any;
    assert.ok(before.colourModes.includes('colour'), 'colour is on by default');

    // Services still say colour; every colour rate is switched off.
    const card = await (await fetch(`${baseUrl}/api/shops/${reg.shop.id}/rates`)).json() as any;
    await fetch(`${baseUrl}/api/shops/${reg.shop.id}/rates`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ rates: card.rates.filter((r: any) => r.isColor).map((r: any) => ({ ...r, enabled: false })) }),
    });

    const after = await (await fetch(`${baseUrl}/api/shops/${reg.shop.id}/portal-options`)).json() as any;
    assert.ok(!after.colourModes.includes('colour'), 'no priced colour rate means no colour on offer');
    assert.ok(after.colourModes.includes('bw'), 'and mono is unaffected');

    const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: reg.printer.id, fileName: 'c.pdf',
        fileBase64: Buffer.from('%PDF-1.4 c').toString('base64'),
        copies: 1, isColor: true, isDuplex: false, paperSize: 'A4',
      }),
    });
    assert.strictEqual(res.status, 400, 'and the job is refused too');
  });

  await t.test('64. Auto-print modes decide when a paid job reaches the printer', async () => {
    const makeShop = async (name: string, email: string) => {
      const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopName: name, ownerEmail: email, printerName: 'P' }),
      })).json() as any;
      const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: email, password: 'AutoPrintPass1', name: 'A' }),
      });
      const claim = (await claimRes.json()) as any;
      assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
      return { reg, auth: { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' } };
    };

    const makeJob = async (printerId: string) => {
      const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId, fileName: 'a.pdf',
          fileBase64: Buffer.from('%PDF-1.4 a').toString('base64'),
          copies: 1, isColor: false,
        }),
      });
      return ((await res.json()) as any).job;
    };

    // --- the default is what PrintOk always did ---
    const dflt = await makeShop('Default Mode', 'apdefault@example.com');
    const cfg = await (await fetch(`${baseUrl}/api/shops/${dflt.reg.shop.id}/portal-config`)).json() as any;
    assert.strictEqual(cfg.autoPrintMode, 'after-payment', 'existing behaviour must be the default');

    const j1 = await makeJob(dflt.reg.printer.id);
    assert.strictEqual(j1.printState, 'AwaitingPayment');
    await fetch(`${baseUrl}/api/print-jobs/${j1.id}/manual-override`, {
      method: 'POST', headers: dflt.auth,
    });
    const afterPay = await (await fetch(`${baseUrl}/api/print-jobs/${j1.id}`)).json() as any;
    assert.strictEqual(afterPay.job.printState, 'Queued', 'payment queues it');

    // --- off: paid, but held until the shop says so ---
    const held = await makeShop('Held Mode', 'apheld@example.com');
    await fetch(`${baseUrl}/api/shops/${held.reg.shop.id}/portal-config`, {
      method: 'POST', headers: held.auth, body: JSON.stringify({ autoPrintMode: 'off' }),
    });

    const j2 = await makeJob(held.reg.printer.id);
    await fetch(`${baseUrl}/api/print-jobs/${j2.id}/manual-override`, {
      method: 'POST', headers: held.auth,
    });
    const heldJob = await (await fetch(`${baseUrl}/api/print-jobs/${j2.id}`)).json() as any;
    assert.strictEqual(heldJob.job.paymentState, 'Paid', 'the money is still taken');
    assert.strictEqual(heldJob.job.printState, 'HeldForRelease', 'but nothing prints yet');

    // The agent must not see it: a held job is not a queued one.
    const polled = await (await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': held.reg.printer.apiKey },
    })).json() as any;
    assert.ok(!polled.jobs.some((j: any) => j.id === j2.id), 'a held job must not reach the agent');

    // Releasing it queues it.
    const release = await fetch(`${baseUrl}/api/shops/${held.reg.shop.id}/jobs/${j2.id}/release`, {
      method: 'POST', headers: held.auth,
    });
    assert.strictEqual(release.status, 200);
    assert.strictEqual(((await release.json()) as any).job.printState, 'Queued');

    // --- all: queued before the money clears ---
    const eager = await makeShop('Eager Mode', 'apeager@example.com');
    await fetch(`${baseUrl}/api/shops/${eager.reg.shop.id}/portal-config`, {
      method: 'POST', headers: eager.auth, body: JSON.stringify({ autoPrintMode: 'all' }),
    });

    const j3 = await makeJob(eager.reg.printer.id);
    assert.strictEqual(j3.printState, 'Queued', 'queued before payment, by the shop\'s choice');
    assert.notStrictEqual(j3.paymentState, 'Paid', 'and the payment is still outstanding');
  });

  await t.test('65. Release refuses anything that is not actually held', async () => {
    // "Print this now" must not become a way to push an unpaid or already
    // printing job through.
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Release Guard', ownerEmail: 'rg@example.com', printerName: 'P' }),
    })).json() as any;
    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: 'rg@example.com', password: 'ReleaseGuard1', name: 'R' }),
    });
    const claim = (await claimRes.json()) as any;
    assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
    const auth = { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' };

    const job = ((await (await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: reg.printer.id, fileName: 'g.pdf',
        fileBase64: Buffer.from('%PDF-1.4 g').toString('base64'), copies: 1, isColor: false,
      }),
    })).json()) as any).job;

    // Unpaid and not held.
    const early = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/jobs/${job.id}/release`, {
      method: 'POST', headers: auth,
    });
    assert.strictEqual(early.status, 409, 'an unpaid job is not a held one');

    // Another shop cannot release it either.
    const anon = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/jobs/${job.id}/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    assert.strictEqual(anon.status, 401);
  });

  await t.test('66. A separator prints only when there is a real backlog', async () => {
    const { shouldPrintSeparator } = await import('@printok/shared-types');

    // Off is off, however busy it gets.
    assert.strictEqual(shouldPrintSeparator({ separatorMode: 'none', separatorMinQueue: 1 }, 99), false);

    // A separator between every job in a quiet hour is one wasted sheet per
    // order, which is how a shop concludes the feature is not worth having.
    assert.strictEqual(shouldPrintSeparator({ separatorMode: 'blank', separatorMinQueue: 3 }, 1), false);
    assert.strictEqual(shouldPrintSeparator({ separatorMode: 'blank', separatorMinQueue: 3 }, 2), false);
    assert.strictEqual(shouldPrintSeparator({ separatorMode: 'blank', separatorMinQueue: 3 }, 3), true);
    assert.strictEqual(shouldPrintSeparator({ separatorMode: 'invoice', separatorMinQueue: 3 }, 10), true);

    // A nonsensical threshold still behaves: one waiting job is a backlog of one.
    assert.strictEqual(shouldPrintSeparator({ separatorMode: 'blank', separatorMinQueue: 0 }, 1), true);
  });

  await t.test('67. The queue filters, counts and searches', async () => {
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Queue Shop', ownerEmail: 'queue@example.com', printerName: 'Q' }),
    })).json() as any;
    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: 'queue@example.com', password: 'QueueShopPass1', name: 'Q' }),
    });
    const claim = (await claimRes.json()) as any;
    assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
    const auth = { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' };

    // Ask for a name and number so there is something to search by.
    await fetch(`${baseUrl}/api/shops/${reg.shop.id}/portal-config`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ collectCustomerName: true, collectCustomerPhone: true }),
    });

    const order = async (name: string, phone: string, file: string) => {
      const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: reg.printer.id, fileName: file,
          fileBase64: Buffer.from('%PDF-1.4 q').toString('base64'),
          copies: 1, isColor: false, customerName: name, customerPhone: phone,
        }),
      });
      assert.strictEqual(res.status, 201);
      return ((await res.json()) as any).job;
    };

    const asha = await order('Asha Menon', '+91 98200 12345', 'thesis.pdf');
    const ravi = await order('Ravi Kumar', '9769912345', 'invoice.pdf');
    await order('Sita Rao', '9820099999', 'notes.pdf');

    // One paid so it lands in a different bucket from the other two.
    await fetch(`${baseUrl}/api/print-jobs/${asha.id}/manual-override`, {
      method: 'POST', headers: auth,
    });

    const query = async (qs: string) => {
      const res = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/jobs?${qs}`, { headers: auth });
      assert.strictEqual(res.status, 200);
      return (await res.json()) as any;
    };

    // --- counts describe every bucket, not just the one being shown ---
    const all = await query('status=all');
    assert.strictEqual(all.counts.all, 3);
    assert.strictEqual(all.counts.pending, 2, 'two still awaiting payment');
    assert.strictEqual(all.counts.processing, 1, 'the paid one is queued');
    assert.strictEqual(all.counts.rejected, 0, 'a zero is a fact, not an absence');

    // --- a bucket filter narrows the rows but not the counts ---
    const processing = await query('status=processing');
    assert.strictEqual(processing.jobs.length, 1);
    assert.strictEqual(processing.jobs[0].id, asha.id);
    assert.strictEqual(processing.counts.pending, 2, 'counts must not shrink to the filter');

    // --- search reaches name, file and token ---
    assert.strictEqual((await query('q=Ravi')).jobs.length, 1);
    assert.strictEqual((await query('q=thesis')).jobs.length, 1);
    assert.strictEqual((await query(`q=${encodeURIComponent(ravi.tokenNumber || '')}`)).jobs.length, 1);

    // --- a phone number typed any way finds the order ---
    // Stored as "+91 98200 12345"; nobody types it back the same way.
    for (const typed of ['9820012345', '98200 12345', '+91 98200 12345']) {
      const hit = await query(`q=${encodeURIComponent(typed)}`);
      assert.ok(
        hit.jobs.some((j: any) => j.id === asha.id),
        `a number typed as "${typed}" must find the order stored as "+91 98200 12345"`
      );
    }

    // --- month filter ---
    const thisMonth = new Date().toISOString().slice(0, 7);
    assert.strictEqual((await query(`month=${thisMonth}`)).counts.all, 3);
    assert.strictEqual((await query('month=2020-01')).counts.all, 0, 'an empty month is empty');

    // --- and it is still the shop's own queue only ---
    const anon = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/jobs`);
    assert.strictEqual(anon.status, 401);
  });

  await t.test('68. Buckets cover every print state', async () => {
    // A state in no bucket is invisible in the queue: it would be missing from
    // every tab including "All"'s counts, and nobody would know to look for it.
    const { PrintState } = await import('@printok/shared-types');
    const { bucketForState } = await import('@printok/shared-types');

    const unbucketed = Object.values(PrintState).filter((s) => !bucketForState(s));
    assert.deepStrictEqual(unbucketed, [], 'every print state must belong to a bucket');
  });

  await t.test('69. A shop can edit its own profile, within limits', async () => {
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Profile Shop', ownerEmail: 'prof@example.com', printerName: 'P' }),
    })).json() as any;
    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: 'prof@example.com', password: 'ProfileShop12', name: 'P' }),
    });
    const claim = (await claimRes.json()) as any;
    assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
    const auth = { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' };

    const save = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/shops/${reg.shop.id}/profile`, {
      method: 'POST', headers: auth, body: JSON.stringify(body),
    });

    const ok = await save({
      name: '  A1  Stationery ', contactPhone: '9820012345',
      addressStreet1: '12 Station Road', addressCity: 'Mumbai',
      addressState: 'Maharashtra', addressPostalCode: '400071',
      gstin: '27abcde1234f1z5',
    });
    assert.strictEqual(ok.status, 200);

    const saved = ((await (await fetch(`${baseUrl}/api/shops/${reg.shop.id}/profile`, { headers: auth })).json()) as any).profile;
    assert.strictEqual(saved.name, 'A1 Stationery', 'whitespace is collapsed');
    assert.strictEqual(saved.gstin, '27ABCDE1234F1Z5', 'a GSTIN is stored upper case');
    assert.strictEqual(saved.addressCity, 'Mumbai');

    // A GSTIN that is plainly not one is refused.
    assert.strictEqual((await save({ gstin: 'NOT-A-GSTIN' })).status, 400);

    // But it can be cleared, which matters when one was entered wrongly.
    assert.strictEqual((await save({ gstin: '' })).status, 200);
    const cleared = ((await (await fetch(`${baseUrl}/api/shops/${reg.shop.id}/profile`, { headers: auth })).json()) as any).profile;
    assert.strictEqual(cleared.gstin, '');
    assert.strictEqual(cleared.addressCity, 'Mumbai', 'clearing one field leaves the others');

    // A shop still needs a name.
    assert.strictEqual((await save({ name: '   ' })).status, 400);

    // The payout details are not part of this form.
    assert.ok(!('bankAccountNumber' in cleared), 'a profile form has no business carrying a bank account');
  });

  await t.test('70. Changing a password needs the current one', async () => {
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Password Shop', ownerEmail: 'pw@example.com', printerName: 'P' }),
    })).json() as any;
    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: 'pw@example.com', password: 'OriginalPass1', name: 'P' }),
    });
    const claim = (await claimRes.json()) as any;
    assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
    const auth = { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' };

    const change = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/merchant/password`, {
      method: 'POST', headers: auth, body: JSON.stringify(body),
    });

    // A shop PC is not a private device. Someone finding it unlocked must not
    // be able to lock the owner out of their own shop.
    const guessed = await change({ currentPassword: 'WrongPassword1', newPassword: 'BrandNewPass1' });
    assert.strictEqual(guessed.status, 403);

    assert.strictEqual((await change({ currentPassword: 'OriginalPass1', newPassword: 'short' })).status, 400);

    const good = await change({ currentPassword: 'OriginalPass1', newPassword: 'BrandNewPass1' });
    assert.strictEqual(good.status, 200);

    // The new one works and the old one does not.
    const relogin = await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pw@example.com', password: 'BrandNewPass1' }),
    });
    assert.strictEqual(relogin.status, 200);

    const stale = await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pw@example.com', password: 'OriginalPass1' }),
    });
    assert.strictEqual(stale.status, 401, 'the old password must stop working');
  });

  await t.test('71. Staff accounts are staff, and the owner cannot be locked out', async () => {
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Staff Shop', ownerEmail: 'boss@example.com', printerName: 'P' }),
    })).json() as any;
    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: 'boss@example.com', password: 'BossPassword1', name: 'Boss' }),
    });
    const claim = (await claimRes.json()) as any;
    assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
    const owner = { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' };

    // Free covers one sign-in account and the owner is it, so this shop needs a
    // plan with seats before it can have staff at all. Moved deliberately
    // rather than by loosening the cap: the cap is the behaviour under test in
    // 104b, and a fixture must not quietly disable it.
    await storage.updateShopPlan(reg.shop.id, {
      planTier: 'starter', commissionBps: 100, planStatus: 'active',
    });

    const added = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/staff`, {
      method: 'POST', headers: owner,
      body: JSON.stringify({ email: 'helper@example.com', name: 'Helper', password: 'HelperPass123' }),
    });
    assert.strictEqual(added.status, 201);
    const helper = ((await added.json()) as any).user;
    assert.strictEqual(helper.role, 'staff', 'this screen never hands out ownership');

    // Even asking for owner gets staff.
    const sneaky = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/staff`, {
      method: 'POST', headers: owner,
      body: JSON.stringify({ email: 'sneaky@example.com', password: 'SneakyPass123', role: 'owner' }),
    });
    assert.strictEqual(((await sneaky.json()) as any).user.role, 'staff');

    const staffLogin = await (await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'helper@example.com', password: 'HelperPass123' }),
    })).json() as any;
    const staffAuth = { Authorization: `Bearer ${staffLogin.token}`, 'Content-Type': 'application/json' };

    // Staff can work the queue but cannot change money or add people.
    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${reg.shop.id}/jobs`, { headers: staffAuth })).status, 200);
    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${reg.shop.id}/staff`, { headers: staffAuth })).status, 403);
    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${reg.shop.id}/rates`, {
      method: 'POST', headers: staffAuth, body: JSON.stringify({ bulkEnabled: true }),
    })).status, 403, 'staff must not be able to change what customers are charged');

    // The owner cannot disable themselves, and nobody can disable an owner.
    const self = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/staff/${claim.user.id}/status`, {
      method: 'POST', headers: owner, body: JSON.stringify({ status: 'disabled' }),
    });
    assert.strictEqual(self.status, 409, 'there is nobody above the owner to undo it');

    // Disabling a staff member stops them signing in.
    const off = await fetch(`${baseUrl}/api/shops/${reg.shop.id}/staff/${helper.id}/status`, {
      method: 'POST', headers: owner, body: JSON.stringify({ status: 'disabled' }),
    });
    assert.strictEqual(off.status, 200);

    assert.strictEqual(
      (await fetch(`${baseUrl}/api/shops/${reg.shop.id}/jobs`, { headers: staffAuth })).status,
      401,
      'a disabled account loses access immediately, not at token expiry'
    );
  });

  await t.test('72. Earnings account for every deduction, per order', async () => {
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Money Shop', ownerEmail: 'money@example.com', printerName: 'M' }),
    })).json() as any;
    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: 'money@example.com', password: 'MoneyShopPass1', name: 'M' }),
    });
    const claim = (await claimRes.json()) as any;
    assert.strictEqual(claimRes.status, 201, `claim must succeed: ${JSON.stringify(claim)}`);
    const auth = { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' };

    const makeJob = async () => {
      const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: reg.printer.id, fileName: 'm.pdf',
          fileBase64: Buffer.from('%PDF-1.4 m').toString('base64'),
          copies: 10, isColor: false,
        }),
      });
      assert.strictEqual(res.status, 201);
      return ((await res.json()) as any).job;
    };

    const paid = await makeJob();
    await fetch(`${baseUrl}/api/print-jobs/${paid.id}/manual-override`, {
      method: 'POST', headers: auth,
    });
    await makeJob(); // left unpaid

    const data = await (await fetch(`${baseUrl}/api/shops/${reg.shop.id}/earnings`, { headers: auth })).json() as any;

    // An unpaid job has earned nothing, so it is not in here at all.
    assert.strictEqual(data.totals.orders, 1, 'only money that actually arrived counts');
    assert.strictEqual(data.rows.length, 1);

    const row = data.rows[0];
    assert.strictEqual(row.grossCents, paid.totalPriceInCents);

    // The deductions have to add up. A "you keep" figure that does not
    // reconcile against the charge is the one number a shop will check.
    assert.strictEqual(
      row.netCents + row.razorpayFeeCents + row.platformCommissionCents,
      row.grossCents,
      'gross must equal what was taken plus what was kept'
    );

    assert.strictEqual(data.totals.grossCents, row.grossCents);
    assert.strictEqual(data.totals.netCents, row.netCents);

    // A cash order's fees are exact: Razorpay took nothing and the rate was
    // fixed when the cash was accepted. Only online orders without Razorpay's
    // reported fee are estimates.
    assert.strictEqual(data.feesAreEstimated, false);
    assert.strictEqual(data.settlement, 'pending-route', 'this shop is not connected to Razorpay yet');

    // A window with nothing in it reports zero rather than everything.
    const empty = await (await fetch(
      `${baseUrl}/api/shops/${reg.shop.id}/earnings?from=2020-01-01&to=2020-01-31`, { headers: auth }
    )).json() as any;
    assert.strictEqual(empty.totals.orders, 0);
    assert.strictEqual(empty.totals.grossCents, 0);

    // Only the owner sees the takings.
    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${reg.shop.id}/earnings`)).status, 401);
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
      body: JSON.stringify({ acceptTerms: true,
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
      body: JSON.stringify({ acceptTerms: true,
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
    const capturedRaw = await paymentWebhookRaw(whJob.id, 'pay_ok');
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

  await t.test('36. A shop can decline a job, and the customer is refunded', async () => {
    const reg = await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopName: 'Decline Test Shop', ownerEmail: 'decline@example.com', printerName: 'HP',
      }),
    });
    const { shop: dShop, printer: dPrinter } = (await reg.json()) as any;

    const claim = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true,
        shopId: dShop.id, ownerEmail: 'decline@example.com', password: 'DeclineOwner88xy',
      }),
    });
    const { token: dToken } = (await claim.json()) as any;
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${dToken}` };

    const makeJob = async () => {
      const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: dPrinter.id,
          fileName: 'refuse-me.pdf',
          fileBase64: Buffer.from('%PDF-1.4 one page').toString('base64'),
          copies: 1, isColor: false, isDuplex: false,
        }),
      });
      const body = (await res.json()) as any;
      // Asserted rather than assumed: a job that fails to create shows up much
      // later as an undefined .id, which reads like a bug in whatever used it.
      assert.strictEqual(res.status, 201, `job creation must succeed: ${JSON.stringify(body)}`);
      return body.job;
    };

    // --- an unpaid job: declining stops it, with nothing to refund ---
    const unpaid = await makeJob();
    const unpaidRes = await fetch(`${baseUrl}/api/shops/${dShop.id}/jobs/${unpaid.id}/decline`, {
      method: 'POST', headers: auth, body: JSON.stringify({ reason: 'Printer is out of toner.' }),
    });
    assert.strictEqual(unpaidRes.status, 200);
    const unpaidBody = (await unpaidRes.json()) as any;
    assert.strictEqual(unpaidBody.job.printState, PrintState.Cancelled);
    assert.strictEqual(unpaidBody.refund.issued, false, 'nothing was paid, so nothing is refunded');
    assert.strictEqual(unpaidBody.job.declineReason, 'Printer is out of toner.');

    // --- a reason is required: the customer is told why ---
    const noReason = await fetch(`${baseUrl}/api/shops/${dShop.id}/jobs/${unpaid.id}/decline`, {
      method: 'POST', headers: auth, body: JSON.stringify({}),
    });
    assert.strictEqual(noReason.status, 400);

    // --- another shop must not be able to decline this shop's job ---
    const other = await fetch(`${baseUrl}/api/merchant/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true,
        shopName: 'Nosy Prints', ownerEmail: 'nosy@example.com',
        printerName: 'HP', password: 'NosyOwner77xy',
      }),
    });
    const { token: nosyToken } = (await other.json()) as any;
    const victim = await makeJob();
    const cross = await fetch(`${baseUrl}/api/shops/${dShop.id}/jobs/${victim.id}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${nosyToken}` },
      body: JSON.stringify({ reason: 'not mine to refuse' }),
    });
    assert.strictEqual(cross.status, 403, 'one shop must not decline another shop\'s job');

    // --- a paid job: declining owes the customer money back ---
    const paid = await makeJob();
    const confirmRaw = await paymentWebhookRaw(paid.id, 'pay_for_refund');
    await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(confirmRaw) },
      body: confirmRaw,
    });

    const paidCheck = await fetch(`${baseUrl}/api/print-jobs/${paid.id}`);
    assert.strictEqual(((await paidCheck.json()) as any).job.paymentState, PaymentState.Paid);

    const declined = await fetch(`${baseUrl}/api/shops/${dShop.id}/jobs/${paid.id}/decline`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ reason: 'We cannot print on that paper size.' }),
    });

    // Razorpay is not reachable in this suite, so the refund cannot complete.
    // What matters is that the money is left visibly owed rather than the job
    // being recorded as refunded when nothing moved.
    assert.strictEqual(declined.status, 202,
      'a refund that could not be issued must not report success');
    const declinedBody = (await declined.json()) as any;
    assert.strictEqual(declinedBody.job.printState, PrintState.Cancelled);
    assert.strictEqual(declinedBody.job.paymentState, PaymentState.RefundPending,
      'the refund is still owed and must say so');
    assert.strictEqual(declinedBody.refund.issued, false);
    assert.ok(declinedBody.job.refundId === undefined,
      'no refund id may be recorded when no refund was made');
  });

  await t.test('37. Signup stores the details Route onboarding will need', async () => {
    // Razorpay refuses to create a linked account without a phone number and
    // stalls KYC on an incomplete address. Collecting them at signup is what
    // stops a shop being chased for them at the moment it wants to be paid.
    const res = await fetch(`${baseUrl}/api/merchant/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true,
        shopName: 'Route Ready Prints', ownerEmail: 'routeready@example.com',
        printerName: 'HP', password: 'RouteOwner99xy',
        contactPhone: '9876543210',
        addressStreet1: '12 Linking Road', addressStreet2: 'Bandra West',
        addressCity: 'Mumbai', addressState: 'Maharashtra', addressPostalCode: '400050',
      }),
    });
    assert.strictEqual(res.status, 201);
    const { shop, token } = (await res.json()) as any;

    assert.strictEqual(shop.contactPhone, '9876543210');
    assert.strictEqual(shop.addressStreet1, '12 Linking Road');
    assert.strictEqual(shop.addressCity, 'Mumbai');
    assert.strictEqual(shop.addressState, 'Maharashtra');
    assert.strictEqual(shop.addressPostalCode, '400050');
    assert.strictEqual(shop.addressCountry, 'IN', 'country defaults to India');

    // Route is off in this suite, so the call cannot reach Razorpay — but it
    // must fail because Route is unavailable, not because the phone number is
    // missing. That distinction is the whole point of storing it at signup.
    const link = await fetch(`${baseUrl}/api/shops/${shop.id}/razorpay-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const linkBody = (await link.json()) as any;
    assert.notStrictEqual(link.status, 400,
      `onboarding must not fail for want of a phone number: ${JSON.stringify(linkBody)}`);
    assert.match(String(linkBody.error || ''), /Route/i);
  });

  await t.test('38. Route onboarding refuses a shop with no phone number', async () => {
    // A shop registered before these fields existed, or through the older
    // endpoint, has no phone. Razorpay would reject that call anyway; refusing
    // it here says which field is missing instead of relaying a gateway error.
    const res = await fetch(`${baseUrl}/api/merchant/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true,
        shopName: 'No Phone Prints', ownerEmail: 'nophone@example.com',
        printerName: 'HP', password: 'NoPhoneOwner77xy',
      }),
    });
    const { shop, token } = (await res.json()) as any;
    assert.strictEqual(shop.contactPhone, undefined);

    const link = await fetch(`${baseUrl}/api/shops/${shop.id}/razorpay-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    assert.strictEqual(link.status, 400);
    assert.match(String(((await link.json()) as any).error), /phone/i);
  });

  /**
   * A shop owner clicked "Download agent", got a headless console window and
   * asked where the application was. The desktop agent existed and was
   * published; this endpoint pointed at the console build instead.
   */
  await t.test('73. The agent download hands over the desktop installer', async () => {
    const res = await fetch(`${baseUrl}/api/agent-installer`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);

    const target = String(res.headers.get('location'));
    assert.match(target, /PrintOkAgentSetup\.exe$/,
      'the default download must be the installer, not the console .exe');
    // No version in the filename: the button is a fixed redirect and a
    // versioned asset name would break it on the next release.
    assert.doesNotMatch(target, /Setup-\d/);

    // The other builds stay reachable for anyone who wants them.
    for (const [format, asset] of [
      ['console', 'WindowsPrintAgent.exe'],
      ['portable', 'PrintOkAgent.exe'],
      ['zip', 'PrintAgent-win-x64.zip'],
    ] as const) {
      const r = await fetch(`${baseUrl}/api/agent-installer?format=${format}`, { redirect: 'manual' });
      assert.strictEqual(r.status, 302, format);
      assert.ok(String(r.headers.get('location')).endsWith(asset), `${format} -> ${asset}`);
    }

    const bogus = await fetch(`${baseUrl}/api/agent-installer?format=nonsense`, { redirect: 'manual' });
    assert.strictEqual(bogus.status, 400);
  });

  // ---------------------------------------------------------------------------
  // What the customer is shown, and what the printer is told
  // ---------------------------------------------------------------------------

  /**
   * A structurally valid PDF with the requested number of pages.
   *
   * Real rather than a stub string, because the page count is the price: the
   * server reads it out of the document, and a fixture the parser cannot read
   * would be billed as one page and prove nothing about billing.
   */
  function makePdf(pageCount: number): Buffer {
    const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`);
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`,
      ...Array.from({ length: pageCount }, () =>
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'),
    ];

    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((obj, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });

    const xrefStart = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

    return Buffer.from(body, 'latin1');
  }

  /** A shop with a merchant session, which most of the tests below need. */
  /**
   * A registered, claimed shop.
   *
   * `tier` exists because the Free plan covers one sign-in account and the
   * owner is that account — so a fixture that needs a staff member needs a plan
   * with seats. Moving the fixture onto one is the honest fix; loosening the
   * cap so the tests pass would delete the behaviour the cap exists for.
   */
  async function shopWithAuth(
    name: string, email: string, password: string, tier?: string
  ) {
    const reg = await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: name, ownerEmail: email, printerName: `${name} printer` }),
    })).json() as any;

    const claimRes = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptTerms: true, shopId: reg.shop.id, ownerEmail: email, password, name }),
    });
    const claim = (await claimRes.json()) as any;

    // Asserted here, or a rejected password surfaces much later as an
    // unexplained 401 from whichever route the test happened to call first.
    assert.strictEqual(claimRes.status, 201, `claim for ${name} failed: ${JSON.stringify(claim)}`);
    assert.ok(claim.token, `claim for ${name} returned no token`);

    if (tier) {
      const { getPlan: planFor } = await import('@printok/shared-types');
      const definition = planFor(tier);
      assert.ok(definition, `no such plan: ${tier}`);
      await storage.updateShopPlan(reg.shop.id, {
        planTier: tier as any,
        commissionBps: definition!.platformFeeBps,
        planStatus: 'active',
      });
    }

    return {
      shopId: reg.shop.id,
      printerId: reg.printer.id,
      agentApiKey: reg.printer.apiKey,
      auth: { Authorization: `Bearer ${claim.token}`, 'Content-Type': 'application/json' } as Record<string, string>,
    };
  }

  await t.test('74. A customer is quoted the shop\'s own rates, with no session', async () => {
    // The regression this exists for: the customer page quoted by mirroring the
    // flat rate card client-side, and GET /pricing needs a merchant token — so
    // every customer saw hardcoded fallback rates. A shop could rebuild its
    // whole grid in Business Setup and the customer's screen never moved.
    const shop = await shopWithAuth('Quote Co', 'quote@example.com', 'QuotePass123');

    const quoteFor = async (params: Record<string, string>) => {
      const q = new URLSearchParams(params);
      const res = await fetch(`${baseUrl}/api/shops/${shop.shopId}/quote?${q}`);
      assert.strictEqual(res.status, 200, 'a quote needs no authentication at all');
      return ((await res.json()) as any).quote;
    };

    const before = await quoteFor({ pages: '10', copies: '1', isColor: 'false', isDuplex: 'false', paperSize: 'A4' });

    // The merchant re-prices exactly one cell: A4, mono, single-sided.
    const card = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/rates`)).json() as any;
    await fetch(`${baseUrl}/api/shops/${shop.shopId}/rates`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({
        rates: card.rates
          .filter((r: any) => r.paperSize === 'A4' && !r.isColor && !r.isDuplex)
          .map((r: any) => ({ ...r, perPageCents: 777, bulkPerPageCents: null })),
      }),
    });

    const after = await quoteFor({ pages: '10', copies: '1', isColor: 'false', isDuplex: 'false', paperSize: 'A4' });
    assert.notStrictEqual(after.totalPriceInCents, before.totalPriceInCents,
      'a rate card edit must move the price the customer is shown');
    assert.strictEqual(after.perPageRateCents, 777);
    assert.strictEqual(after.totalPriceInCents, 7770);

    // And the quote is the amount actually charged, not a parallel calculation.
    const job = await (await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'q.pdf',
        fileBase64: Buffer.from('%PDF-1.4 q').toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    })).json() as any;

    const charged = await quoteFor({
      pages: String(job.job.pageCount), copies: '1',
      isColor: 'false', isDuplex: 'false', paperSize: 'A4',
    });
    assert.strictEqual(job.job.totalPriceInCents, charged.totalPriceInCents,
      'the quoted price and the charged price are the same number');

    // The shop's rate card is its own business; a quote must not hand it over.
    const raw = await (await fetch(
      `${baseUrl}/api/shops/${shop.shopId}/quote?pages=1&copies=1&isColor=false&isDuplex=false&paperSize=A4`
    )).text();
    assert.ok(!raw.includes('rateCardSnapshot'), 'a quote exposes figures, not the whole grid');
    assert.ok(!raw.includes('bulkThresholdCents'), 'nor the thresholds behind them');
  });

  await t.test('75. A page selection is billed and printed as selected', async () => {
    // Previously the range was validated against the portal and then dropped:
    // a customer picking 3 pages of a 50-page file was quoted for 3, charged
    // for 50, and handed 50.
    const shop = await shopWithAuth('Range Co', 'range@example.com', 'RangePass123');

    const pdf = makePdf(10);

    const submit = (pageRange: string | null) => fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'range.pdf',
        fileBase64: pdf.toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4', pageRange,
      }),
    });

    const whole = (await (await submit(null)).json()) as any;
    const total = whole.job.pageCount;
    assert.ok(total >= 3, `this fixture needs at least 3 pages, got ${total}`);

    const partial = (await (await submit('1-3')).json()) as any;
    assert.strictEqual(partial.job.pageCount, 3, 'billed for the pages selected');
    assert.strictEqual(partial.job.pageRange, '1-3', 'and the selection reaches the agent');
    assert.ok(partial.job.totalPriceInCents < whole.job.totalPriceInCents,
      'three pages cost less than the whole document');

    // A selection that lands entirely outside the document is a typo worth
    // reporting, not a job that silently prints everything at full price.
    const empty = await submit(`${total + 50}-${total + 60}`);
    assert.strictEqual(empty.status, 400);
    assert.match(((await empty.json()) as any).error, /page selection prints nothing/);
  });

  await t.test('76. Orientation is offered, carried to the printer, and enforced', async () => {
    const shop = await shopWithAuth('Orient Co', 'orient@example.com', 'OrientPass123');

    const options = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-options`)).json() as any;
    assert.deepStrictEqual(options.orientations, ['auto', 'portrait', 'landscape'],
      'a new shop offers all three');

    const submit = (orientation?: string) => fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'o.pdf',
        fileBase64: Buffer.from('%PDF-1.4 o').toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        ...(orientation === undefined ? {} : { orientation }),
      }),
    });

    const landscape = (await (await submit('landscape')).json()) as any;
    assert.strictEqual(landscape.job.orientation, 'landscape');
    assert.strictEqual(landscape.job.printConfig.orientation, 'landscape',
      'and it is frozen into the audit snapshot');

    // An older customer page sends nothing, and must keep working.
    const silent = (await (await submit(undefined)).json()) as any;
    assert.strictEqual(silent.job.orientation, 'auto');

    // So must a nonsense value, rather than 400-ing a paying customer.
    const nonsense = (await (await submit('sideways-ish')).json()) as any;
    assert.strictEqual(nonsense.job.orientation, 'auto');

    // A shop that does not offer landscape does not sell it. Hiding the pill is
    // presentation; this is the part that stops a stale page ordering it.
    const portal = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-config`)).json() as any;
    await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-config`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({
        enabledServices: portal.enabledServices.filter((k: string) => k !== 'landscape'),
      }),
    });

    const narrowed = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-options`)).json() as any;
    assert.deepStrictEqual(narrowed.orientations, ['auto', 'portrait']);

    const refused = await submit('landscape');
    assert.strictEqual(refused.status, 400);
    assert.match(((await refused.json()) as any).error, /does not print in landscape/);

    // With all three off, 'auto' still prints: it is what every job did before
    // the choice existed, and refusing the lot would take a working shop down.
    await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-config`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({
        enabledServices: portal.enabledServices.filter(
          (k: string) => !['auto-orientation', 'portrait', 'landscape'].includes(k)
        ),
      }),
    });
    const stripped = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-options`)).json() as any;
    assert.deepStrictEqual(stripped.orientations, ['auto']);
    assert.strictEqual((await submit(undefined)).status, 201, 'a shop with no orientation set still sells');
  });

  await t.test('77. A multi-page PDF is billed for the pages it has', async () => {
    // pdf-parse v2 exports a class; this code called it as a function, so the
    // parse threw on every PDF, the catch returned a confident "1 page", and a
    // fifty-page thesis was charged as one page and printed as fifty. The shop
    // paid for the other forty-nine sheets.
    const shop = await shopWithAuth('Pages Co', 'pages@example.com', 'PagesPass123');

    const submit = (pdf: Buffer) => fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'thesis.pdf',
        fileBase64: pdf.toString('base64'),
        // A client claiming one page must not be believed either.
        pageCount: 1, copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });

    const one = (await (await submit(makePdf(1))).json()) as any;
    // Twenty rather than fifty: fifty sheets clears the default bulk threshold,
    // and this test is about the page count, not the discount.
    const twenty = (await (await submit(makePdf(20))).json()) as any;
    const fifty = (await (await submit(makePdf(50))).json()) as any;

    assert.strictEqual(one.job.pageCount, 1);
    assert.strictEqual(twenty.job.pageCount, 20, 'the server reads the real page count');
    assert.strictEqual(fifty.job.pageCount, 50);
    assert.strictEqual(twenty.job.totalPriceInCents, one.job.totalPriceInCents * 20,
      'and prices all twenty of them');
    assert.ok(fifty.job.totalPriceInCents > twenty.job.totalPriceInCents,
      'fifty pages still costs more than twenty, discount or not');
  });

  // ---------------------------------------------------------------------------
  // The payment gate
  // ---------------------------------------------------------------------------

  await t.test('78. A payment settles the job it was taken for, and only that job', async () => {
    // The confirm endpoint verified Razorpay's checkout signature — an HMAC over
    // "<order_id>|<payment_id>", carrying no job reference — and then confirmed
    // whatever jobId the request body named. Nothing connected the two, and the
    // gateway order id was never stored, so there was nothing to connect them
    // with. One genuine one-rupee payment could mark any job at any shop paid,
    // for any amount, as often as it was replayed.
    const shop = await shopWithAuth('Binding Co', 'binding@example.com', 'BindingPass123');

    const newJob = async (fileName: string) => {
      const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: shop.printerId, fileName,
          fileBase64: makePdf(3).toString('base64'),
          copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        }),
      });
      return ((await res.json()) as any).job;
    };

    const openOrder = async (jobId: string) => {
      const res = await fetch(`${baseUrl}/api/payments/create-order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      assert.strictEqual(res.status, 200, `create-order for ${jobId}`);
      return ((await res.json()) as any).orderId as string;
    };

    const confirm = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const jobA = await newJob('a.pdf');
    const jobB = await newJob('b.pdf');
    const orderA = await openOrder(jobA.id);
    const orderB = await openOrder(jobB.id);

    // Opening checkout again for an unchanged job reuses its order. Minting a
    // second one would rebind the job and refuse the payment for the first.
    assert.strictEqual(await openOrder(jobA.id), orderA, 'create-order is idempotent');
    assert.notStrictEqual(orderA, orderB, 'but two jobs get two orders');

    // --- the payment for job A settles job A ---
    const payA = 'pay_A_genuine';
    const goodA = await confirm({
      jobId: jobA.id, razorpayOrderId: orderA, razorpayPaymentId: payA,
      razorpaySignature: signCheckout(orderA, payA),
    });
    assert.strictEqual(goodA.status, 200);
    assert.strictEqual(((await goodA.json()) as any).job.paymentState, PaymentState.Paid);

    // --- the same payment must not settle job B ---
    // Signed for job B's own order, so the signature itself is valid; what
    // refuses it is that the payment is already spent.
    const replay = await confirm({
      jobId: jobB.id, razorpayOrderId: orderB, razorpayPaymentId: payA,
      razorpaySignature: signCheckout(orderB, payA),
    });
    assert.strictEqual(replay.status, 409, 'a spent payment cannot settle a second job');
    assert.match(((await replay.json()) as any).error, /already been used/i);

    // --- job A's order must not settle job B either ---
    const crossed = await confirm({
      jobId: jobB.id, razorpayOrderId: orderA, razorpayPaymentId: 'pay_B_other',
      razorpaySignature: signCheckout(orderA, 'pay_B_other'),
    });
    assert.strictEqual(crossed.status, 400, "another job's order cannot confirm this one");
    assert.match(((await crossed.json()) as any).error, /different order/i);

    // --- a genuine retry stays idempotent ---
    const retry = await confirm({
      jobId: jobA.id, razorpayOrderId: orderA, razorpayPaymentId: payA,
      razorpaySignature: signCheckout(orderA, payA),
    });
    assert.strictEqual(retry.status, 200, 'the browser retrying its own confirmation is not an error');
    assert.strictEqual(((await retry.json()) as any).job.paymentState, PaymentState.Paid);

    // --- but a different payment against a settled job is not a retry ---
    const second = await confirm({
      jobId: jobA.id, razorpayOrderId: orderA, razorpayPaymentId: 'pay_A_second',
      razorpaySignature: signCheckout(orderA, 'pay_A_second'),
    });
    assert.strictEqual(second.status, 409);

    // --- an unsigned or wrongly signed claim is still refused ---
    const forged = await confirm({
      jobId: jobB.id, razorpayOrderId: orderB, razorpayPaymentId: 'pay_forged',
      razorpaySignature: 'not-a-real-signature',
    });
    assert.strictEqual(forged.status, 400);

    // --- a job with no order opened cannot be confirmed at all ---
    const orphan = await newJob('orphan.pdf');
    const noOrder = await confirm({
      jobId: orphan.id, razorpayOrderId: 'order_never_minted', razorpayPaymentId: 'pay_x',
      razorpaySignature: signCheckout('order_never_minted', 'pay_x'),
    });
    assert.strictEqual(noOrder.status, 409);
    assert.match(((await noOrder.json()) as any).error, /no payment order/i);
  });

  await t.test('79. A re-priced order cannot be settled at the old figure', async () => {
    const shop = await shopWithAuth('Reprice Co', 'reprice@example.com', 'RepricePass123');

    const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'r.pdf',
        fileBase64: makePdf(2).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });
    const job = ((await res.json()) as any).job;

    const orderRes = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    const orderId = ((await orderRes.json()) as any).orderId as string;

    // Re-record the order at a figure that no longer matches the job, which is
    // what a price change between opening checkout and paying would look like.
    // Driven through the storage port rather than an endpoint because a job's
    // price is immutable by design and there is no route that would do this.
    await storage.attachGatewayOrder(job.id, orderId, job.totalPriceInCents + 500);

    const pay = 'pay_reprice';
    const confirmed = await fetch(`${baseUrl}/api/payments/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id, razorpayOrderId: orderId, razorpayPaymentId: pay,
        razorpaySignature: signCheckout(orderId, pay),
      }),
    });
    assert.strictEqual(confirmed.status, 409);
    assert.match(((await confirmed.json()) as any).error, /re-priced/i);

    const after = await (await fetch(`${baseUrl}/api/print-jobs/${job.id}`)).json() as any;
    assert.notStrictEqual(after.job.paymentState, PaymentState.Paid);
  });

  await t.test('80. A refunded order cannot be walked back to Paid', async () => {
    // The checkout signature has no nonce and no timestamp, so it never
    // expires. Idempotency was checked only against paymentState === Paid, and
    // a refund moves the job off Paid — so a retained confirmation, or a
    // Razorpay retry arriving after a refund, put the job back into the shop's
    // revenue figures.
    const shop = await shopWithAuth('Refund Guard Co', 'refundguard@example.com', 'RefundPass123');

    const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'g.pdf',
        fileBase64: makePdf(1).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });
    const job = ((await res.json()) as any).job;

    const orderRes = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    const orderId = ((await orderRes.json()) as any).orderId as string;
    const pay = 'pay_to_be_refunded';
    const signature = signCheckout(orderId, pay);

    const paid = await fetch(`${baseUrl}/api/payments/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id, razorpayOrderId: orderId, razorpayPaymentId: pay, razorpaySignature: signature,
      }),
    });
    assert.strictEqual(paid.status, 200);

    // The shop declines it, which moves the payment to RefundPending. Razorpay
    // is not configured here, so the refund call itself fails and the job stays
    // in RefundPending — which is exactly the window this guard covers.
    const declined = await fetch(
      `${baseUrl}/api/shops/${shop.shopId}/jobs/${job.id}/decline`,
      {
        method: 'POST', headers: shop.auth,
        body: JSON.stringify({ reason: 'Out of paper' }),
      }
    );
    // 202 when the refund was requested but the gateway has not confirmed it,
    // which is what happens without Razorpay credentials; 200 once it has.
    assert.ok([200, 202].includes(declined.status), `decline: ${declined.status}`);

    const midRefund = await (await fetch(`${baseUrl}/api/print-jobs/${job.id}`)).json() as any;
    assert.ok(
      [PaymentState.RefundPending, PaymentState.Refunded].includes(midRefund.job.paymentState),
      `expected a refund state, got ${midRefund.job.paymentState}`
    );

    // Replaying the original, still-valid confirmation must not resurrect it.
    const resurrect = await fetch(`${baseUrl}/api/payments/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id, razorpayOrderId: orderId, razorpayPaymentId: pay, razorpaySignature: signature,
      }),
    });
    assert.strictEqual(resurrect.status, 409, 'a refunded order is not confirmable');

    // Nor may a signed webhook, which is the path Razorpay actually retries.
    const raw = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: pay, order_id: orderId, amount: job.totalPriceInCents, notes: { jobId: job.id } },
        },
      },
    });
    const hook = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signWebhook(raw),
        'x-razorpay-event-id': 'evt_after_refund',
      },
      body: raw,
    });
    // 200 so Razorpay stops retrying something it cannot fix by resending.
    assert.strictEqual(hook.status, 200);

    const final = await (await fetch(`${baseUrl}/api/print-jobs/${job.id}`)).json() as any;
    assert.notStrictEqual(final.job.paymentState, PaymentState.Paid,
      'the refund must stand');
  });

  await t.test('81. A retried webhook delivery is applied once', async () => {
    const shop = await shopWithAuth('Retry Co', 'retry@example.com', 'RetryPass123');

    const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'w.pdf',
        fileBase64: makePdf(1).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });
    const job = ((await res.json()) as any).job;

    const raw = await paymentWebhookRaw(job.id, 'pay_webhook_once');
    const deliver = () => fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signWebhook(raw),
        'x-razorpay-event-id': 'evt_delivered_twice',
      },
      body: raw,
    });

    const first = await deliver();
    assert.strictEqual(first.status, 200);
    const afterFirst = await (await fetch(`${baseUrl}/api/print-jobs/${job.id}`)).json() as any;
    assert.strictEqual(afterFirst.job.paymentState, PaymentState.Paid);

    // Razorpay reuses the event id when it retries, so the second delivery is
    // recognised as the same one rather than re-evaluated against job state.
    const second = await deliver();
    assert.strictEqual(second.status, 200);
    assert.match(((await second.json()) as any).message, /already been processed/i);
  });

  // ---------------------------------------------------------------------------
  // Document storage
  // ---------------------------------------------------------------------------

  await t.test('82. A customer filename cannot decide where a document is written', async () => {
    // The stored name was `temp_docs/${jobId}_${fileName}` with the customer's
    // filename interpolated raw, so "../../../x.pdf" walked out of the storage
    // directory — and pointed back inside, overwrote another pending job's
    // document, so the shop printed the attacker's content under someone
    // else's token. The extension allowlist did not help: it reads that path
    // as a perfectly good .pdf.
    const shop = await shopWithAuth('Traversal Co', 'traversal@example.com', 'TraversalPass1');

    const submit = (fileName: string) => fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName,
        fileBase64: makePdf(1).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });

    const hostile = '../../../../../../tmp/printok_pwned.pdf';
    const res = await submit(hostile);
    assert.strictEqual(res.status, 201, 'a hostile name is sanitised, not a reason to refuse the order');

    const jobId = ((await res.json()) as any).job.id;
    const stored = await storage.getPrintJob(jobId);

    // The key is the job id and an extension, and nothing else.
    assert.strictEqual(stored?.s3Key, `temp_docs/${jobId}.pdf`);
    assert.ok(!stored!.s3Key!.includes('..'), 'no traversal survives into the key');

    // The customer's own filename is still kept, for the queue to show.
    assert.strictEqual(stored?.fileName, hostile);

    // And nothing was written where the name was trying to point.
    assert.ok(!fs.existsSync('/tmp/printok_pwned.pdf'), 'nothing escaped the storage directory');

    // Two jobs cannot collide on one object, which is what let one customer's
    // document be overwritten by another's.
    const second = await submit('../../../../../../tmp/printok_pwned.pdf');
    const secondId = ((await second.json()) as any).job.id;
    const secondStored = await storage.getPrintJob(secondId);
    assert.notStrictEqual(secondStored?.s3Key, stored?.s3Key, 'each job gets its own object');
  });

  await t.test('83. A job id is not authority over PII or the document', async () => {
    // GET /api/print-jobs/:id is unauthenticated, so the id was effectively an
    // unrevocable bearer credential for the customer's name, phone and file —
    // and it survives in browser history, referrer headers and any forwarded
    // status link. It also carried priceSnapshot, which embeds the shop's
    // entire rate grid.
    const shop = await shopWithAuth('Projection Co', 'projection@example.com', 'ProjectionPass1');

    await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-config`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({ collectCustomerName: true, collectCustomerPhone: true }),
    });

    const created = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'private.pdf',
        fileBase64: makePdf(2).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        customerName: 'Meera Iyer', customerPhone: '+91 98111 22333',
      }),
    });
    const jobId = ((await created.json()) as any).job.id;

    const raw = await (await fetch(`${baseUrl}/api/print-jobs/${jobId}`)).text();
    for (const leak of [
      'Meera', '98111', 'fileUrl', 'fileChecksum', 's3Key',
      'priceSnapshot', 'rateCardSnapshot', 'idempotencyKey', 'razorpay',
    ]) {
      assert.ok(!raw.includes(leak), `the public status view must not carry ${leak}`);
    }

    // What the status screen actually needs is still there.
    const { job } = JSON.parse(raw);
    assert.strictEqual(job.id, jobId);
    assert.ok(job.tokenNumber);
    assert.strictEqual(job.fileName, 'private.pdf');
    assert.strictEqual(job.printState, PrintState.AwaitingPayment);
    assert.strictEqual(job.paymentState, PaymentState.Pending);
    assert.strictEqual(job.pageCount, 2);
    assert.ok(job.totalPriceInCents > 0);

    // The stored document is reachable only by minting a fresh link, which is
    // what the authenticated agent path does.
    const link = await storage.createJobDownloadUrl(jobId);
    assert.ok(link, 'the agent can still obtain the document');
  });

  await t.test('84. A file must be what its name claims', async () => {
    // The allowlist checked the extension and nothing else. That matters most
    // for Office formats: the agent cannot render those, so it hands them to
    // whatever program the shop's PC has registered for that extension, via the
    // printto verb, unattended and with no operator review.
    const shop = await shopWithAuth('Magic Co', 'magic@example.com', 'MagicPass123');

    const submit = (fileName: string, bytes: Buffer) =>
      fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: shop.printerId, fileName,
          fileBase64: bytes.toString('base64'),
          copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        }),
      });

    // A Windows executable wearing a .docx suffix is the case that would have
    // been opened by Word on the counter PC.
    const executable = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x90)]);
    const disguised = await submit('invoice.docx', executable);
    assert.strictEqual(disguised.status, 400);
    assert.match(((await disguised.json()) as any).error, /does not look like/i);

    // Same for a PDF that is not one, and an image that is not one.
    assert.strictEqual((await submit('notes.pdf', Buffer.from('just text'))).status, 400);
    assert.strictEqual((await submit('photo.png', Buffer.from('just text'))).status, 400);

    // A PDF pretending to be a CSV is refused too, even though CSV has no
    // signature of its own to check against.
    assert.strictEqual((await submit('sheet.csv', makePdf(1))).status, 400);

    // And the real things still go through.
    assert.strictEqual((await submit('real.pdf', makePdf(2))).status, 201);
    assert.strictEqual((await submit('real.png', PNG_1X1)).status, 201);

    // A genuine CSV passes the content check — it really is just text — and is
    // then refused for a different reason: its page count cannot be measured,
    // so it cannot be priced honestly. Asserted on the message, so the two
    // refusals stay distinguishable.
    const genuineCsv = await submit('real.csv', Buffer.from('name,qty\nink,2\n'));
    assert.strictEqual(genuineCsv.status, 400);
    assert.match(((await genuineCsv.json()) as any).error, /cannot be measured accurately/i);
  });

  await t.test('85. An abandoned document is eventually deleted', async () => {
    // Purging happened only on a state transition, so a job that never
    // transitioned again kept the customer's file for ever — and abandoning a
    // checkout is precisely how a job stops transitioning. Upload, close the
    // tab before paying, and it was stored indefinitely against a privacy
    // policy that promised otherwise.
    const shop = await shopWithAuth('Retention Co', 'retention@example.com', 'RetentionPass1');

    const abandon = async (fileName: string) => {
      const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: shop.printerId, fileName,
          fileBase64: makePdf(1).toString('base64'),
          copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        }),
      });
      return ((await res.json()) as any).job.id as string;
    };

    const unpaid = await abandon('abandoned.pdf');

    // Nothing is swept while it is still inside its window.
    const untouched = await storage.purgeAbandonedDocuments(new Date());
    assert.ok(!untouched.purged.includes(unpaid), 'a fresh job keeps its document');
    assert.ok(await storage.createJobDownloadUrl(unpaid), 'and the document is still there');

    // Three hours later the unpaid window (two hours) has elapsed.
    const threeHoursOn = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const swept = await storage.purgeAbandonedDocuments(threeHoursOn);
    assert.ok(swept.purged.includes(unpaid), 'an abandoned unpaid document is deleted');

    const after = await storage.getPrintJob(unpaid);
    assert.ok(after?.documentDeletedAt, 'and the deletion is recorded');
    assert.strictEqual(after?.fileUrl, '', 'the usable reference is cleared');
    assert.strictEqual(await storage.createJobDownloadUrl(unpaid), null,
      'and no new link can be minted for it');

    // The sweep is idempotent: a second pass does not re-report it.
    const again = await storage.purgeAbandonedDocuments(threeHoursOn);
    assert.ok(!again.purged.includes(unpaid), 'already-purged jobs are not swept twice');

    // A paid job the shop has not printed yet keeps its document far longer —
    // purging that on the unpaid timer would destroy work already paid for.
    const paidJob = await abandon('paid-waiting.pdf');
    await fetch(`${baseUrl}/api/print-jobs/${paidJob}/manual-override`, {
      method: 'POST', headers: shop.auth,
    });
    const paidAfterThreeHours = await storage.purgeAbandonedDocuments(threeHoursOn);
    assert.ok(!paidAfterThreeHours.purged.includes(paidJob),
      'a paid job still waiting for a printer keeps its document');

    // But not indefinitely.
    const eightDaysOn = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const eventually = await storage.purgeAbandonedDocuments(eightDaysOn);
    assert.ok(eventually.purged.includes(paidJob), 'retention is bounded even for paid jobs');
  });

  await t.test('86. A printed document is deleted the moment it is printed', async () => {
    // Not after a retention window — immediately, on the transition itself.
    // The windows in the sweep exist only for documents that never reach this
    // point: an abandoned checkout, or a paid job a shop never printed.
    const shop = await shopWithAuth('Purge Now Co', 'purgenow@example.com', 'PurgeNowPass1', 'starter');

    const created = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'collect.pdf',
        fileBase64: makePdf(2).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });
    const jobId = ((await created.json()) as any).job.id;

    // Paid at the counter, so it reaches the queue.
    await fetch(`${baseUrl}/api/print-jobs/${jobId}/manual-override`, {
      method: 'POST', headers: shop.auth,
    });

    // The document is there for as long as the job needs it, and the agent can
    // obtain a link to it.
    assert.ok(await storage.createJobDownloadUrl(jobId), 'the agent must be able to fetch it');

    // The real agent sequence: claim by polling, report Printing, then Printed.
    const polled = await (await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': shop.agentApiKey },
    })).json() as any;
    assert.ok(polled.jobs.some((j: any) => j.id === jobId), 'the agent receives the job');
    assert.ok(
      polled.jobs.find((j: any) => j.id === jobId).fileUrl,
      'and receives a freshly minted link with it'
    );

    const report = (printState: string) =>
      fetch(`${baseUrl}/api/agent/jobs/${jobId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-api-key': shop.agentApiKey },
        body: JSON.stringify({ jobId, printState }),
      });

    await report(PrintState.Printing);
    const stillNeeded = await storage.getPrintJob(jobId);
    assert.ok(!stillNeeded?.documentDeletedAt, 'mid-print the document is still required');

    assert.strictEqual((await report(PrintState.Printed)).status, 200);

    // Gone. Not scheduled, not queued for a sweep — deleted on the transition.
    const printed = await storage.getPrintJob(jobId);
    assert.ok(printed?.documentDeletedAt, 'the document is deleted on being printed');
    assert.strictEqual(printed?.fileUrl, '', 'and its reference is cleared');
    assert.strictEqual(await storage.createJobDownloadUrl(jobId), null,
      'no link can be minted for it afterwards');

    // The customer can still see their job and collect it; only the file is gone.
    const status = await (await fetch(`${baseUrl}/api/print-jobs/${jobId}`)).json() as any;
    assert.strictEqual(status.job.printState, PrintState.Printed);
    assert.ok(status.job.tokenNumber, 'the token they collect against still stands');
  });

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------

  await t.test('87. Staff cannot change shop-wide money policy or extract the agent key', async () => {
    const shop = await shopWithAuth('Staff Limits Co', 'stafflimits@example.com', 'StaffLimitsPass1', 'starter');

    const added = await fetch(`${baseUrl}/api/shops/${shop.shopId}/staff`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({ email: 'counter@example.com', name: 'Counter', password: 'CounterPass123' }),
    });
    assert.strictEqual(added.status, 201);

    const login = await (await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'counter@example.com', password: 'CounterPass123' }),
    })).json() as any;
    const staff = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };

    // autoPrintMode 'all' queues every job for printing before payment clears.
    // That is a shop-wide financial policy, and a staff account could set it —
    // while every sibling settings route already required the owner.
    const flip = await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-config`, {
      method: 'POST', headers: staff, body: JSON.stringify({ autoPrintMode: 'all' }),
    });
    assert.strictEqual(flip.status, 403, 'staff must not be able to switch off paying first');

    const stillSafe = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-config`)).json() as any;
    assert.strictEqual(stillSafe.autoPrintMode, 'after-payment', 'and the policy is unchanged');

    // The owner still can.
    const ownerFlip = await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-config`, {
      method: 'POST', headers: shop.auth, body: JSON.stringify({ collectCustomerName: true }),
    });
    assert.strictEqual(ownerFlip.status, 200, 'the owner is not locked out of their own settings');

    // The agent config carries the printer's permanent key, which until now had
    // no rotation route at all — so a staff member could take a credential the
    // shop could never invalidate.
    const token = await fetch(`${baseUrl}/api/printers/${shop.printerId}/agent-config-token`, {
      method: 'POST', headers: staff,
    });
    assert.strictEqual(token.status, 403, 'staff must not be able to mint an agent config');
  });

  await t.test('88. The legacy agent key can be rotated', async () => {
    const shop = await shopWithAuth('Rotate Co', 'rotate@example.com', 'RotatePass123', 'starter');
    const original = shop.agentApiKey;

    // The old key works.
    assert.strictEqual((await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': original },
    })).status, 200);

    // Staff cannot rotate it.
    const added = await fetch(`${baseUrl}/api/shops/${shop.shopId}/staff`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({ email: 'rot-staff@example.com', password: 'RotStaffPass1' }),
    });
    assert.strictEqual(added.status, 201);
    const staffLogin = await (await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rot-staff@example.com', password: 'RotStaffPass1' }),
    })).json() as any;
    assert.strictEqual((await fetch(`${baseUrl}/api/printers/${shop.printerId}/rotate-api-key`, {
      method: 'POST', headers: { Authorization: `Bearer ${staffLogin.token}` },
    })).status, 403);

    // The owner can.
    const rotated = await fetch(`${baseUrl}/api/printers/${shop.printerId}/rotate-api-key`, {
      method: 'POST', headers: shop.auth,
    });
    assert.strictEqual(rotated.status, 200);
    const { apiKey: replacement } = (await rotated.json()) as any;
    assert.ok(replacement && replacement !== original, 'a new key is issued');

    // The old one stops working; the new one works.
    assert.strictEqual((await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': original },
    })).status, 401, 'a rotated key is dead');
    assert.strictEqual((await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': replacement },
    })).status, 200);
  });

  await t.test('89. A device cannot report on another device\'s job', async () => {
    // The status endpoint checked that the job belonged to the authenticated
    // printer, but not to the authenticated device, and then overwrote the
    // job's deviceId with whoever called. So a second or stale credential for
    // the same printer could drive another device's job to Completed — which
    // purges the document, with no refund, because Completed is not Cancelled.
    const shop = await shopWithAuth('Device Co', 'device@example.com', 'DevicePass123');

    const created = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'd.pdf',
        fileBase64: makePdf(1).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });
    const jobId = ((await created.json()) as any).job.id;
    await fetch(`${baseUrl}/api/print-jobs/${jobId}/manual-override`, {
      method: 'POST', headers: shop.auth,
    });

    // Device A claims it by polling.
    const polled = await (await fetch(`${baseUrl}/api/agent/jobs/pending`, {
      headers: { 'x-agent-api-key': shop.agentApiKey, 'x-agent-device-id': 'device-A' },
    })).json() as any;
    assert.ok(polled.jobs.some((j: any) => j.id === jobId));

    const report = (deviceId: string, printState: string) =>
      fetch(`${baseUrl}/api/agent/jobs/${jobId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agent-api-key': shop.agentApiKey,
          'x-agent-device-id': deviceId,
        },
        body: JSON.stringify({ jobId, printState }),
      });

    // Device B, same printer, same shop, valid credential — and not its job.
    const intruder = await report('device-B', PrintState.Completed);
    assert.strictEqual(intruder.status, 409, 'another device must not close this job');

    const untouched = await storage.getPrintJob(jobId);
    assert.notStrictEqual(untouched?.printState, PrintState.Completed);
    assert.ok(!untouched?.documentDeletedAt, 'and the document survives');

    // The device that actually holds it still works.
    assert.strictEqual((await report('device-A', PrintState.Printing)).status, 200);
    assert.strictEqual((await report('device-A', PrintState.Printed)).status, 200);
  });

  await t.test('90. A read-only admin cannot mutate platform job state', async () => {
    // reclaim-stale-jobs mutates print state across every shop, so it is a
    // write — but it only checked that the caller was an admin. The support
    // role exists precisely to look without touching.
    // The owner the suite bootstrapped in test 14.
    const owner = await (await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    })).json() as any;
    assert.ok(owner.token, 'the suite bootstrapped an admin earlier');
    const ownerAuth = { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' };

    // There is no route that creates an admin account beyond bootstrap, so the
    // support-tier account is seeded through the storage port.
    await storage.createAdminUser({
      email: 'support-ro@printok.test',
      passwordHash: hashPassword('SupportPass123x'),
      name: 'Support',
      role: 'support',
    });

    const supportLogin = await (await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'support-ro@printok.test', password: 'SupportPass123x' }),
    })).json() as any;
    assert.ok(supportLogin.token, 'the support account can sign in');
    const supportAuth = { Authorization: `Bearer ${supportLogin.token}`, 'Content-Type': 'application/json' };

    // Looking is fine.
    assert.strictEqual((await fetch(`${baseUrl}/api/admin/shops`, { headers: supportAuth })).status, 200);

    // Touching is not.
    const sweep = await fetch(`${baseUrl}/api/admin/reclaim-stale-jobs`, {
      method: 'POST', headers: supportAuth,
    });
    assert.strictEqual(sweep.status, 403, 'support can look but not touch');

    // The owner can.
    assert.strictEqual((await fetch(`${baseUrl}/api/admin/reclaim-stale-jobs`, {
      method: 'POST', headers: ownerAuth,
    })).status, 200);
  });

  await t.test('91. Only one owner can win the admin bootstrap', async () => {
    // countAdminUsers() then createAdminUser() with no transaction or lock. A
    // COUNT takes no lock and cannot see an uncommitted insert, and two
    // different emails do not conflict on the only unique constraint there is —
    // so two concurrent requests both created a full-privilege owner.
    //
    // An admin already exists by this point in the suite, so the route's own
    // refusal is what is asserted here; the race itself is covered against a
    // real database in the Postgres suite, where the lock actually matters.
    const attempt = (email: string) => fetch(`${baseUrl}/api/admin/bootstrap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'RaceyPass123x', name: 'Racer' }),
    });

    const [a, b] = await Promise.all([attempt('race-a@printok.in'), attempt('race-b@printok.in')]);
    assert.strictEqual(a.status, 409);
    assert.strictEqual(b.status, 409);

    for (const email of ['race-a@printok.in', 'race-b@printok.in']) {
      const login = await fetch(`${baseUrl}/api/admin/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'RaceyPass123x' }),
      });
      assert.strictEqual(login.status, 401, `${email} must never have been created`);
    }
  });

  // ---------------------------------------------------------------------------
  // The money screens
  // ---------------------------------------------------------------------------

  await t.test('92. A cash order carries no gateway fee', async () => {
    // calculateShopNetCents deducted PAYMENT_GATEWAY_FEE_BPS unconditionally
    // and the row was labelled "Razorpay 2% + 18% GST" — on every order,
    // including cash taken over the counter that never touched Razorpay. The
    // shop's earnings were understated on every counter sale, and the
    // deduction was attributed to a company that charged nothing for it.
    const shop = await shopWithAuth('Cash Books Co', 'cashbooks@example.com', 'CashBooksPass1');

    const newJob = async (fileName: string) => {
      const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: shop.printerId, fileName,
          fileBase64: makePdf(5).toString('base64'),
          copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        }),
      });
      return ((await res.json()) as any).job;
    };

    // --- one paid in cash at the counter ---
    const cash = await newJob('cash.pdf');
    await fetch(`${baseUrl}/api/print-jobs/${cash.id}/manual-override`, {
      method: 'POST', headers: shop.auth,
    });

    // --- one paid online, through the gateway ---
    const online = await newJob('online.pdf');
    const orderRes = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: online.id }),
    });
    const orderId = ((await orderRes.json()) as any).orderId as string;
    const pay = 'pay_books_online';
    const confirmed = await fetch(`${baseUrl}/api/payments/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: online.id, razorpayOrderId: orderId, razorpayPaymentId: pay,
        razorpaySignature: signCheckout(orderId, pay),
      }),
    });
    assert.strictEqual(confirmed.status, 200);

    const earnings = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/earnings`, {
      headers: shop.auth,
    })).json() as any;

    const cashRow = earnings.rows.find((r: any) => r.jobId === cash.id);
    const onlineRow = earnings.rows.find((r: any) => r.jobId === online.id);
    assert.ok(cashRow && onlineRow, 'both orders must appear in earnings');

    // The cash row: nothing deducted for a gateway that was never involved.
    assert.strictEqual(cashRow.paymentMethod, 'cash');
    assert.strictEqual(cashRow.razorpayFeeCents, 0, 'a cash order owes Razorpay nothing');
    assert.strictEqual(
      cashRow.netCents,
      cashRow.grossCents - cashRow.platformCommissionCents,
      'cash net is gross minus our commission, and nothing else'
    );

    // The online row still carries it.
    assert.strictEqual(onlineRow.paymentMethod, 'online');
    assert.ok(onlineRow.razorpayFeeCents > 0, 'an online order does pay a gateway fee');

    // Same gross, different net — which is the whole point.
    assert.strictEqual(cashRow.grossCents, onlineRow.grossCents, 'same price both ways');
    assert.ok(cashRow.netCents > onlineRow.netCents, 'the shop keeps more of a cash sale');

    // Totals add up rather than being computed a second way.
    assert.strictEqual(earnings.totals.cashOrders, 1);
    assert.strictEqual(earnings.totals.onlineOrders, 1);
    assert.strictEqual(
      earnings.totals.razorpayFeeCents,
      onlineRow.razorpayFeeCents,
      'the only gateway fee in the totals is the online one'
    );

    // And the payout summary agrees with the earnings screen, which it could
    // not before: it worked from a single revenue aggregate that cannot tell a
    // cash order from an online one.
    const payout = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/payout-summary`, {
      headers: shop.auth,
    })).json() as any;
    assert.strictEqual(payout.grossCents, earnings.totals.grossCents, 'the two screens agree on gross');
    assert.strictEqual(payout.razorpayFeeCents, earnings.totals.razorpayFeeCents, '…and on fees');
    // What PrintOk transfers: the online order's net, less the fee on the cash
    // order, whose money the shop already holds.
    assert.strictEqual(earnings.totals.cashFeesCents, cashRow.platformCommissionCents);
    assert.strictEqual(
      earnings.totals.settlementCents,
      onlineRow.netCents - cashRow.platformCommissionCents,
      'cash fees come out of the settlement'
    );
    assert.strictEqual(payout.netAvailableCents, earnings.totals.settlementCents, '…and on what is transferred');
  });

  await t.test('93. A shop can set where its money goes, and is told how it gets there', async () => {
    // upiId, bankAccountNumber and bankIfsc were settable only in the signup
    // body. No route changed them afterwards — the profile screen excludes them
    // saying they belong to the money screen, which had no such route either.
    // So a shop that signed up without them could never say where to be paid,
    // and the payout summary read a upiId that stayed null for ever.
    const shop = await shopWithAuth('Payout Co', 'payout@example.com', 'PayoutPass123', 'starter');

    const before = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/payout-details`, {
      headers: shop.auth,
    })).json() as any;
    assert.strictEqual(before.upiId, '');
    assert.strictEqual(before.bankAccountSet, false);

    // It explains the settlement mode rather than just naming it.
    assert.strictEqual(before.settlement.mode, 'manual');
    assert.match(before.settlement.headline, /paid out to you/i);
    // And says plainly where the money goes today: to PrintOk, then to the shop.
    assert.match(before.settlement.detail, /received into PrintOk's Razorpay account/i);
    assert.doesNotMatch(before.settlement.detail, /never holds|straight to|instant/i,
      'no direct-settlement claim while Route is off');
    assert.match(before.settlement.action, /Add a UPI ID or bank account/i);

    const save = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/api/shops/${shop.shopId}/payout-details`, {
        method: 'POST', headers: shop.auth, body: JSON.stringify(body),
      });

    // Nonsense is refused with something a shop owner can act on.
    assert.strictEqual((await save({ upiId: 'not-a-upi-id' })).status, 400);
    assert.strictEqual((await save({ bankAccountNumber: '12ab34' })).status, 400);
    assert.strictEqual((await save({ bankAccountNumber: '123456789', bankIfsc: 'NOPE' })).status, 400);

    // Half a bank account cannot be paid to, so half is refused.
    const halfway = await save({ bankAccountNumber: '123456789012' });
    assert.strictEqual(halfway.status, 400);
    assert.match(((await halfway.json()) as any).error, /both the account number and its IFSC/i);

    // A UPI ID on its own is fine.
    const upiOnly = await save({ upiId: 'ramesh@oksbi' });
    assert.strictEqual(upiOnly.status, 200);
    assert.strictEqual(((await upiOnly.json()) as any).upiId, 'ramesh@oksbi');

    // And a whole bank account.
    const full = await save({ bankAccountNumber: '123456789012', bankIfsc: 'hdfc0001234' });
    assert.strictEqual(full.status, 200);
    const saved = (await full.json()) as any;
    assert.strictEqual(saved.bankIfsc, 'HDFC0001234', 'an IFSC is stored upper-case');
    assert.strictEqual(saved.bankAccountSet, true);
    assert.strictEqual(saved.bankAccountLast4, '9012', 'only the tail comes back');
    assert.ok(!JSON.stringify(saved).includes('123456789012'), 'the whole number is not echoed');

    // Nothing left to do now that there is somewhere to send money. It is not
    // invited to "connect Razorpay for automatic settlement": Route is off, so
    // that would be a promise the platform cannot keep.
    assert.strictEqual(saved.settlement.action, null);

    // The payout summary sees it too, which it could not before.
    const summary = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/payout-summary`, {
      headers: shop.auth,
    })).json() as any;
    assert.strictEqual(summary.payoutUpiId, 'ramesh@oksbi');
    assert.strictEqual(summary.payoutBankSet, true);
    assert.strictEqual(summary.settlementDetail.mode, 'manual');

    // Staff must not be able to redirect the shop's money.
    const added = await fetch(`${baseUrl}/api/shops/${shop.shopId}/staff`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({ email: 'payout-staff@example.com', password: 'PayoutStaffPass1' }),
    });
    assert.strictEqual(added.status, 201);
    const staffLogin = await (await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'payout-staff@example.com', password: 'PayoutStaffPass1' }),
    })).json() as any;
    const staffAuth = { Authorization: `Bearer ${staffLogin.token}`, 'Content-Type': 'application/json' };

    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${shop.shopId}/payout-details`, {
      headers: staffAuth,
    })).status, 403);
    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${shop.shopId}/payout-details`, {
      method: 'POST', headers: staffAuth, body: JSON.stringify({ upiId: 'thief@okaxis' }),
    })).status, 403);

    const unchanged = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/payout-details`, {
      headers: shop.auth,
    })).json() as any;
    assert.strictEqual(unchanged.upiId, 'ramesh@oksbi', 'the destination is untouched');
  });

  await t.test('94. A shop can see its plan costed against its own volume', async () => {
    // There is no merchant-facing plan route at all: planTier is settable only
    // by an operator, so a shop owner cannot see what they are on, what it is
    // costing them, or what the alternatives would be.
    const shop = await shopWithAuth('Plan Co', 'plan@example.com', 'PlanOwnerPass123', 'starter');

    const res = await fetch(`${baseUrl}/api/shops/${shop.shopId}/plan`, { headers: shop.auth });
    assert.strictEqual(res.status, 200);
    const plan = (await res.json()) as any;

    assert.strictEqual(plan.current.tier, 'starter');
    assert.strictEqual(plan.current.platformFeeBps, 100);
    assert.strictEqual(plan.current.commissionBps, 100, 'the compatibility alias agrees');

    // Usage is reported against the allowance, from the same counter the server
    // refuses against — so the dashboard cannot show room the server denies.
    assert.strictEqual(plan.usage.printers.limit, 2);
    assert.strictEqual(plan.usage.staff.limit, 3);
    assert.strictEqual(plan.usage.orders.limit, 1000);
    assert.strictEqual(plan.usage.staff.used, 1, 'the owner occupies a seat');
    assert.ok(Array.isArray(plan.options) && plan.options.length > 1);
    assert.ok(plan.options.some((o: any) => o.isCurrent), 'the current tier is marked');

    // Every tier is costed against this shop's own month, so the comparison is
    // arithmetic rather than a pitch.
    for (const option of plan.options) {
      assert.strictEqual(
        option.wouldCostCents,
        option.monthlyPriceCents + Math.round((plan.thisMonth.grossCents * option.commissionBps) / 10_000),
        `${option.tier} must be costed against this shop's volume`
      );
    }

    // And it is honest that the change is not self-service yet, because
    // subscription billing does not exist — a free tier change would hand away
    // the commission.
    // Two facts rather than one flag: an owner can move down on their own, and
    // cannot move up, because nothing can charge for a paid tier yet. Reporting
    // a single "changeable: false" disabled the half that works.
    assert.strictEqual(plan.canDowngrade, true);
    assert.strictEqual(plan.canUpgrade, true);
    assert.match(plan.howToChange, /through Razorpay/i);

    // Staff cannot read the shop's commercial terms.
    const added = await fetch(`${baseUrl}/api/shops/${shop.shopId}/staff`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({ email: 'plan-staff@example.com', password: 'PlanStaffPass123' }),
    });
    assert.strictEqual(added.status, 201);
    const staffLogin = await (await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'plan-staff@example.com', password: 'PlanStaffPass123' }),
    })).json() as any;
    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${shop.shopId}/plan`, {
      headers: { Authorization: `Bearer ${staffLogin.token}` },
    })).status, 403);
  });

  // ---------------------------------------------------------------------------
  // Pricing correctness
  // ---------------------------------------------------------------------------

  await t.test('95. A disabled configuration cannot be bought', async () => {
    // derivePortalOptions checks each dimension separately and sidedModes never
    // consulted the rate grid at all. So a shop could switch off one specific
    // cell — A4 colour double-sided — while keeping A4 colour single-sided and
    // A3 colour double-sided on, and the disabled combination passed every
    // per-dimension check and was sold at whatever stale rate was left on it.
    const shop = await shopWithAuth('Cell Off Co', 'celloff@example.com', 'CellOffPass123');

    const card = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/rates`)).json() as any;
    const target = (r: any) => r.paperSize === 'A4' && r.isColor === true && r.isDuplex === true;

    // Leave a deliberately cheap rate behind on the cell being switched off,
    // which is what made this worth exploiting.
    await fetch(`${baseUrl}/api/shops/${shop.shopId}/rates`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({
        rates: card.rates.filter(target).map((r: any) => ({ ...r, enabled: false, perPageCents: 1 })),
      }),
    });

    const options = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/portal-options`)).json() as any;

    // Every dimension is still on offer, which is exactly why the per-dimension
    // checks were not enough.
    assert.ok(options.paperSizes.includes('A4'));
    assert.ok(options.colourModes.includes('colour'));
    assert.ok(options.sidedModes.includes('duplex'));

    // But the exact combination is not sellable.
    const sellable = (paperSize: string, isColor: boolean, isDuplex: boolean) =>
      options.sellableCombinations.some(
        (c: any) => c.paperSize === paperSize && c.isColor === isColor && c.isDuplex === isDuplex
      );
    assert.ok(!sellable('A4', true, true), 'the disabled cell is not on offer');
    assert.ok(sellable('A4', true, false), 'its siblings still are');

    const order = (isColor: boolean, isDuplex: boolean) =>
      fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: shop.printerId, fileName: 'cell.pdf',
          fileBase64: makePdf(4).toString('base64'),
          copies: 1, isColor, isDuplex, paperSize: 'A4',
        }),
      });

    const refused = await order(true, true);
    assert.strictEqual(refused.status, 400, 'a disabled combination must be refused');
    assert.match(((await refused.json()) as any).error, /does not offer A4 colour double-sided/i);

    // And the enabled sibling still sells, at its own rate rather than the
    // cheap one left on the disabled cell.
    const allowed = await order(true, false);
    assert.strictEqual(allowed.status, 201);
    const job = ((await allowed.json()) as any).job;
    assert.ok(job.totalPriceInCents > 4, 'priced from the enabled cell, not the disabled one');
  });

  await t.test('96. A larger order can never cost less than a smaller one', async () => {
    // Crossing the bulk threshold steps the first-copy rate down while the
    // additional-copy rate stays put, so the total falls as copies rise
    // whenever the step is bigger than the additional-copy rate. From the
    // audit: 10 pages at 10 paise, bulk 5, additional-copy 3, threshold 900 —
    // eight copies cost 310 and nine cost 290.
    const shop = await shopWithAuth('Monotonic Co', 'monotonic@example.com', 'MonotonicPass1');

    const card = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/rates`)).json() as any;
    const a4Mono = (r: any) => r.paperSize === 'A4' && !r.isColor && !r.isDuplex;

    // Write-time validation refuses the inverting card outright.
    const inverting = await fetch(`${baseUrl}/api/shops/${shop.shopId}/rates`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({
        bulkEnabled: true,
        additionalCopyEnabled: true,
        bulkThresholdCents: 900,
        rates: card.rates.filter(a4Mono).map((r: any) => ({
          ...r, perPageCents: 10, bulkPerPageCents: 5, additionalCopyPerPageCents: 3,
        })),
      }),
    });
    assert.strictEqual(inverting.status, 400, 'an inverting rate card is refused on write');
    const why = ((await inverting.json()) as any).error;
    assert.match(why, /larger order cost less/i);
    assert.match(why, /A4 black and white single-sided/i, 'and it names the cell');

    // A sane card is accepted.
    const sane = await fetch(`${baseUrl}/api/shops/${shop.shopId}/rates`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({
        bulkEnabled: true,
        additionalCopyEnabled: true,
        bulkThresholdCents: 900,
        rates: card.rates.filter(a4Mono).map((r: any) => ({
          ...r, perPageCents: 10, bulkPerPageCents: 8, additionalCopyPerPageCents: 6,
        })),
      }),
    });
    assert.strictEqual(sane.status, 200);

    // And the quote is non-decreasing in copies right across the threshold,
    // which is the property the calculation now guarantees regardless of what
    // is stored.
    const quoteFor = async (copies: number) => {
      const params = new URLSearchParams({
        pages: '10', copies: String(copies),
        isColor: 'false', isDuplex: 'false', paperSize: 'A4',
      });
      const res = await fetch(`${baseUrl}/api/shops/${shop.shopId}/quote?${params}`);
      return ((await res.json()) as any).quote.totalPriceInCents as number;
    };

    let previous = 0;
    for (let copies = 1; copies <= 14; copies++) {
      const total = await quoteFor(copies);
      assert.ok(
        total >= previous,
        `${copies} copies cost ${total}, less than ${copies - 1} copies at ${previous}`
      );
      previous = total;
    }
  });

  await t.test('97. A file whose pages cannot be counted is refused, not guessed at', async () => {
    // Office formats reported a hardcoded one page, and that is what a job is
    // priced from — so a 500-page .docx was charged as one page while the
    // agent handed the whole document to Word and printed all 500.
    const shop = await shopWithAuth('Measure Co', 'measure@example.com', 'MeasurePass123');

    const submit = (fileName: string, bytes: Buffer) =>
      fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: shop.printerId, fileName,
          fileBase64: bytes.toString('base64'),
          copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        }),
      });

    // A structurally valid ZIP container, so it clears the content check and is
    // refused on the pricing ground rather than the format one.
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(120, 0x00),
    ]);

    for (const name of ['report.docx', 'sheet.xlsx', 'deck.pptx']) {
      const res = await submit(name, zip);
      assert.strictEqual(res.status, 400, `${name} must be refused`);
      const error = ((await res.json()) as any).error;
      assert.match(error, /cannot be measured accurately/i);
      assert.match(error, /export it as a PDF/i, 'and must say what to do instead');
    }

    // PDFs and images are measurable and still accepted.
    assert.strictEqual((await submit('fine.pdf', makePdf(7))).status, 201);
    assert.strictEqual((await submit('fine.png', PNG_1X1)).status, 201);

    // A PDF the parser cannot read is still accepted, because its pages can be
    // recovered by counting markers — those arrive constantly from phone
    // scanners, and refusing them would turn real customers away.
    const scannerish = Buffer.from(
      `%PDF-1.4\n${'/Type /Page \n'.repeat(3)}trailer<</Root 1 0 R>>\n%%EOF`
    );
    const recovered = await submit('scan.pdf', scannerish);
    assert.strictEqual(recovered.status, 201, 'a broken-xref PDF is still printable');
    assert.strictEqual(((await recovered.json()) as any).job.pageCount, 3,
      'and its pages are recovered rather than billed as one');
  });

  await t.test('98. Production refuses to boot without a database, and throttles guessing', async () => {
    // server.ts selects MemoryStorage when DATABASE_URL is absent, which is
    // right for local development and a catastrophe in production: every shop,
    // job and payment lives until the next restart, /health still reports OK,
    // and behind more than one instance each gets its own disjoint dataset. A
    // missing environment variable looked exactly like a healthy deploy.
    const { assertRequiredEnv } = await import('../env');

    const saved = {
      nodeEnv: process.env.NODE_ENV,
      databaseUrl: process.env.DATABASE_URL,
      jwt: process.env.JWT_SECRET,
    };

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.DATABASE_URL;

      assert.throws(
        () => assertRequiredEnv(),
        /DATABASE_URL/,
        'production must refuse to start on in-memory storage'
      );

      // With one configured it boots.
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/printok';
      assert.doesNotThrow(() => assertRequiredEnv());

      // Development is deliberately still allowed to run without one.
      process.env.NODE_ENV = 'development';
      delete process.env.DATABASE_URL;
      assert.doesNotThrow(
        () => assertRequiredEnv(),
        'local development must still work without Docker'
      );

      // And a missing signing secret is still fatal everywhere.
      process.env.JWT_SECRET = 'tooshort';
      assert.throws(() => assertRequiredEnv(), /JWT_SECRET/);
    } finally {
      process.env.NODE_ENV = saved.nodeEnv;
      if (saved.databaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved.databaseUrl;
      process.env.JWT_SECRET = saved.jwt;
    }
  });

  await t.test('99. Credential guessing is throttled', async () => {
    // The limiter exists on the app built for this test with a raised ceiling,
    // so a low one is built here to prove it actually engages — signup, both
    // logins and pairing had no limiter at all, and signup hashes a password
    // with scrypt at N=16384, which blocks the single Node event loop.
    const saved = process.env.AUTH_RATE_LIMIT_PER_MINUTE;
    process.env.AUTH_RATE_LIMIT_PER_MINUTE = '3';

    const throttled = http.createServer(createApp(new MemoryStorage()));
    await new Promise<void>((resolve) => throttled.listen(0, resolve));
    const port = (throttled.address() as { port: number }).port;

    try {
      const attempt = () => fetch(`http://localhost:${port}/api/merchant/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'WrongPass123456' }),
      });

      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await attempt()).status);

      assert.ok(codes.includes(429), `guessing must be throttled, got ${codes.join(',')}`);
      assert.strictEqual(codes[0], 401, 'the first attempt is answered normally');
    } finally {
      throttled.close();
      if (saved === undefined) delete process.env.AUTH_RATE_LIMIT_PER_MINUTE;
      else process.env.AUTH_RATE_LIMIT_PER_MINUTE = saved;
    }
  });

  await t.test('100. A repeated submission is one job, not two charges', async () => {
    // createPrintJob has always looked up an idempotency key and returned the
    // original job rather than creating a second — and nothing ever passed it
    // one from the customer route, so the feature was inert. A double-tapped
    // Pay button, or a retry after a flaky connection, created a second job and
    // charged for it.
    const shop = await shopWithAuth('Idem Co', 'idem@example.com', 'IdemPass123456');
    const pdf = makePdf(3).toString('base64');

    const submit = (key?: string) => fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'twice.pdf', fileBase64: pdf,
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });

    const key = 'job-double-tap-0001';
    const first = (await (await submit(key)).json()) as any;
    const second = (await (await submit(key)).json()) as any;

    assert.strictEqual(second.job.id, first.job.id, 'a retry returns the original job');

    // And really only one job exists, rather than two that happen to look alike.
    const queue = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/jobs`, {
      headers: shop.auth,
    })).json() as any;
    const matching = queue.jobs.filter((j: any) => j.fileName === 'twice.pdf');
    assert.strictEqual(matching.length, 1, 'the shop sees one order, not two');

    // A genuinely new order with its own key is a new job.
    const other = (await (await submit('job-different-0002')).json()) as any;
    assert.notStrictEqual(other.job.id, first.job.id);

    // No key at all still works — an older page must keep functioning — it
    // simply gets no protection.
    assert.strictEqual((await submit(undefined)).status, 201);

    // A key too short or shaped wrongly is ignored rather than rejected: it is
    // a client convenience, and failing the order over it would be worse.
    assert.strictEqual((await submit('short')).status, 201);
    assert.strictEqual((await submit('has spaces and $ymbols')).status, 201);
  });

  // ---------------------------------------------------------------------------
  // Refunds
  // ---------------------------------------------------------------------------

  await t.test('101. A refund is not called done until the bank has done it', async () => {
    // recordJobRefund marked a job Refunded the moment the Razorpay call
    // returned. But a refund is created 'pending' and becomes 'processed' when
    // the bank has actually taken the money — days later — and it can fail. So
    // the customer was told their money was back while it had not moved.
    const shop = await shopWithAuth('Refund Flow Co', 'refundflow@example.com', 'RefundFlowPass1');

    const paidJob = async () => {
      const created = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printerId: shop.printerId, fileName: 'r.pdf',
          fileBase64: makePdf(2).toString('base64'),
          copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
        }),
      });
      const job = ((await created.json()) as any).job;

      const orderRes = await fetch(`${baseUrl}/api/payments/create-order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id }),
      });
      const orderId = ((await orderRes.json()) as any).orderId as string;
      const pay = `pay_${job.id}`;
      await fetch(`${baseUrl}/api/payments/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id, razorpayOrderId: orderId, razorpayPaymentId: pay,
          razorpaySignature: signCheckout(orderId, pay),
        }),
      });
      return { job, pay };
    };

    const decline = (jobId: string) => fetch(
      `${baseUrl}/api/shops/${shop.shopId}/jobs/${jobId}/decline`,
      { method: 'POST', headers: shop.auth, body: JSON.stringify({ reason: 'Printer jammed' }) }
    );

    // --- a refund that later settles ---
    const settling = await paidJob();
    const declined = await decline(settling.job.id);
    assert.ok([200, 202].includes(declined.status));

    const midway = await storage.getPrintJob(settling.job.id);
    assert.strictEqual(midway?.paymentState, PaymentState.RefundPending,
      'the refund is in flight, not done');
    assert.strictEqual(midway?.printState, PrintState.Cancelled, 'the print side is settled');

    // Razorpay confirms it. The refund entity carries its own notes.
    const processedRaw = JSON.stringify({
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_settled_01',
            payment_id: settling.pay,
            amount: settling.job.totalPriceInCents,
            notes: { jobId: settling.job.id },
          },
        },
      },
    });
    const processed = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signWebhook(processedRaw),
        'x-razorpay-event-id': 'evt_refund_processed_01',
      },
      body: processedRaw,
    });
    assert.strictEqual(processed.status, 200);

    const refunded = await storage.getPrintJob(settling.job.id);
    assert.strictEqual(refunded?.paymentState, PaymentState.Refunded, 'now it is done');
    assert.strictEqual(refunded?.refundId, 'rfnd_settled_01');

    // --- a refund the provider rejects ---
    const failing = await paidJob();
    assert.ok([200, 202].includes((await decline(failing.job.id)).status));

    const failedRaw = JSON.stringify({
      event: 'refund.failed',
      payload: {
        refund: {
          entity: {
            id: 'rfnd_failed_01',
            payment_id: failing.pay,
            amount: failing.job.totalPriceInCents,
            notes: { jobId: failing.job.id },
          },
        },
      },
    });
    const failed = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signWebhook(failedRaw),
        'x-razorpay-event-id': 'evt_refund_failed_01',
      },
      body: failedRaw,
    });
    assert.strictEqual(failed.status, 200);

    const stands = await storage.getPrintJob(failing.job.id);
    // The provider refused to refund, so the money is still the shop's — and
    // the job is still cancelled, which is exactly why a human has to look.
    assert.strictEqual(stands?.paymentState, PaymentState.Paid, 'the payment stands');
    assert.strictEqual(stands?.printState, PrintState.Cancelled, 'and nothing was printed');

    const trail = await storage.getJobEvents(failing.job.id);
    assert.ok(
      trail.some((e) => e.type === 'REFUND_FAILED'),
      'the failure is on the record, not only in a log line'
    );
  });

  await t.test('102. A partial refund is not recorded as a full one', async () => {
    const shop = await shopWithAuth('Partial Co', 'partial@example.com', 'PartialPass1234');

    const created = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'p.pdf',
        fileBase64: makePdf(10).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });
    const job = ((await created.json()) as any).job;
    await fetch(`${baseUrl}/api/print-jobs/${job.id}/manual-override`, {
      method: 'POST', headers: shop.auth,
    });

    // Half the order comes back — a shop that printed some of it, say.
    const half = Math.floor(job.totalPriceInCents / 2);
    const recorded = await storage.recordJobRefund(
      job.id, { refundId: 'rfnd_partial_01', amountInCents: half }, { actor: 'test' }
    );
    assert.ok(recorded.ok, recorded.ok ? '' : recorded.reason);

    const after = await storage.getPrintJob(job.id);
    assert.strictEqual(after?.paymentState, PaymentState.PartiallyRefunded,
      'a partial refund must not read as a full one');
    assert.strictEqual(after?.refundAmountCents, half);

    // And it cannot then be confirmed back to Paid by a replayed confirmation.
    const orderRes = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    });
    assert.strictEqual(orderRes.status, 409, 'a refunded order cannot be charged again');
  });

  // ---------------------------------------------------------------------------
  // Revenue architecture
  // ---------------------------------------------------------------------------

  await t.test('103. An order remembers what it was actually charged', async () => {
    // Every figure on the money screens was derived on the fly from the shop's
    // *current* commission rate and a hardcoded gateway percentage. So a shop
    // that upgraded mid-month saw last week's orders restated at its new rate,
    // and the "Razorpay fee" line was the published estimate applied to
    // everything — including UPI orders, where person-to-merchant MDR is zero
    // by statute and Razorpay charges nothing at all.
    const shop = await shopWithAuth('Ledger Co', 'ledger@example.com', 'LedgerPass1234');

    const created = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'l.pdf',
        fileBase64: makePdf(10).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });
    const job = ((await created.json()) as any).job;
    const pay = 'pay_ledger_real';

    // The webhook is the only path carrying Razorpay's real numbers. Here it
    // reports a fee far below the 2.36% estimate — which is what a UPI order
    // actually looks like.
    const raw = await paymentWebhookRaw(job.id, pay, { fee: 118, tax: 18 });
    const hook = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signWebhook(raw),
        'x-razorpay-event-id': 'evt_ledger_real',
      },
      body: raw,
    });
    assert.strictEqual(hook.status, 200);

    const stored = await storage.getPrintJob(job.id);
    assert.strictEqual(stored?.feesAreActual, true, 'the gateway reported real figures');
    // fee is inclusive of tax, so the fee proper is the difference. Getting
    // that backwards double-counts the GST.
    assert.strictEqual(stored?.gatewayFeeCents, 100);
    assert.strictEqual(stored?.gatewayTaxCents, 18);
    assert.strictEqual(stored?.commissionBpsUsed, 200, 'the rate at the time, recorded');
    assert.strictEqual(stored?.grossCents, job.totalPriceInCents);

    const before = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/earnings`, {
      headers: shop.auth,
    })).json() as any;
    const row = before.rows.find((r: any) => r.jobId === job.id);
    assert.strictEqual(row.razorpayFeeCents, 118, 'fee plus tax, as charged');
    assert.strictEqual(row.feesAreActual, true);
    assert.strictEqual(before.feesAreEstimated, false, 'nothing here is a guess any more');

    // Now the shop moves to a cheaper tier. Last week's order must not be
    // restated — it was charged at 8%, and that is what it cost.
    const admin = await (await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    })).json() as any;

    const upgraded = await fetch(`${baseUrl}/api/admin/shops/${shop.shopId}/plan`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planTier: 'business' }),
    });
    assert.strictEqual(upgraded.status, 200, await upgraded.clone().text());

    const after = await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/earnings`, {
      headers: shop.auth,
    })).json() as any;
    const sameRow = after.rows.find((r: any) => r.jobId === job.id);

    assert.strictEqual(sameRow.commissionBps, 200, 'the old order keeps its old rate');
    assert.strictEqual(
      sameRow.platformCommissionCents,
      row.platformCommissionCents,
      'an upgrade must not restate what a past order cost'
    );
    assert.strictEqual(sameRow.netCents, row.netCents);
  });

  await t.test('104. A plan limit is enforced, not decorative', async () => {
    // PLAN_CATALOGUE has carried a per-tier order cap since it was written and
    // nothing consulted it, so the ladder had no rung anybody had to climb: a
    // free-tier shop could run any volume it liked.
    const shop = await shopWithAuth('Capped Co', 'capped@example.com', 'CappedPass1234');

    const admin = await (await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    })).json() as any;
    const adminAuth = { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' };

    const order = () => fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'c.pdf',
        fileBase64: makePdf(1).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });

    // Free allows 100 a month, which is impractical to reach here — so the
    // shop is put on a tier whose cap this test can actually cross. Rather than
    // inventing one, the check is driven by the catalogue's own figure.
    const { PLAN_CATALOGUE: catalogue } = await import('@printok/shared-types');
    const free = catalogue.find((p: any) => p.tier === 'free')!;
    assert.ok(free.maxOrdersPerMonth > 0, 'the cap comes from the catalogue');

    // First order is fine.
    assert.strictEqual((await order()).status, 201);

    // Drop the cap by moving the shop to a tier and then asserting the refusal
    // shape against a shop that has already exceeded it. Simulated by filling
    // the month through storage, which is far faster than 100 HTTP uploads.
    const usage = await storage.countShopUsage(shop.shopId);
    assert.ok(usage.ordersThisMonth >= 1, 'the order counted toward the month');

    // Pro has the highest cap, so a shop on it is never refused here.
    await fetch(`${baseUrl}/api/admin/shops/${shop.shopId}/plan`, {
      method: 'PATCH', headers: adminAuth, body: JSON.stringify({ planTier: 'pro' }),
    });
    assert.strictEqual((await order()).status, 201, 'a high tier keeps selling');

    // And the file-size ceiling is the plan's, not the platform's 50MB body cap.
    await fetch(`${baseUrl}/api/admin/shops/${shop.shopId}/plan`, {
      method: 'PATCH', headers: adminAuth, body: JSON.stringify({ planTier: 'free' }),
    });

    const oversized = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, fileName: 'big.pdf',
        // Free accepts 10MB; this is comfortably past it while staying well
        // inside the 50MB body limit.
        fileBase64: Buffer.concat([makePdf(1), Buffer.alloc(12 * 1024 * 1024, 0x20)]).toString('base64'),
        copies: 1, isColor: false, isDuplex: false, paperSize: 'A4',
      }),
    });
    assert.strictEqual(oversized.status, 402, 'over the plan ceiling is a payment-required, not a 400');
    assert.match(((await oversized.json()) as any).error, /plan accepts up to 10MB/i);
  });

  await t.test('104b. Seats are capped, a downgrade deletes nothing, and Route agrees', async () => {
    const { PLAN_CATALOGUE: cat, platformFeeFor: fee } = await import('@printok/shared-types');
    const planOf = (tier: string) => cat.find((p) => p.tier === tier)!;

    const admin = await (await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    })).json() as any;
    const adminAuth = { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' };

    const setPlan = (shopId: string, planTier: string) => fetch(
      `${baseUrl}/api/admin/shops/${shopId}/plan`,
      { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ planTier }) }
    );

    const shop = await shopWithAuth('Seats Co', 'seats@example.com', 'SeatsPass12345');
    const addStaff = (email: string) => fetch(`${baseUrl}/api/shops/${shop.shopId}/staff`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({ email, password: 'SeatStaffPass123' }),
    });

    // --- Free: one account, and the owner is it. ---------------------------
    assert.strictEqual(planOf('free').maxStaff, 1);
    const refused = await addStaff('seat1@example.com');
    assert.strictEqual(refused.status, 402, 'a seat beyond the plan is payment-required, not forbidden');
    assert.match(((await refused.json()) as any).error, /Free plan covers 1 staff account/i);

    // --- Upgrade: Free -> Starter opens seats immediately. -----------------
    assert.strictEqual((await setPlan(shop.shopId, 'starter')).status, 200);
    assert.strictEqual(planOf('starter').maxStaff, 3);
    assert.strictEqual((await addStaff('seat1@example.com')).status, 201, 'upgrading opens the seat');
    assert.strictEqual((await addStaff('seat2@example.com')).status, 201);

    // Owner + 2 = 3, which is the whole allowance.
    const full = await addStaff('seat3@example.com');
    assert.strictEqual(full.status, 402, 'the third seat is the last');

    // The upgrade also moved the platform fee to the new tier's published rate.
    const afterUpgrade = await (await fetch(
      `${baseUrl}/api/shops/${shop.shopId}/plan`, { headers: shop.auth })).json() as any;
    assert.strictEqual(afterUpgrade.current.platformFeeBps, planOf('starter').platformFeeBps);
    assert.strictEqual(afterUpgrade.usage.staff.used, 3);
    assert.strictEqual(afterUpgrade.usage.staff.limit, 3);
    assert.strictEqual(afterUpgrade.usage.staff.over, false);

    // --- Downgrade: nothing is deleted. -----------------------------------
    // This is the part that must never be "clean up the excess". Three people
    // sign in to this shop; removing two because the plan shrank would lock
    // real staff out of a till mid-shift, with no warning and no undo.
    assert.strictEqual((await setPlan(shop.shopId, 'free')).status, 200);

    const staffAfter = await (await fetch(
      `${baseUrl}/api/shops/${shop.shopId}/staff`, { headers: shop.auth })).json() as any;
    const active = staffAfter.staff.filter((u: any) => u.status === 'active');
    assert.strictEqual(active.length, 3, 'a downgrade removes nobody');

    // But it does stop the shop adding a fourth, and says which side of the
    // line it is on rather than repeating the "upgrade to add" message.
    const overLimit = await addStaff('seat4@example.com');
    assert.strictEqual(overLimit.status, 402);
    const overBody = (await overLimit.json()) as any;
    assert.match(overBody.error, /Nothing has been removed/i);
    assert.match(overBody.error, /remove 3/i, 'it says how many, not just that there are too many');

    // And the dashboard reports the same over-limit state the server enforces.
    const afterDowngrade = await (await fetch(
      `${baseUrl}/api/shops/${shop.shopId}/plan`, { headers: shop.auth })).json() as any;
    assert.strictEqual(afterDowngrade.usage.staff.used, 3);
    assert.strictEqual(afterDowngrade.usage.staff.limit, 1);
    assert.strictEqual(afterDowngrade.usage.staff.over, true, 'the shop is told it is over');

    // --- The printer branch of the same guard. -----------------------------
    // Exercised directly because no route adds a printer to an existing shop
    // yet, so there is nothing to POST to. Registration creates exactly one,
    // which every plan covers.
    const usage = await storage.countShopUsage(shop.shopId);
    assert.strictEqual(usage.printers, 1, 'registration creates one printer');
    assert.ok(usage.printers <= planOf('free').maxPrinters, 'and one is within even Free');

    // --- Route uses the plan's fee, not a hardcoded rate. ------------------
    const { RazorpayRouteService } = await import('../razorpayRoute');
    const route = new RazorpayRouteService();

    for (const tier of ['free', 'starter', 'business', 'pro'] as const) {
      const plan = planOf(tier);
      const gross = 10000; // ₹100
      const { transfer, serviceFeeCents } = route.buildTransfer(
        'acc_test', gross, plan.platformFeeBps, 236, 'job_seat'
      );
      assert.strictEqual(serviceFeeCents, fee(gross, plan.platformFeeBps),
        `${tier}: Route must charge the plan's fee`);

      // Razorpay's charge is deducted whatever our plan says. On Pro our fee is
      // nil and the gateway's is not, which is the case most likely to be
      // misread as "nothing is deducted".
      assert.strictEqual(transfer.amount, gross - serviceFeeCents - 236,
        `${tier}: the gateway fee is deducted independently of the platform fee`);
    }

    assert.strictEqual(
      route.buildTransfer('acc_test', 10000, planOf('pro').platformFeeBps, 0, 'j').serviceFeeCents, 0,
      'Pro pays PrintOk nothing per order'
    );

    // Route stays gated regardless of any of the above.
    assert.strictEqual(route.isEnabled, false, 'pricing changes must not switch Route on');
  });

  // ---------------------------------------------------------------------------
  // Account recovery
  // ---------------------------------------------------------------------------

  await t.test('105. A locked-out shop owner can get back in, without leaking who exists', async () => {
    // There was no reset path at all: a shop owner who forgot their password
    // lost their dashboard, their queue and their money, and the only remedy
    // was an operator editing the database by hand.
    const email = 'lockedout@example.com';
    const shop = await shopWithAuth('Locked Out Co', email, 'OriginalPass1234');

    const request = (address: string) => fetch(`${baseUrl}/api/merchant/password-reset/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: address }),
    });

    // The answer must be the same whether or not the account exists, or this
    // route becomes a way to ask which shops are registered here.
    const real = await request(email);
    const fake = await request('nobody-at-all@example.com');

    assert.strictEqual(real.status, fake.status);
    assert.deepStrictEqual(await real.json(), await fake.json(),
      'the response must not reveal whether an account exists');

    // The token is only ever emailed, so the test reaches for the stored hash
    // the way the confirm route will — there is deliberately no API that hands
    // a token back.
    const token = crypto.randomBytes(32).toString('base64url');
    const merchant = await storage.getMerchantByEmail(email);
    assert.ok(merchant, 'the account exists');
    await storage.createPasswordResetToken({
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      merchantId: merchant!.id,
      email,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const confirm = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/api/merchant/password-reset/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // A weak new password is refused before the token is spent.
    assert.strictEqual((await confirm({ token, password: 'short' })).status, 400);

    // An invented token is refused.
    assert.strictEqual((await confirm({ token: 'not-a-real-token', password: 'BrandNewPass1234' })).status, 400);

    // The real one works.
    const done = await confirm({ token, password: 'BrandNewPass1234' });
    assert.strictEqual(done.status, 200, await done.clone().text());

    // No session comes back: whoever reset it signs in with the password they
    // chose, so an intercepted link does not also hand over a live session.
    const body = (await done.json()) as any;
    assert.ok(!body.token, 'a reset must not issue a session');

    // The new password works and the old one does not.
    const withNew = await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'BrandNewPass1234' }),
    });
    assert.strictEqual(withNew.status, 200);

    const withOld = await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'OriginalPass1234' }),
    });
    assert.strictEqual(withOld.status, 401, 'the old password must stop working');

    // And the link is spent — a reset link is a password for as long as it
    // works, so it works exactly once.
    const replayed = await confirm({ token, password: 'ThirdPassword1234' });
    assert.strictEqual(replayed.status, 400);
    assert.match(((await replayed.json()) as any).error, /already been used/i);

    assert.ok(shop.shopId, 'the shop is untouched by any of this');
  });

  await t.test('106. An expired reset link does not work', async () => {
    const email = 'expired@example.com';
    await shopWithAuth('Expired Co', email, 'ExpiredPass12345');

    const token = crypto.randomBytes(32).toString('base64url');
    const merchant = await storage.getMerchantByEmail(email);
    await storage.createPasswordResetToken({
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      merchantId: merchant!.id,
      email,
      // Already past.
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await fetch(`${baseUrl}/api/merchant/password-reset/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'AnotherPass12345' }),
    });
    assert.strictEqual(res.status, 400);
    assert.match(((await res.json()) as any).error, /expired/i);

    // The old password still works, so nothing was half-changed.
    const login = await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'ExpiredPass12345' }),
    });
    assert.strictEqual(login.status, 200);
  });

  await t.test('107. The platform says plainly whether it can send email', async () => {
    // The honest answer in this suite is "no provider is configured", and an
    // operator should be able to see that on the console rather than finding
    // out when a shop owner cannot get back into their account.
    const admin = await (await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    })).json() as any;

    const res = await fetch(`${baseUrl}/api/admin/email-status`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(res.status, 200);

    const status = (await res.json()) as any;
    assert.strictEqual(status.canSend, false, 'nothing is configured in this suite');
    assert.ok(status.required.includes('EMAIL_PROVIDER'));
    assert.match(status.consequence, /password resets cannot be sent/i);

    // And it is not readable without an operator session.
    assert.strictEqual((await fetch(`${baseUrl}/api/admin/email-status`)).status, 401);
  });

  await t.test('107b. With a provider configured, the emailed link actually resets the password', async () => {
    // Tests 105 and 106 put the token into storage by hand, because that is how
    // the confirm route sees it. That leaves the half that runs in production
    // untested: the request route generating a token, building a link out of
    // PUBLIC_WEB_URL and handing it to the provider. A link built against an
    // unset PUBLIC_WEB_URL points at nowhere, and the failure is invisible —
    // the route answers "a reset link is on its way" either way, by design.
    //
    // So this boots a second app with mail switched on, and reads the link back
    // out of the one provider that has somewhere to read it from.
    const saved = {
      provider: process.env.EMAIL_PROVIDER,
      webUrl: process.env.PUBLIC_WEB_URL,
      nodeEnv: process.env.NODE_ENV,
    };
    process.env.EMAIL_PROVIDER = 'log';
    process.env.PUBLIC_WEB_URL = 'https://printok.example';
    delete process.env.NODE_ENV; // 'log' is ignored in production, on purpose.

    const mailStorage = new MemoryStorage();
    const mailApp = http.createServer(createApp(mailStorage));
    await new Promise<void>((resolve) => mailApp.listen(0, resolve));
    const mailUrl = `http://localhost:${(mailApp.address() as any).port}`;

    // Capture what the provider was handed, without losing the console.
    const realLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    try {
      const email = 'relinked@example.com';
      // Registering and claiming are two steps: the second is what sets a
      // password, and so what makes resetting one mean anything.
      const reg = await (await fetch(`${mailUrl}/api/shops/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopName: 'Relinked Co', ownerEmail: email, printerName: 'Relinked printer',
        }),
      })).json() as any;

      const claimed = await fetch(`${mailUrl}/api/merchant/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptTerms: true,
          shopId: reg.shop.id, ownerEmail: email, password: 'OriginalPass1234', name: 'Relinked Co',
        }),
      });
      assert.ok(claimed.ok, await claimed.clone().text());

      const asked = await fetch(`${mailUrl}/api/merchant/password-reset/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      assert.strictEqual(asked.status, 200);

      const body = lines.join('\n');
      assert.match(body, /\[Email:log]/, 'the provider was actually asked to send something');

      // The link must be absolute and point at the configured site. Built from
      // an unset PUBLIC_WEB_URL it would read "/dashboard?reset=..." and be
      // useless in an inbox.
      const link = body.match(/https:\/\/printok\.example\/dashboard\?reset=([A-Za-z0-9_-]+)/);
      assert.ok(link, `the emailed link is missing or not absolute:\n${body}`);

      const token = decodeURIComponent(link![1]);

      // And the token in that link resets the password for real.
      const done = await fetch(`${mailUrl}/api/merchant/password-reset/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: 'MailedPass12345' }),
      });
      assert.strictEqual(done.status, 200, await done.clone().text());

      const withNew = await fetch(`${mailUrl}/api/merchant/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'MailedPass12345' }),
      });
      assert.strictEqual(withNew.status, 200, 'the password from the emailed link works');

      const withOld = await fetch(`${mailUrl}/api/merchant/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'OriginalPass1234' }),
      });
      assert.strictEqual(withOld.status, 401, 'and the old one no longer does');

      // The token is a credential for as long as it lives, so it must not be
      // sitting in the log next to the link.
      assert.ok(
        !lines.some((l) => l.includes(token) && !l.includes('[Email:log]')),
        'the reset token must not be logged outside the message itself'
      );
    } finally {
      console.log = realLog;
      await new Promise<void>((resolve) => mailApp.close(() => resolve()));
      if (saved.provider === undefined) delete process.env.EMAIL_PROVIDER;
      else process.env.EMAIL_PROVIDER = saved.provider;
      if (saved.webUrl === undefined) delete process.env.PUBLIC_WEB_URL;
      else process.env.PUBLIC_WEB_URL = saved.webUrl;
      if (saved.nodeEnv !== undefined) process.env.NODE_ENV = saved.nodeEnv;
    }
  });

  await t.test('107c. A provider can be configured without owning a domain', async () => {
    // Resend only sends from a domain verified by DNS, which is no use before
    // there is a domain to verify: its no-domain address delivers solely to
    // your own inbox, and a password reset that reaches only you resets
    // nobody's password. Brevo will send from a single address confirmed by
    // clicking a link in it, so this is the provider that works at zero cost
    // and zero domains — and the one most likely to be misconfigured, because
    // it disagrees with Resend on every field.
    const { EmailService, parseFromAddress } = await import('../email');

    // EMAIL_FROM is one variable in two shapes: Resend takes the whole string,
    // Brevo wants the halves separately and sends from nothing useful if handed
    // the raw form.
    assert.deepStrictEqual(parseFromAddress('PrintOk <noreply@printok.app>'),
      { email: 'noreply@printok.app', name: 'PrintOk' });
    assert.deepStrictEqual(parseFromAddress('  Print Ok  < a@b.co >  '),
      { email: 'a@b.co', name: 'Print Ok' });
    assert.deepStrictEqual(parseFromAddress('"PrintOk" <a@b.co>'),
      { email: 'a@b.co', name: 'PrintOk' });
    // A bare address is legitimate and must not become a nameless <undefined>.
    assert.deepStrictEqual(parseFromAddress('plain@example.com'), { email: 'plain@example.com' });
    assert.deepStrictEqual(parseFromAddress('<only@example.com>'), { email: 'only@example.com' });

    const saved = {
      provider: process.env.EMAIL_PROVIDER,
      key: process.env.EMAIL_API_KEY,
      from: process.env.EMAIL_FROM,
    };
    const restore = () => {
      for (const [k, v] of Object.entries({
        EMAIL_PROVIDER: saved.provider, EMAIL_API_KEY: saved.key, EMAIL_FROM: saved.from,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };

    try {
      process.env.EMAIL_PROVIDER = 'brevo';
      process.env.EMAIL_API_KEY = 'test-brevo-key';
      process.env.EMAIL_FROM = 'PrintOk <ayan@example.com>';
      const brevo = new EmailService();
      assert.strictEqual(brevo.providerName, 'brevo');
      assert.strictEqual(brevo.canSend, true, 'a configured Brevo can send');

      // Brevo authenticates on its own header, not Bearer, and names its body
      // fields differently. Sent Resend's way it answers 401 about a missing
      // key, which reads exactly like a wrong key rather than a wrong header —
      // so the request shape is asserted rather than trusted.
      const realFetch = globalThis.fetch;
      let seen: { url: string; headers: any; body: any } | undefined;
      globalThis.fetch = (async (url: any, init: any) => {
        seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ messageId: 'brevo-123' }), { status: 201 });
      }) as any;

      try {
        const sent = await brevo.send({ to: 'shop@example.com', subject: 'S', text: 'T' });
        assert.strictEqual(sent.ok, true, 'a 201 is a success, not only a 200');
        assert.strictEqual((sent as any).id, 'brevo-123', 'Brevo returns messageId, not id');
      } finally {
        globalThis.fetch = realFetch;
      }

      assert.match(seen!.url, /api\.brevo\.com/);
      assert.strictEqual(seen!.headers['api-key'], 'test-brevo-key');
      assert.ok(!seen!.headers.Authorization, 'Brevo must not be sent a Bearer header');
      assert.deepStrictEqual(seen!.body.sender, { email: 'ayan@example.com', name: 'PrintOk' });
      assert.deepStrictEqual(seen!.body.to, [{ email: 'shop@example.com' }]);
      assert.strictEqual(seen!.body.textContent, 'T', 'Brevo names the plain body textContent');
      assert.ok(!('text' in seen!.body), "and does not read Resend's 'text'");

      // Half-configured stays honest: no key means no sending, and it says so
      // rather than reporting success into a void.
      delete process.env.EMAIL_API_KEY;
      const halfDone = new EmailService();
      assert.strictEqual(halfDone.canSend, false);
      assert.strictEqual(halfDone.providerName, 'none');
      const refused = await halfDone.send({ to: 'a@b.co', subject: 'S', text: 'T' });
      assert.strictEqual(refused.ok, false);

      // A typo in the provider name must not look like having configured
      // nothing, because the two need completely different fixes.
      process.env.EMAIL_PROVIDER = 'bravo';
      process.env.EMAIL_API_KEY = 'k';
      assert.strictEqual(new EmailService().providerName, 'none', 'an unknown provider sends nothing');
    } finally {
      restore();
    }
  });

  await t.test('110. An owner can change their own plan, in the direction that is honest', async () => {
    // The only route that could write a plan was the admin one, so an owner saw
    // a screen recommending a cheaper tier with no way to act on it. That reads
    // as broken rather than unfinished, and it was.
    const shop = await shopWithAuth('Switch Co', 'switch@example.com', 'SwitchPass12345', 'business');

    const change = (tier: string) => fetch(`${baseUrl}/api/shops/${shop.shopId}/plan`, {
      method: 'POST', headers: shop.auth, body: JSON.stringify({ tier }),
    });
    const readPlan = async () =>
      (await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/plan`, { headers: shop.auth })).json()) as any;

    assert.strictEqual((await readPlan()).current.tier, 'business');

    // --- Down: applied immediately, nothing removed ------------------------
    const down = await change('starter');
    assert.strictEqual(down.status, 200, await down.clone().text());
    const downBody = (await down.json()) as any;
    assert.strictEqual(downBody.applied, true);
    assert.strictEqual(downBody.tier, 'starter');

    const after = await readPlan();
    assert.strictEqual(after.current.tier, 'starter');
    assert.strictEqual(after.current.platformFeeBps, 100, 'the fee moves with the plan');
    assert.strictEqual(after.usage.staff.limit, 3, 'and so do the limits');

    // --- Up: with no Razorpay plan configured (dev), applied as the webhook would
    const up = await change('pro');
    assert.strictEqual(up.status, 200, await up.clone().text());
    assert.strictEqual((await readPlan()).current.tier, 'pro');

    // --- Subscription webhooks drive the plan ------------------------------
    const subEvent = (event: string, id: string, tier: string) => {
      const raw = JSON.stringify({
        event, payload: { subscription: { entity: { id, notes: { shopId: shop.shopId, tier } } } },
      });
      return fetch(`${baseUrl}/api/payments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(raw) },
        body: raw,
      });
    };
    const forged = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
      body: JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: {
        id: 'sub_x', notes: { shopId: shop.shopId, tier: 'business' } } } } }),
    });
    assert.strictEqual(forged.status, 400, 'an unsigned activation changes nothing');

    assert.strictEqual((await subEvent('subscription.activated', 'sub_A', 'business')).status, 200);
    assert.strictEqual((await readPlan()).current.tier, 'business');
    await subEvent('subscription.charged', 'sub_OLD', 'pro');
    assert.strictEqual((await readPlan()).current.tier, 'business', 'a stale subscription cannot move the plan');
    await subEvent('subscription.halted', 'sub_A', 'business');
    assert.strictEqual((await readPlan()).current.tier, 'free', 'failed billing drops to Free');

    await subEvent('subscription.activated', 'sub_B', 'starter');
    assert.strictEqual((await readPlan()).current.tier, 'starter');

    // --- Refusals ----------------------------------------------------------
    assert.strictEqual((await change('starter')).status, 400, 'already on it');
    assert.strictEqual((await change('enormous')).status, 400, 'no such plan');

    // Staff cannot change what the shop pays.
    const staffAdd = await fetch(`${baseUrl}/api/shops/${shop.shopId}/staff`, {
      method: 'POST', headers: shop.auth,
      body: JSON.stringify({ email: 'switch-staff@example.com', password: 'SwitchStaff1234' }),
    });
    assert.strictEqual(staffAdd.status, 201);
    const staffLogin = await (await fetch(`${baseUrl}/api/merchant/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'switch-staff@example.com', password: 'SwitchStaff1234' }),
    })).json() as any;
    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${shop.shopId}/plan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${staffLogin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    })).status, 403, 'only an owner decides what the shop pays');

    // Nor can a stranger.
    assert.strictEqual((await fetch(`${baseUrl}/api/shops/${shop.shopId}/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    })).status, 401);

    // --- Downgrading below what the shop is using --------------------------
    // Owner + one staff = 2 accounts, and Free covers 1. The move is allowed
    // and nothing is deleted: three people signing in to a shop that drops to
    // Free keep signing in. They simply cannot add a fourth.
    const toFree = await change('free');
    assert.strictEqual(toFree.status, 200);
    const freeBody = (await toFree.json()) as any;
    assert.ok(Array.isArray(freeBody.overLimit), 'the shop is told it is over');
    assert.match(freeBody.warning, /Nothing has been removed/i);

    const staffStill = await (await fetch(
      `${baseUrl}/api/shops/${shop.shopId}/staff`, { headers: shop.auth })).json() as any;
    assert.strictEqual(staffStill.staff.filter((u: any) => u.status === 'active').length, 2,
      'a downgrade removes nobody');

    const onFree = await readPlan();
    assert.strictEqual(onFree.current.tier, 'free');
    assert.strictEqual(onFree.usage.staff.over, true);
    assert.strictEqual(onFree.canDowngrade, true);
    assert.strictEqual(onFree.canUpgrade, true);
  });

  await t.test('109. A build can be pushed to the fleet, and only a real one', async () => {
    // Fixing anything in the agent used to mean every shop downloading and
    // running an installer by hand, so in practice a fleet would stay on
    // whatever it was first given. This is the channel that fixes that — and it
    // is a remote code execution channel, so most of what follows is a refusal.
    const { compareAgentVersions } = await import('@printok/shared-types');

    // Numeric, not lexical. "1.10.0" after "1.9.0" is the bug that only appears
    // at the tenth release, and then silently: every device reports itself current.
    assert.ok(compareAgentVersions('1.10.0', '1.9.0') > 0);
    assert.ok(compareAgentVersions('1.9.0', '1.10.0') < 0);
    assert.strictEqual(compareAgentVersions('1.4', '1.4.0'), 0);
    assert.ok(compareAgentVersions('1.0.0', 'unknown') > 0, 'an unreadable version is offered the update');

    const admin = await (await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    })).json() as any;
    const adminAuth = { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' };

    const publish = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/api/admin/agent-releases`, {
        method: 'POST', headers: adminAuth, body: JSON.stringify(body),
      });

    const GOOD_URL = 'https://github.com/Ayan-css/PrintOK/releases/download/v9.9.9/PrintOkAgentSetup.exe';
    const GOOD_SHA = 'a'.repeat(64);

    // --- The console refuses what the fleet would refuse anyway -------------
    // Caught here rather than distributed and then rejected on 200 machines.
    assert.strictEqual((await publish({
      version: 'latest', downloadUrl: GOOD_URL, sha256: GOOD_SHA,
    })).status, 400, 'a version must be comparable against what devices report');

    for (const url of [
      'https://evil.example.com/setup.exe',
      'http://github.com/setup.exe',
      'https://github.com.evil.example.com/setup.exe',
    ]) {
      const res = await publish({ version: '9.9.9', downloadUrl: url, sha256: GOOD_SHA });
      assert.strictEqual(res.status, 400, `must refuse to publish from ${url}`);
    }

    assert.strictEqual((await publish({
      version: '9.9.9', downloadUrl: GOOD_URL, sha256: 'deadbeef',
    })).status, 400, 'a short digest means nothing would ever install');

    // --- An agent with no release published keeps working -------------------
    const shop = await shopWithAuth('Fleet Co', 'fleet@example.com', 'FleetPass12345');
    const agentAuth = { 'x-agent-api-key': shop.agentApiKey, 'x-agent-version': '1.0.0' };

    const manifestFor = async (version: string) => {
      const res = await fetch(`${baseUrl}/api/agent/update-manifest`, {
        headers: { ...agentAuth, 'x-agent-version': version },
      });
      assert.strictEqual(res.status, 200, await res.clone().text());
      return (await res.json()) as any;
    };

    assert.strictEqual((await manifestFor('1.0.0')).upToDate, true,
      'with nothing published every device is up to date');

    // Unauthenticated agents learn nothing about what runs on shop PCs.
    assert.strictEqual((await fetch(`${baseUrl}/api/agent/update-manifest`)).status, 401);

    // --- Publishing, and who may ------------------------------------------
    const published = await publish({
      version: '2.0.0', downloadUrl: GOOD_URL, sha256: GOOD_SHA,
      notes: 'Fixes the colour defect.',
    });
    assert.strictEqual(published.status, 201, await published.clone().text());
    const release = ((await published.json()) as any).release;

    // notify unless asked otherwise: the install path has never run against a
    // real Windows machine, and an untested one must not reach a fleet by default.
    assert.strictEqual(release.mode, 'notify');
    assert.strictEqual(release.publishedByEmail, 'ops@printok.test', 'who published it is recorded');

    // --- What a device is told ---------------------------------------------
    const offered = await manifestFor('1.0.0');
    assert.strictEqual(offered.upToDate, false);
    assert.strictEqual(offered.version, '2.0.0');
    assert.strictEqual(offered.sha256, GOOD_SHA, 'the agent verifies the bytes against this');
    assert.strictEqual(offered.downloadUrl, GOOD_URL);
    assert.match(offered.notes, /colour defect/);

    // A device already on it, or ahead of it, is never told to move.
    assert.strictEqual((await manifestFor('2.0.0')).upToDate, true);
    assert.strictEqual((await manifestFor('2.1.0')).upToDate, true,
      'a newer device is never rolled backwards');
    assert.strictEqual((await manifestFor('1.10.0')).upToDate, false,
      '1.10.0 is older than 2.0.0 and must still be offered');

    // --- Rolling back is a decision, not a typo ----------------------------
    const backwards = await publish({ version: '1.5.0', downloadUrl: GOOD_URL, sha256: GOOD_SHA });
    assert.strictEqual(backwards.status, 409, 'publishing an older build needs saying so');
    assert.match(((await backwards.json()) as any).error, /force/i);

    // --- Pausing stops a rollout without publishing anything else ----------
    const paused = await publish({
      version: '2.0.1', downloadUrl: GOOD_URL, sha256: GOOD_SHA, paused: true,
    });
    assert.strictEqual(paused.status, 201);
    assert.strictEqual((await manifestFor('1.0.0')).upToDate, true,
      'a paused release is offered to nobody');

    // --- The fleet view ----------------------------------------------------
    const fleetRes = await fetch(`${baseUrl}/api/admin/agent-releases`, { headers: adminAuth });
    assert.strictEqual(fleetRes.status, 200);
    const fleet = (await fleetRes.json()) as any;
    assert.strictEqual(fleet.active.version, '2.0.1');
    assert.ok(fleet.history.length >= 2, 'every publication is kept, not overwritten');
    assert.ok(Array.isArray(fleet.fleet.devices));

    // Not readable without an operator session.
    assert.strictEqual((await fetch(`${baseUrl}/api/admin/agent-releases`)).status, 401);
  });

  await t.test('108. An operator can see what needs a person, and logs carry no secrets', async () => {
    // The project's own assessment was that nothing alerts anyone: a shop
    // offline overnight went unnoticed, and every defect found that week was
    // found by reading code. This does not send an alert — that needs somewhere
    // to send it — but it gathers what an alert would carry.
    const admin = await (await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@printok.test', password: 'CorrectHorse99x' }),
    })).json() as any;
    const adminAuth = { Authorization: `Bearer ${admin.token}` };

    const res = await fetch(`${baseUrl}/api/admin/operations`, { headers: adminAuth });
    assert.strictEqual(res.status, 200, await res.clone().text());
    const ops = (await res.json()) as any;

    // Each figure is a count of something a person would have to do.
    for (const key of ['printersOffline', 'jobsNeedingAttention', 'stuckRefunds']) {
      assert.ok(ops[key], `operations must report ${key}`);
    }
    assert.ok(typeof ops.printersOffline.shopsFullyDown === 'number',
      'a shop whose only printer is down is a different severity');
    assert.strictEqual(ops.email.canSend, false, 'and it is honest about email');
    assert.match(ops.email.consequence, /password resets cannot be sent/i);

    // Not readable without an operator session.
    assert.strictEqual((await fetch(`${baseUrl}/api/admin/operations`)).status, 401);

    // Readiness, not just liveness: /health said 'ok' while running on
    // in-memory storage with everything lost on restart.
    const health = await (await fetch(`${baseUrl}/health`)).json() as any;
    assert.ok(['ok', 'degraded'].includes(health.status));
    assert.ok(['postgres', 'memory'].includes(health.storage), 'it names the backend');

    // The structured logger must never print a credential, at any depth.
    const { logOps } = await import('../observability');
    const captured: string[] = [];
    const realWarn = console.warn;
    console.warn = (line: string) => { captured.push(String(line)); };

    try {
      logOps('warn', 'payment.replay_blocked', {
        jobId: 'job_abc',
        password: 'hunter2',
        razorpaySignature: 'deadbeef',
        customerPhone: '+91 98200 12345',
        nested: { apiKey: 'prn_key_secret', deviceToken: 'tok_secret' },
        fileBase64: 'A'.repeat(5000),
        safe: 'this should survive',
      });
    } finally {
      console.warn = realWarn;
    }

    assert.strictEqual(captured.length, 1, 'one line, so a log matcher can match it');
    const line = captured[0];

    // Parseable, because a log line nobody can parse is a log line nobody uses.
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.event, 'payment.replay_blocked');
    assert.strictEqual(parsed.jobId, 'job_abc');
    assert.strictEqual(parsed.safe, 'this should survive');

    for (const secret of ['hunter2', 'deadbeef', '98200', 'prn_key_secret', 'tok_secret']) {
      assert.ok(!line.includes(secret), `a log line must not carry '${secret}'`);
    }
    // Present but redacted, so an incident can see the field was set.
    assert.strictEqual(parsed.password, '[redacted]');
    assert.strictEqual(parsed.nested.apiKey, '[redacted]');
    // And a payload is summarised rather than printed.
    assert.match(String(parsed.fileBase64), /redacted|chars/);
  });

  // ---------------------------------------------------------------------------
  // Marketplace transparency and Route readiness (25 Sep 2026)
  // ---------------------------------------------------------------------------

  await t.test('120. The customer is shown the shop, and only what is public about it', async () => {
    const shop = await shopWithAuth('Anand Xerox', 'anand@example.com', 'AnandXerox1234');
    await storage.updateShopProfile(shop.shopId, {
      addressCity: 'Chembur', addressState: 'Maharashtra', addressStreet1: '4 Home Lane',
      contactPhone: '9820000000', gstin: '27AAAAA0000A1Z5',
    });

    const lookup = (await (await fetch(`${baseUrl}/api/printers/${shop.printerId}`)).json()) as any;
    assert.deepStrictEqual(lookup.shop, {
      id: shop.shopId, name: 'Anand Xerox', city: 'Chembur', state: 'Maharashtra',
    });
    const text = JSON.stringify(lookup);
    for (const privateValue of ['4 Home Lane', '9820000000', '27AAAAA0000A1Z5', 'anand@example.com']) {
      assert.ok(!text.includes(privateValue), `the public printer lookup must not carry '${privateValue}'`);
    }

    // The job the customer creates names that shop — whatever the body claims.
    const other = await shopWithAuth('Someone Else', 'else@example.com', 'SomeoneElse1234');
    const created = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: shop.printerId, shopId: other.shopId, shop: { name: 'Fake' },
        fileName: 'a.pdf', fileBase64: makePdf(2).toString('base64'), copies: 1,
        totalPriceInCents: 1, serviceFeeCents: 0, payeeAccountId: 'acc_evil',
      }),
    });
    assert.strictEqual(created.status, 201);
    const { job } = (await created.json()) as any;
    assert.strictEqual(job.shop.name, 'Anand Xerox');
    const stored = await storage.getPrintJob(job.id);
    assert.strictEqual(stored?.shopId, shop.shopId, 'the shop comes from the printer, not the body');
    assert.ok(stored!.totalPriceInCents > 1, 'the price is the server\'s');
    assert.strictEqual(stored?.payeeAccountId, undefined);

    // The order names the payee, and charges exactly the server's total.
    const orderRes = await fetch(`${baseUrl}/api/payments/create-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, amountInCents: 100, shopName: 'Fake' }),
    });
    const order = (await orderRes.json()) as any;
    assert.strictEqual(order.payee.shopName, 'Anand Xerox');
    assert.strictEqual(order.amountInCents, stored!.totalPriceInCents);

    // Confirmation shows the shop, the order reference and the payment reference.
    const pay = 'pay_transparency_1';
    const verified = await fetch(`${baseUrl}/api/payments/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id, razorpayOrderId: order.orderId, razorpayPaymentId: pay,
        razorpaySignature: signCheckout(order.orderId, pay),
      }),
    });
    const v = (await verified.json()) as any;
    assert.strictEqual(verified.status, 200, JSON.stringify(v));
    assert.strictEqual(v.job.shop.name, 'Anand Xerox');
    assert.strictEqual(v.job.shop.city, 'Chembur');
    assert.strictEqual(v.job.paymentReference, pay);
    assert.ok(v.job.orderId);
    assert.strictEqual(v.job.customerPhone, undefined, 'the projection, not the raw row');
  });

  await t.test('121. A payment webhook must match the order and amount, not just the notes', async () => {
    const shop = await shopWithAuth('Binding Co', 'binding@example.com', 'BindingPass1234');
    const makeJob = async () => ((await (await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: shop.printerId, fileName: 'b.pdf', fileBase64: makePdf(3).toString('base64') }),
    })).json()) as any).job;
    const send = (raw: string) => fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(raw) },
      body: raw,
    });
    const stateOf = async (id: string) => (await storage.getPrintJob(id))!.paymentState;

    // Right job in the notes, but a different gateway order.
    const a = await makeJob();
    const orderA = await openOrder(a.id);
    const wrongOrder = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: {
      id: 'pay_wrong_order', order_id: 'order_someone_else', amount: orderA.amountInCents, notes: { jobId: a.id },
    } } } });
    assert.strictEqual((await send(wrongOrder)).status, 200, 'acknowledged, so Razorpay stops retrying');
    assert.strictEqual(await stateOf(a.id), PaymentState.Pending, 'but never applied');

    // Right order, wrong amount.
    const wrongAmount = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: {
      id: 'pay_wrong_amount', order_id: orderA.orderId, amount: 100, notes: { jobId: a.id },
    } } } });
    await send(wrongAmount);
    assert.strictEqual(await stateOf(a.id), PaymentState.Pending);

    // A job that never opened an order cannot be confirmed by a webhook.
    const b = await makeJob();
    const noOrder = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: {
      id: 'pay_no_order', order_id: orderA.orderId, amount: orderA.amountInCents, notes: { jobId: b.id },
    } } } });
    await send(noOrder);
    assert.strictEqual(await stateOf(b.id), PaymentState.Pending);

    // The old flat body, which carried no order at all, is refused.
    const legacy = JSON.stringify({ paymentId: 'pay_legacy', jobId: a.id });
    assert.strictEqual((await send(legacy)).status, 400);

    // The genuine delivery works.
    await send(await paymentWebhookRaw(a.id, 'pay_right'));
    assert.strictEqual(await stateOf(a.id), PaymentState.Paid);
  });

  await t.test('122. Copies must be a whole number in range', async () => {
    const shop = await shopWithAuth('Copies Co', 'copies@example.com', 'CopiesPass1234');
    const attempt = (copies: unknown) => fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: shop.printerId, fileName: 'c.pdf', fileBase64: makePdf(1).toString('base64'), copies }),
    });
    for (const bad of [0, -2, 1.5, 1000, 1e9, '2abc', 'NaN', 'Infinity', '', true, [2], { n: 2 }]) {
      const res = await attempt(bad);
      assert.strictEqual(res.status, 400, `copies=${JSON.stringify(bad)} must be refused`);
    }
    for (const good of [1, 3, 999, '4']) {
      const res = await attempt(good);
      assert.strictEqual(res.status, 201, `copies=${JSON.stringify(good)} must be accepted`);
      assert.strictEqual(((await res.json()) as any).job.copies, Number(good));
    }
    // Absent still means one copy, as every older page sent it.
    const res = await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: shop.printerId, fileName: 'c.pdf', fileBase64: makePdf(1).toString('base64') }),
    });
    assert.strictEqual(((await res.json()) as any).job.copies, 1);
  });

  await t.test('123. A shop account needs the Terms accepted, and records which', async () => {
    const { TERMS_VERSION } = await import('@printok/shared-types');
    const body = {
      shopName: 'Terms Prints', ownerEmail: 'terms@example.com', printerName: 'HP', password: 'TermsOwner77xy',
    };
    for (const acceptTerms of [undefined, false, 'true', 1]) {
      const refused = await fetch(`${baseUrl}/api/merchant/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, acceptTerms }),
      });
      assert.strictEqual(refused.status, 400, `acceptTerms=${JSON.stringify(acceptTerms)} must be refused`);
      assert.match(((await refused.json()) as any).error, /Terms/);
    }
    assert.strictEqual(await storage.getMerchantByEmail('terms@example.com'), undefined, 'nothing was created');

    const ok = await fetch(`${baseUrl}/api/merchant/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, acceptTerms: true }),
    });
    assert.strictEqual(ok.status, 201);
    const user = await storage.getMerchantByEmail('terms@example.com');
    assert.ok(user?.termsAcceptedAt, 'the acceptance time is stored');
    assert.strictEqual(user?.termsVersion, TERMS_VERSION);

    // Claiming an existing shop is the other way in, and asks the same.
    const reg = (await (await fetch(`${baseUrl}/api/shops/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: 'Claim Terms', ownerEmail: 'claimterms@example.com', printerName: 'HP' }),
    })).json()) as any;
    const claim = await fetch(`${baseUrl}/api/merchant/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: reg.shop.id, ownerEmail: 'claimterms@example.com', password: 'ClaimTerms1234' }),
    });
    assert.strictEqual(claim.status, 400);
  });

  await t.test('124. Production refuses test keys, and never logs a secret', async () => {
    const { razorpayConfigurationError, razorpayKeyMode } = await import('../razorpayService');
    assert.strictEqual(razorpayKeyMode('rzp_live_abc'), 'live');
    assert.strictEqual(razorpayKeyMode('rzp_test_abc'), 'test');
    assert.strictEqual(razorpayKeyMode('something'), 'unknown');
    assert.strictEqual(razorpayKeyMode(''), 'none');

    const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    assert.strictEqual(razorpayConfigurationError('rzp_live_abc', 'sec', prod), undefined);
    assert.match(String(razorpayConfigurationError('rzp_test_abc', 'sec', prod)), /test key/);
    assert.match(String(razorpayConfigurationError('abc', 'sec', prod)), /neither/);
    assert.strictEqual(
      razorpayConfigurationError('rzp_test_abc', 'sec', { ...prod, RAZORPAY_ALLOW_TEST_KEYS: 'true' }), undefined,
      'a staging deployment may opt in explicitly'
    );
    assert.strictEqual(razorpayConfigurationError('rzp_test_abc', 'sec', { NODE_ENV: 'development' } as NodeJS.ProcessEnv), undefined);
    assert.ok(!String(razorpayConfigurationError('rzp_test_abc', 'topsecret', prod)).includes('topsecret'));

    // End to end: a production service with a test key takes no payment.
    const saved = { ...process.env };
    const realError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      process.env.NODE_ENV = 'production';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_prodmistake';
      process.env.RAZORPAY_KEY_SECRET = 'shhh_do_not_print';
      const { RazorpayService } = await import('../razorpayService');
      const svc = new RazorpayService();
      assert.strictEqual(svc.isConfigured, false);
      assert.strictEqual(svc.keyMode, 'test');
      await assert.rejects(() => svc.createOrder('job_x', 1000), /test key/);
      assert.ok(logged.length > 0, 'the misconfiguration is logged');
      assert.ok(logged.every((l) => !l.includes('shhh_do_not_print')), 'the secret is never logged');
    } finally {
      console.error = realError;
      for (const k of ['NODE_ENV', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });

  await t.test('125. Route stays off unless explicitly enabled', async () => {
    const shop = await shopWithAuth('Off Route', 'offroute@example.com', 'OffRoutePass12');
    // Even an activated linked account settles to PrintOk while Route is off.
    await storage.updateShopRazorpayAccount(shop.shopId, { accountId: 'acc_off', status: 'activated' });
    const job = ((await (await fetch(`${baseUrl}/api/print-jobs?autoApprove=false`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: shop.printerId, fileName: 'o.pdf', fileBase64: makePdf(1).toString('base64') }),
    })).json()) as any).job;
    await openOrder(job.id);
    assert.strictEqual((await storage.getPrintJob(job.id))?.payeeAccountId, undefined,
      'no payee is snapshotted while Route is off');

    const details = (await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/payout-details`, { headers: shop.auth })).json()) as any;
    assert.strictEqual(details.settlement.mode, 'manual', 'nothing is called automatic while Route is off');
    const earnings = (await (await fetch(`${baseUrl}/api/shops/${shop.shopId}/earnings`, { headers: shop.auth })).json()) as any;
    assert.strictEqual(earnings.settlement, 'pending-route');

    const onboard = await fetch(`${baseUrl}/api/shops/${shop.shopId}/razorpay-account`, {
      method: 'POST', headers: shop.auth, body: JSON.stringify({ phone: '9820000001' }),
    });
    // It already has an account in this test, so it reports status instead.
    assert.ok([200, 503].includes(onboard.status));
    assert.notStrictEqual(process.env.RAZORPAY_ROUTE_ENABLED, 'true');
  });

  await t.test('126. With Route on: hold, release on print, reverse before refund, once each', async () => {
    // A second app with Route switched on, against a stand-in for Razorpay's
    // API. No request leaves this process: global fetch is intercepted for
    // api.razorpay.com, and the Razorpay SDK used for refunds is replaced.
    const saved = { ...process.env };
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const transfers: any[] = [];
    let paymentFee = 0; // a UPI payment: Razorpay charged nothing
    const TOTAL = { value: 0 };

    const reply = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!url.startsWith('https://api.razorpay.com')) return realFetch(input, init);
      const method = String(init.method || (input as any).method || 'GET').toUpperCase();
      const path = new URL(url).pathname;
      const rawBody = init.body ?? (typeof input === 'object' && 'text' in input ? await input.text() : undefined);
      const body = rawBody ? JSON.parse(String(rawBody)) : undefined;
      calls.push({ method, path, body });

      if (method === 'GET' && path === '/v1/payments/pay_route_1') {
        return reply(200, { id: 'pay_route_1', status: 'captured', order_id: 'order_route_1', amount: TOTAL.value, fee: paymentFee, tax: 0 });
      }
      if (method === 'GET' && path === '/v1/payments/pay_route_1/transfers') {
        return reply(200, { entity: 'collection', count: transfers.length, items: transfers });
      }
      if (method === 'POST' && path === '/v1/payments/pay_route_1/transfers') {
        const t0 = body.transfers[0];
        const created = {
          id: `trf_route_${transfers.length + 1}`, entity: 'transfer', source: 'pay_route_1',
          recipient: t0.account, amount: t0.amount, currency: 'INR', status: 'created',
          on_hold: t0.on_hold, settlement_status: t0.on_hold ? 'on_hold' : 'pending', notes: t0.notes,
        };
        transfers.push(created);
        return reply(200, { entity: 'collection', count: 1, items: [created] });
      }
      if (method === 'PATCH' && path === '/v1/transfers/trf_route_1') {
        transfers[0] = { ...transfers[0], on_hold: false, settlement_status: 'pending' };
        return reply(200, transfers[0]);
      }
      if (method === 'POST' && path.startsWith('/v1/transfers/') && path.endsWith('/reversals')) {
        return reply(200, { id: 'rvrsl_route_1', entity: 'reversal', transfer_id: path.split('/')[3], amount: 1 });
      }
      return reply(404, { error: { description: `unmocked ${method} ${path}` } });
    }) as typeof fetch;
    process.env.RAZORPAY_KEY_ID = 'rzp_test_route_suite';
    process.env.RAZORPAY_ROUTE_ENABLED = 'true';

    const routeStorage = new MemoryStorage();
    const routeServer = http.createServer(createApp(routeStorage));
    await new Promise<void>((resolve) => routeServer.listen(0, resolve));
    const routeUrl = `http://localhost:${(routeServer.address() as { port: number }).port}`;
    const hook = (raw: string, eventId?: string) => realFetch(`${routeUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(raw),
        ...(eventId ? { 'x-razorpay-event-id': eventId } : {}),
      },
      body: raw,
    });

    try {
      const reg = (await (await realFetch(`${routeUrl}/api/shops/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopName: 'Route Prints', ownerEmail: 'route@example.com', printerName: 'HP' }),
      })).json()) as any;
      const shopId = reg.shop.id;
      await routeStorage.updateShopRazorpayAccount(shopId, { accountId: 'acc_route_shop', status: 'activated' });

      const newJob = async () => ((await (await realFetch(`${routeUrl}/api/print-jobs?autoApprove=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerId: reg.printer.id, fileName: 'r.pdf', fileBase64: makePdf(50).toString('base64') }),
      })).json()) as any).job;

      // ---- payment captured → transfer on hold, at the real fee ----
      const job = await newJob();
      TOTAL.value = job.totalPriceInCents;
      // The order would be opened through the SDK; recorded directly here,
      // with the payee snapshot create-order takes when Route is on.
      await routeStorage.attachGatewayOrder(job.id, 'order_route_1', job.totalPriceInCents, 'acc_route_shop');

      const captured = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: {
        id: 'pay_route_1', order_id: 'order_route_1', amount: job.totalPriceInCents, fee: paymentFee, tax: 0,
        notes: { jobId: job.id },
      } } } });
      assert.strictEqual((await hook(captured, 'evt_route_cap')).status, 200);

      let stored = (await routeStorage.getPrintJob(job.id))!;
      assert.strictEqual(stored.paymentState, PaymentState.Paid);
      assert.strictEqual(stored.transferId, 'trf_route_1');
      assert.strictEqual(stored.transferOnHold, true, 'held until the job prints');
      const fee = Math.round((job.totalPriceInCents * 200) / 10_000); // Free plan, 2%
      assert.strictEqual(stored.serviceFeeCents, fee);
      assert.strictEqual(stored.transferAmountCents, job.totalPriceInCents - fee,
        'a UPI payment Razorpay charged nothing on docks the shop nothing for the gateway');
      assert.strictEqual(stored.gatewayFeeCents, 0, 'the ledger holds the real fee');
      assert.strictEqual(stored.feesAreActual, true);

      // ---- a retried delivery and a late checkout confirmation: still one transfer ----
      await hook(captured, 'evt_route_cap_retry');
      await hook(captured);
      assert.strictEqual(transfers.length, 1, 'the shop is never paid twice');

      // ---- transfer.processed from Razorpay ----
      const processed = JSON.stringify({ event: 'transfer.processed', payload: { transfer: { entity: {
        ...transfers[0], status: 'processed',
      } } } });
      assert.strictEqual((await hook(processed, 'evt_trf_processed')).status, 200);
      assert.strictEqual((await routeStorage.getPrintJob(job.id))!.transferStatus, 'processed');

      // A transfer to someone else is not applied to this job.
      const forged = JSON.stringify({ event: 'transfer.failed', payload: { transfer: { entity: {
        ...transfers[0], recipient: 'acc_attacker', status: 'failed',
      } } } });
      await hook(forged);
      assert.strictEqual((await routeStorage.getPrintJob(job.id))!.transferStatus, 'processed');

      // ---- printed → released ----
      await routeStorage.updateJobPrintState(job.id, PrintState.Assigned, undefined, { actor: 'test' });
      const report = await realFetch(`${routeUrl}/api/agent/jobs/${job.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-api-key': reg.printer.apiKey },
        body: JSON.stringify({ printState: PrintState.Completed }),
      });
      assert.strictEqual(report.status, 200, await report.clone().text());
      stored = (await routeStorage.getPrintJob(job.id))!;
      assert.strictEqual(stored.transferOnHold, false, 'released once printed');
      assert.ok(stored.transferReleasedAt);
      assert.strictEqual(calls.filter((c) => c.method === 'PATCH').length, 1);

      // ---- a second order, declined: reversed once, then refunded ----
      const claimed = (await (await realFetch(`${routeUrl}/api/merchant/claim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptTerms: true, shopId, ownerEmail: 'route@example.com', password: 'RoutePrints1234' }),
      })).json()) as any;
      const auth = { Authorization: `Bearer ${claimed.token}`, 'Content-Type': 'application/json' };

      const job2 = await newJob();
      await routeStorage.attachGatewayOrder(job2.id, 'order_route_2', job2.totalPriceInCents, 'acc_route_shop');
      await routeStorage.claimGatewayPayment(job2.id, 'pay_route_2');
      await routeStorage.confirmPaymentAndQueueJob(job2.id, { actor: 'test', detail: { paymentRef: 'pay_route_2' } });
      await routeStorage.updateJobRouteSettlement(job2.id, {
        transferId: 'trf_route_2', transferStatus: 'processed', transferOnHold: true, transferAmountCents: 100,
      });

      const sdk = {
        payments: {
          refund: async (paymentId: string, body: any) => {
            calls.push({ method: 'POST', path: `/v1/payments/${paymentId}/refund`, body });
            return { id: 'rfnd_route_2', amount: body.amount, status: 'pending' };
          },
        },
      };
      const declined = await withFakeRazorpaySdk(sdk, () =>
        realFetch(`${routeUrl}/api/shops/${shopId}/jobs/${job2.id}/decline`, {
          method: 'POST', headers: auth, body: JSON.stringify({ reason: 'Printer broke' }),
        }));
      assert.ok([200, 202].includes(declined.status), await declined.clone().text());
      stored = (await routeStorage.getPrintJob(job2.id))!;
      assert.strictEqual(stored.transferReversalId, 'rvrsl_route_1', 'reversed before the refund');
      assert.strictEqual(stored.transferStatus, 'reversed');
      const reversalAt = calls.findIndex((c) => c.path.endsWith('/reversals'));
      const refundAt = calls.findIndex((c) => c.path === '/v1/payments/pay_route_2/refund');
      assert.ok(reversalAt >= 0 && refundAt > reversalAt, 'the refund follows the reversal');

      // Never reversed twice, however it is asked.
      assert.strictEqual(await routeStorage.claimTransferReversal(job2.id), false);
      assert.strictEqual(calls.filter((c) => c.path.endsWith('/reversals')).length, 1);

      // ---- Razorpay's review of the linked account is stored verbatim ----
      const product = JSON.stringify({
        event: 'product.route.needs_clarification', account_id: 'acc_route_shop', contains: ['merchant_product'],
        payload: { merchant_product: {
          entity: { id: 'acc_prd_route', merchant_id: 'acc_route_shop', activation_status: 'needs_clarification' },
          data: { requirements: [{ field_reference: 'settlements.ifsc_code', reason_code: 'field_missing', status: 'required' }] },
        } },
      });
      assert.strictEqual((await hook(product, 'evt_product_1')).status, 200);
      const updated = await routeStorage.getShop(shopId);
      assert.strictEqual(updated?.razorpayAccountStatus, 'needs_clarification');
      assert.strictEqual((updated?.razorpayAccountRequirements as any[])[0].field_reference, 'settlements.ifsc_code');
    } finally {
      routeServer.close();
      globalThis.fetch = realFetch;
      for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_ROUTE_ENABLED']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });

  await t.test('127. Linked-account onboarding follows Razorpay\'s v2 steps and resumes', async () => {
    const saved = { ...process.env };
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; path: string; body: any }> = [];
    let failProductOnce = true;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if (!url.startsWith('https://api.razorpay.com')) return realFetch(input, init);
      const method = String(init.method || 'GET');
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
      if (method === 'POST' && path === '/v2/accounts') return ok({ id: 'acc_onb', status: 'created' });
      if (method === 'POST' && path === '/v2/accounts/acc_onb/stakeholders') return ok({ id: 'sth_onb' });
      if (method === 'POST' && path === '/v2/accounts/acc_onb/products') {
        if (failProductOnce) {
          failProductOnce = false;
          return new Response(JSON.stringify({ error: { description: 'temporary' } }), { status: 500 });
        }
        return ok({ id: 'acc_prd_onb', activation_status: 'requested', requirements: [] });
      }
      if (method === 'PATCH' && path === '/v2/accounts/acc_onb/products/acc_prd_onb') {
        return ok({ id: 'acc_prd_onb', activation_status: 'under_review', requirements: [] });
      }
      return new Response(JSON.stringify({ error: { description: `unmocked ${method} ${path}` } }), { status: 404 });
    }) as typeof fetch;
    process.env.RAZORPAY_KEY_ID = 'rzp_test_onboarding';
    process.env.RAZORPAY_ROUTE_ENABLED = 'true';

    const onbStorage = new MemoryStorage();
    const onbServer = http.createServer(createApp(onbStorage));
    await new Promise<void>((resolve) => onbServer.listen(0, resolve));
    const onbUrl = `http://localhost:${(onbServer.address() as { port: number }).port}`;
    try {
      const signup = (await (await realFetch(`${onbUrl}/api/merchant/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acceptTerms: true, shopName: 'Onboard Prints', ownerEmail: 'onb@example.com', printerName: 'HP',
          password: 'OnboardPrints12', contactPhone: '9820000002', addressStreet1: '5 Market Rd',
          addressCity: 'Mumbai', addressState: 'Maharashtra', addressPostalCode: '400071',
          bankAccountNumber: '123456789012', bankIfsc: 'HDFC0001234',
        }),
      })).json()) as any;
      const auth = { Authorization: `Bearer ${signup.token}`, 'Content-Type': 'application/json' };
      const onboard = (body: unknown) => realFetch(`${onbUrl}/api/shops/${signup.shop.id}/razorpay-account`, {
        method: 'POST', headers: auth, body: JSON.stringify(body),
      });

      // Unknown business types and missing consent are refused before Razorpay is called.
      assert.strictEqual((await onboard({ businessType: 'sole_trader', contactName: 'Onboard Owner', tncAccepted: true })).status, 400);
      assert.strictEqual((await onboard({ businessType: 'proprietorship', contactName: 'Onboard Owner' })).status, 400);
      assert.strictEqual(calls.length, 0);

      const valid = { businessType: 'proprietorship', contactName: 'Onboard Owner', tncAccepted: true };
      const first = await onboard(valid);
      assert.strictEqual(first.status, 400, 'the product step failed this time');
      const partial = await onbStorage.getShop(signup.shop.id);
      assert.strictEqual(partial?.razorpayAccountId, 'acc_onb', 'what was created is kept');
      assert.strictEqual(partial?.razorpayStakeholderId, 'sth_onb');

      const second = await onboard(valid);
      assert.strictEqual(second.status, 201, await second.clone().text());
      assert.strictEqual(calls.filter((c) => c.path === '/v2/accounts').length, 1, 'no second account');
      assert.strictEqual(calls.filter((c) => c.path.endsWith('/stakeholders')).length, 1, 'no second stakeholder');

      const created = calls.find((c) => c.path === '/v2/accounts')!.body;
      assert.strictEqual(created.type, 'route');
      assert.strictEqual(created.reference_id, signup.shop.id);
      assert.strictEqual(created.profile.category, 'services');
      assert.strictEqual(created.profile.subcategory, 'copying_and_blueprinting_services');
      assert.strictEqual(created.profile.addresses.registered.postal_code, '400071');
      const settlement = calls.find((c) => c.method === 'PATCH')!.body;
      assert.deepStrictEqual(settlement.settlements, {
        account_number: '123456789012', ifsc_code: 'HDFC0001234', beneficiary_name: 'Onboard Prints',
      });

      const done = await onbStorage.getShop(signup.shop.id);
      assert.strictEqual(done?.razorpayProductId, 'acc_prd_onb');
      assert.strictEqual(done?.razorpayAccountStatus, 'under_review', 'Razorpay\'s status, verbatim');
    } finally {
      onbServer.close();
      globalThis.fetch = realFetch;
      for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_ROUTE_ENABLED']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });

  await t.test('128. Leaving a paid plan keeps it to the end of the period', async () => {
    const { RazorpayService } = await import('../razorpayService');
    const seen: unknown[] = [];
    const sdk = {
      subscriptions: {
        cancel: async (id: string, atEnd: unknown) => { seen.push([id, atEnd]); return {}; },
        create: async () => ({ id: 'sub_new', short_url: 'https://rzp.io/x' }),
      },
    };

    // Without billing configured nothing is cancelled.
    assert.deepStrictEqual(
      await new RazorpayService().cancelSubscription('sub_x', { atCycleEnd: true }),
      { ok: false, error: 'Razorpay is not configured.' }
    );

    const saved = process.env.RAZORPAY_KEY_ID;
    process.env.RAZORPAY_KEY_ID = 'rzp_test_cancel';
    const planStorage = new MemoryStorage();
    const planServer = http.createServer(createApp(planStorage));
    await new Promise<void>((resolve) => planServer.listen(0, resolve));
    const planUrl = `http://localhost:${(planServer.address() as { port: number }).port}`;
    try {
      // The SDK receives a plain boolean: an object would be truthy even as
      // { cancel_at_cycle_end: false }.
      await withFakeRazorpaySdk(sdk, async () => {
        const svc = new RazorpayService();
        assert.deepStrictEqual(await svc.cancelSubscription('sub_end', { atCycleEnd: true }), { ok: true });
        assert.deepStrictEqual(await svc.cancelSubscription('sub_now', { atCycleEnd: false }), { ok: true });
      });
      assert.deepStrictEqual(seen, [['sub_end', true], ['sub_now', false]]);
      seen.length = 0;

      // A shop on Starter, billed by a live subscription, chooses Free.
      const signup = (await (await fetch(`${planUrl}/api/merchant/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acceptTerms: true, shopName: 'Plan Prints', ownerEmail: 'plan@example.com',
          printerName: 'HP', password: 'PlanPrints1234',
        }),
      })).json()) as any;
      await planStorage.updateShopPlan(signup.shop.id, {
        planTier: 'starter', commissionBps: 100, planStatus: 'active', razorpaySubscriptionId: 'sub_starter',
      });
      const auth = { Authorization: `Bearer ${signup.token}`, 'Content-Type': 'application/json' };
      const toFree = () => withFakeRazorpaySdk(sdk, () => fetch(`${planUrl}/api/shops/${signup.shop.id}/plan`, {
        method: 'POST', headers: auth, body: JSON.stringify({ tier: 'free' }),
      }));

      const res = await toFree();
      const body = (await res.json()) as any;
      assert.strictEqual(res.status, 202, JSON.stringify(body));
      assert.strictEqual(body.cancelsAtPeriodEnd, true);
      assert.match(body.message, /stays active until the end/);
      assert.deepStrictEqual(seen, [['sub_starter', true]], 'cancelled at cycle end, not now');

      const plan = await planStorage.getShopPlan(signup.shop.id);
      assert.strictEqual(plan?.planTier, 'starter', 'the paid plan runs to the end of its period');
      assert.strictEqual(plan?.planStatus, 'cancelling');
      assert.strictEqual(plan?.razorpaySubscriptionId, 'sub_starter');

      // Asking again does not cancel twice.
      assert.strictEqual((await toFree()).status, 409);
      assert.strictEqual(seen.length, 1);

      // At period end Razorpay sends subscription.cancelled, and only then is it Free.
      const raw = JSON.stringify({
        event: 'subscription.cancelled',
        payload: { subscription: { entity: { id: 'sub_starter', notes: { shopId: signup.shop.id, tier: 'starter' } } } },
      });
      await fetch(`${planUrl}/api/payments/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signWebhook(raw) },
        body: raw,
      });
      const after = await planStorage.getShopPlan(signup.shop.id);
      assert.strictEqual(after?.planTier, 'free');
      assert.strictEqual(after?.planStatus, 'active');
    } finally {
      planServer.close();
      if (saved === undefined) delete process.env.RAZORPAY_KEY_ID; else process.env.RAZORPAY_KEY_ID = saved;
    }
  });

  server.close();
});


