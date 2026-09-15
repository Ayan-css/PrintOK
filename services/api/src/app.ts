import crypto from 'crypto';
import express, { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { IStorageProvider, MemoryStorage } from './storage';
import { generateQrCodeDataUrl } from './qr';
import { AgentWebSocketServer } from './ws';
import { processDocument } from './documentProcessor';
import { RazorpayService, MIN_ORDER_AMOUNT_PAISE } from './razorpayService';
import { RazorpayRouteService } from './razorpayRoute';
import { parsePrintState } from './jobStateMachine';
import { classifyFailure } from './jobRecovery';
import { buildDefaultRateCard } from './pricing';
import { corsOptions } from './corsPolicy';
import {
  issueConfigDownloadToken,
  verifyConfigDownloadToken,
  CONFIG_DOWNLOAD_TTL_MS,
  CONFIG_DOWNLOAD_SCOPE,
} from './configDownloadToken';
import {
  PLAN_CATALOGUE, PLAN_TIERS, getPlan,
  PAYMENT_GATEWAY_FEE_BPS, PAYMENT_GATEWAY_LABEL, calculateShopNetCents,
  Printer, ShopPortalConfig, CUSTOMER_NAME_MAX, CUSTOMER_PHONE_MAX,
  ShopRate, ShopRateCard,
  SERVICE_CATALOGUE, SERVICE_GROUPS, defaultEnabledServices, resolveEnabledServices,
  derivePortalOptions, checkJobAgainstPortal,
  AUTO_PRINT_MODES, SEPARATOR_MODES, shouldPrintSeparator,
  bucketForState, countJobBuckets, jobMatchesSearch,
} from '@printok/shared-types';
import {
  hashPassword, verifyPassword, validatePasswordStrength,
  issueAdminToken, verifyAdminToken, canWrite, AdminTokenPayload,
} from './adminAuth';
import {
  generatePairingCode, normalizePairingCode, hashDeviceToken, issueDeviceToken,
  PAIRING_CODE_TTL_MS, AgentIdentity,
} from './agentAuth';
import {
  RegisterShopDto,
  RegisterShopResponse,
  CreatePrintJobDto,
  CreatePrintJobResponse,
  AgentPollResponse,
  AgentUpdateStatusDto,
  PaymentWebhookDto,
  PrintState,
  PaymentState,
} from '@printok/shared-types';

/** Process start time, so /health shows how long this instance has been up. */
const BOOT_TIME = new Date().toISOString();

/**
 * Resolves the calling agent (PRD 7.2).
 *
 * Prefers a device-scoped token, which identifies one machine and can be
 * revoked on its own. Falls back to the printer's shared API key so that agents
 * installed before pairing existed keep working; each such call is recorded as
 * a security event so the migration is observable.
 *
 * Responds and returns null on failure, so callers can `if (!identity) return;`.
 */
async function authenticateAgent(
  storage: IStorageProvider,
  req: Request,
  res: Response
): Promise<AgentIdentity | null> {
  const deviceToken = req.headers['x-agent-device-token'] as string | undefined;

  if (deviceToken) {
    const device = await storage.getActiveDeviceByTokenHash(hashDeviceToken(deviceToken));
    if (!device) {
      await storage.recordSecurityEvent({
        type: 'AUTH_REJECTED',
        severity: 'warning',
        detail: { reason: 'Unknown, expired or revoked device token.' },
      });
      res.status(401).json({ error: 'Unauthorized: device token is not valid. Re-pair this agent.' });
      return null;
    }

    const printer = await storage.getPrinter(device.printerId);
    if (!printer) {
      res.status(401).json({ error: 'Unauthorized: device is not bound to a live printer.' });
      return null;
    }

    await storage.touchAgentDevice(device.id, req.headers['x-agent-version'] as string | undefined);
    return { printerId: printer.id, shopId: printer.shopId, deviceId: device.id, method: 'device-token' };
  }

  const apiKey = req.headers['x-agent-api-key'] as string | undefined;
  if (!apiKey) {
    res.status(401).json({ error: 'Unauthorized: missing x-agent-device-token or x-agent-api-key header.' });
    return null;
  }

  const printer = await storage.getPrinterByApiKey(apiKey);
  if (!printer) {
    await storage.recordSecurityEvent({
      type: 'AUTH_REJECTED',
      severity: 'warning',
      detail: { reason: 'Invalid printer API key.' },
    });
    res.status(401).json({ error: 'Unauthorized: Invalid Agent API Key.' });
    return null;
  }

  // Shared-key auth is deprecated: it cannot identify or revoke one machine.
  await storage.recordSecurityEvent({
    printerId: printer.id,
    type: 'LEGACY_KEY_USED',
    severity: 'info',
    detail: { path: req.path },
  });

  return { printerId: printer.id, shopId: printer.shopId, method: 'legacy-printer-key' };
}

export function createApp(
  storage: IStorageProvider = new MemoryStorage(),
  wsServer?: AgentWebSocketServer
) {
  const app = express();
  const razorpayService = new RazorpayService();
  const routeService = new RazorpayRouteService();

  // An allowlist, not a wildcard. Requests with no Origin (the print agent,
  // Razorpay webhooks, health checks) are unaffected — see corsPolicy.ts.
  app.use(cors(corsOptions()));
  app.use(express.json({
    limit: '50mb',
    // Webhook signatures are computed over the exact bytes received; a
    // re-serialised object produces different bytes and never verifies.
    verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8'); },
  }));

  // Render terminates TLS at its own proxy and forwards the caller's address in
  // X-Forwarded-For. Without this Express reports the proxy's address as req.ip,
  // so every visitor shares one rate-limit bucket: 60 print jobs a minute for
  // the whole platform, and five contact enquiries an hour for the entire
  // internet. express-rate-limit detects the mismatch and logs
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, which is what production was doing.
  //
  // Exactly one hop, never `true`: trusting the whole chain lets a caller add
  // their own X-Forwarded-For and present a fresh address on every request,
  // which would leave the limiter trivially bypassable.
  app.set('trust proxy', 1);

  // Security: Public API Rate Limiter (Max 60 requests per minute per IP)
  //
  // The ceiling is configurable because the test suite drives hundreds of job
  // creations from one address in seconds and would otherwise start failing on
  // request count rather than on behaviour — which surfaces as an unrelated
  // test breaking, several steps away from whatever added the requests.
  //
  // It is a ceiling, never a switch: an unset or unparseable value keeps the
  // production default rather than disabling the limiter.
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number.parseInt(process.env.API_RATE_LIMIT_PER_MINUTE || '', 10) || 60,
    message: { error: 'Too many requests from this IP, please try again after a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api/print-jobs', apiLimiter);
  app.use('/api/shops/register', apiLimiter);

  // The contact form is unauthenticated and world-reachable, so it gets a much
  // tighter budget than the rest of the public API.
  const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many enquiries from this network. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/contact', contactLimiter);

  // Health Check Endpoint.
  // Reports the running build so a deploy can actually be verified from outside;
  // a static 200 cannot distinguish a new release from the previous one.
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'PrintOk API',
      version: process.env.npm_package_version || 'unknown',
      // Render exposes the deployed commit; other hosts may not.
      commit: (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown').slice(0, 7),
      startedAt: BOOT_TIME,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Resolves the signed-in merchant and confirms they may act on :shopId.
   *
   * Every shop endpoint was previously unauthenticated, so anyone who knew a
   * shop id could read its revenue and payout details, change its prices or
   * trigger a withdrawal. This is the gate that closes that.
   *
   * Responds and returns null on failure, so callers can `if (!m) return;`.
   */
  async function authenticateMerchant(
    req: Request,
    res: Response,
    options: { shopId?: string; requireOwner?: boolean } = {}
  ): Promise<AdminTokenPayload | null> {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) {
      res.status(401).json({ error: 'Sign in to your shop dashboard.' });
      return null;
    }

    const payload = verifyAdminToken(token, 'merchant');
    if (!payload) {
      res.status(401).json({ error: 'Session expired or invalid. Sign in again.' });
      return null;
    }

    const user = await storage.getMerchantUser(payload.sub);
    if (!user || user.status !== 'active') {
      res.status(401).json({ error: 'This account is no longer active.' });
      return null;
    }

    // A valid token for one shop must never act on another.
    const target = options.shopId ?? req.params.shopId;
    if (target && user.shopId !== target) {
      res.status(403).json({ error: 'This account does not have access to that shop.' });
      return null;
    }

    if (options.requireOwner && user.role !== 'owner') {
      res.status(403).json({ error: 'Only the shop owner can do that.' });
      return null;
    }

    return { ...payload, shopId: user.shopId };
  }

  /**
   * Authorises a merchant to act on one specific printer.
   *
   * Printer ids are public by design — they are encoded in the QR poster and
   * appear in the customer URL as ?printer=<id> — so every printer-scoped
   * management route needs an ownership check, not merely a signed-in caller.
   * Without this, knowing an id was authority over it: anyone could mint a
   * pairing code for a shop they had never visited, revoke its agent, or
   * regenerate the QR on its printed poster.
   *
   * A printer belonging to another shop answers 404, not 403, so this cannot be
   * used to confirm that a guessed printer id exists.
   *
   * Responds and returns null on failure, so callers can `if (!ctx) return;`.
   */
  async function authorizePrinter(
    req: Request,
    res: Response,
    options: { requireOwner?: boolean } = {}
  ): Promise<{ merchant: AdminTokenPayload; printer: Printer } | null> {
    const merchant = await authenticateMerchant(req, res, {
      shopId: undefined,
      requireOwner: options.requireOwner,
    });
    if (!merchant) return null;

    const printer = await storage.getPrinter(req.params.printerId);
    if (!printer || printer.shopId !== merchant.shopId) {
      res.status(404).json({ error: 'Printer not found.' });
      return null;
    }

    return { merchant, printer };
  }

  /**
   * Decides what customer identity, if any, is stored with a job.
   *
   * The shop's configuration is the authority, never the request. A caller who
   * posts a name to a shop that does not collect names gets it dropped rather
   * than stored: that shop's customers were told nothing of the sort is kept,
   * and an API that quietly honours the field would make the notice false.
   *
   * Returns the values to store, or the message to refuse with.
   */
  function readCustomerIdentity(
    portal: ShopPortalConfig,
    submitted: { customerName?: unknown; customerPhone?: unknown }
  ): { value: { customerName?: string; customerPhone?: string } } | { error: string } {
    const clean = (raw: unknown, max: number): string | undefined => {
      if (raw === undefined || raw === null) return undefined;
      // Collapse runs of whitespace so a name pasted across two lines stores flat.
      const text = String(raw).replace(/\s+/g, ' ').trim();
      return text ? text.slice(0, max) : undefined;
    };

    const name = portal.collectCustomerName ? clean(submitted.customerName, CUSTOMER_NAME_MAX) : undefined;
    const phone = portal.collectCustomerPhone ? clean(submitted.customerPhone, CUSTOMER_PHONE_MAX) : undefined;

    if (portal.collectCustomerName && portal.customerNameRequired && !name) {
      return { error: 'This shop needs your name for the order.' };
    }
    if (portal.collectCustomerPhone && portal.customerPhoneRequired && !phone) {
      return { error: 'This shop needs your mobile number for the order.' };
    }

    // Deliberately permissive: enough to reject an obvious mistake, not enough
    // to argue with a customer about the shape of their own phone number.
    if (phone && !/^[0-9+][0-9 ()+-]{5,}$/.test(phone)) {
      return { error: 'That mobile number does not look right.' };
    }

    return { value: { customerName: name, customerPhone: phone } };
  }

  /**
   * Merchant signup: creates the shop, its first printer and the owner account
   * in one step, so a shop is never left without anyone able to sign in to it.
   */
  /**
   * Contact and registered address from a signup body.
   *
   * Razorpay refuses to create a Route linked account without a phone number
   * and stalls KYC on an incomplete address, so these are collected up front
   * rather than chased later when a shop is trying to get paid.
   */
  function readShopContact(body: any) {
    const trim = (v: unknown) => (v === undefined || v === null ? undefined : String(v).trim() || undefined);
    return {
      contactPhone: trim(body?.contactPhone ?? body?.phone),
      addressStreet1: trim(body?.addressStreet1),
      addressStreet2: trim(body?.addressStreet2),
      addressCity: trim(body?.addressCity),
      addressState: trim(body?.addressState),
      addressPostalCode: trim(body?.addressPostalCode),
      addressCountry: trim(body?.addressCountry) || 'IN',
    };
  }

  app.post('/api/merchant/signup', async (req: Request, res: Response) => {
    try {
      const { shopName, ownerEmail, printerName, password, name, phone,
              upiId, bankAccountNumber, bankIfsc } = req.body || {};

      if (!shopName || !ownerEmail || !printerName || !password) {
        return res.status(400).json({
          error: 'shopName, ownerEmail, printerName and password are required.',
        });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      const existing = await storage.getMerchantByEmail(String(ownerEmail));
      if (existing) {
        return res.status(409).json({ error: 'An account already exists for that email. Sign in instead.' });
      }

      const configuredWebUrl = process.env.PUBLIC_WEB_URL;
      if (!configuredWebUrl && process.env.NODE_ENV === 'production') {
        return res.status(500).json({
          error: 'PUBLIC_WEB_URL is not configured. Refusing to register a shop whose QR code could never be scanned.',
        });
      }
      const baseUrl = (configuredWebUrl || 'http://localhost:3000').replace(/\/$/, '');

      const shop = await storage.createShop(
        shopName, ownerEmail, upiId, bankAccountNumber, bankIfsc, readShopContact(req.body)
      );
      const printer = await storage.createPrinter(shop.id, printerName, baseUrl, undefined, generateQrCodeDataUrl);

      const merchant = await storage.createMerchantUser({
        shopId: shop.id,
        email: String(ownerEmail),
        passwordHash: hashPassword(String(password)),
        name,
        phone,
        role: 'owner',
      });

      return res.status(201).json({
        shop,
        printer,
        user: merchant,
        token: issueAdminToken(
          { id: merchant.id, email: merchant.email, role: merchant.role, shopId: shop.id },
          undefined,
          'merchant'
        ),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/merchant/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required.' });
      }

      const user = await storage.getMerchantByEmail(String(email));
      // One message whichever part failed, so this cannot enumerate accounts.
      const ok = user && user.status === 'active' && verifyPassword(String(password), user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }

      await storage.recordMerchantLogin(user!.id);
      const { passwordHash, ...safe } = user!;

      return res.json({
        user: safe,
        shop: await storage.getShop(safe.shopId),
        token: issueAdminToken(
          { id: safe.id, email: safe.email, role: safe.role, shopId: safe.shopId },
          undefined,
          'merchant'
        ),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/merchant/me', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { shopId: undefined });
    if (!merchant) return;

    const user = await storage.getMerchantUser(merchant.sub);
    if (!user) return res.status(401).json({ error: 'Account not found.' });

    const [shop, printers] = await Promise.all([
      storage.getShop(user.shopId),
      storage.listPrintersForShop(user.shopId),
    ]);

    return res.json({ user, shop, printers });
  });

  /**
   * Claim an existing shop that predates merchant accounts.
   *
   * Open only while the shop has no account, in the same way the admin console
   * bootstrap is. Requires the owner email already on the shop record.
   */
  app.post('/api/merchant/claim', async (req: Request, res: Response) => {
    try {
      const { shopId, ownerEmail, password, name } = req.body || {};
      if (!shopId || !ownerEmail || !password) {
        return res.status(400).json({ error: 'shopId, ownerEmail and password are required.' });
      }

      const shop = await storage.getShop(String(shopId));
      // Same response whether the shop is missing or the email is wrong, so
      // this cannot be used to discover shop ids or owner addresses.
      const emailMatches =
        shop && shop.ownerEmail.trim().toLowerCase() === String(ownerEmail).trim().toLowerCase();
      if (!emailMatches) {
        return res.status(401).json({ error: 'That shop and email do not match our records.' });
      }

      if ((await storage.countMerchantsForShop(shop!.id)) > 0) {
        return res.status(409).json({ error: 'This shop already has an account. Sign in instead.' });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      const merchant = await storage.createMerchantUser({
        shopId: shop!.id,
        email: String(ownerEmail),
        passwordHash: hashPassword(String(password)),
        name,
        role: 'owner',
      });

      return res.status(201).json({
        user: merchant,
        shop,
        token: issueAdminToken(
          { id: merchant.id, email: merchant.email, role: merchant.role, shopId: shop!.id },
          undefined,
          'merchant'
        ),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Shop & Printer Registration Endpoint
   */
  app.post('/api/shops/register', async (req: Request, res: Response) => {
    try {
      const { shopName, ownerEmail, printerName, upiId, bankAccountNumber, bankIfsc } = req.body as RegisterShopDto;

      if (!shopName || !ownerEmail || !printerName) {
        return res.status(400).json({ error: 'shopName, ownerEmail, and printerName are required.' });
      }

      const shop = await storage.createShop(
        shopName, ownerEmail, upiId, bankAccountNumber, bankIfsc, readShopContact(req.body)
      );
      
      // PUBLIC_WEB_URL must be set to the Vercel frontend URL in Render env vars (e.g. https://printok.vercel.app)
      // A QR poster is printed and physically mounted in a shop. Emitting a
      // localhost URL produces a poster that can never work, and nothing about
      // the successful response would reveal it, so refuse instead of guessing.
      const configuredWebUrl = process.env.PUBLIC_WEB_URL;
      if (!configuredWebUrl && process.env.NODE_ENV === 'production') {
        return res.status(500).json({
          error:
            'PUBLIC_WEB_URL is not configured. Refusing to register a shop, because its QR code ' +
            'would point at localhost and could never be scanned by a customer.',
        });
      }
      const baseUrl = (configuredWebUrl || 'http://localhost:3000').replace(/\/$/, '');

      // Pass baseUrl + QR generator so createPrinter builds the correct URL after the ID is known
      const printer = await storage.createPrinter(
        shop.id,
        printerName,
        baseUrl,
        undefined,
        generateQrCodeDataUrl
      );

      const response: RegisterShopResponse = { shop, printer };
      return res.status(201).json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  });

  /**
   * Get Shop Pricing Config
   */
  app.get('/api/shops/:shopId/pricing', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const pricing = await storage.getShopPricing(shopId);
      return res.json({ pricing });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Update Shop Pricing Config
   */
  app.post('/api/shops/:shopId/pricing', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const updatedPricing = await storage.updateShopPricing(shopId, req.body || {});

      // Write through to the grid, which is what jobs are actually priced from.
      //
      // Without this, a merchant editing the four flat rates would change a row
      // nothing reads and see no effect on what customers are charged — the
      // same silent no-op this endpoint already had once, when pricing came
      // from hardcoded constants instead of the shop's card.
      //
      // Only the base rate of each cell is rewritten. Per-configuration
      // discounts and the enabled flags are the grid editor's to own, and a
      // merchant setting a flat rate has not asked to discard them.
      const derived = buildDefaultRateCard(updatedPricing);
      await storage.updateShopRateCard(shopId, {
        rates: derived.rates.map((r) => ({
          paperSize: r.paperSize,
          isColor: r.isColor,
          isDuplex: r.isDuplex,
          perPageCents: r.perPageCents,
        })) as ShopRate[],
      });

      return res.json({ pricing: updatedPricing });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Shop Performance Stats & Analytics
   */
  /**
   * The shop's rate grid: one rate per paper size, colour mode and sided-ness,
   * plus the two discount switches.
   *
   * Public, because the customer page quotes a price before anyone signs in.
   * It carries rates and nothing else — no shop, owner or payout detail.
   */
  app.get('/api/shops/:shopId/rates', async (req: Request, res: Response) => {
    try {
      return res.json(await storage.getShopRateCard(req.params.shopId));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/rates', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const body = req.body || {};
      const update: Partial<ShopRateCard> = {};

      if (Array.isArray(body.rates)) {
        const cleaned: ShopRate[] = [];
        for (const raw of body.rates) {
          if (!raw || typeof raw.paperSize !== 'string') continue;

          // A rate is money. Reject anything that is not a whole, non-negative
          // number of paise rather than coercing it into one — a NaN that
          // becomes 0 is a shop giving printing away.
          const money = (v: unknown, field: string): number | null | undefined => {
            if (v === null || v === undefined || v === '') return null;
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
              throw new Error(`${field} must be a whole number of paise, or blank.`);
            }
            return n;
          };

          const perPage = money(raw.perPageCents, 'perPageCents');
          if (perPage === null || perPage === undefined) {
            throw new Error('Every configuration needs a per-page rate.');
          }

          cleaned.push({
            paperSize: String(raw.paperSize),
            isColor: !!raw.isColor,
            isDuplex: !!raw.isDuplex,
            perPageCents: perPage,
            bulkPerPageCents: money(raw.bulkPerPageCents, 'bulkPerPageCents'),
            additionalCopyPerPageCents: money(raw.additionalCopyPerPageCents, 'additionalCopyPerPageCents'),
            enabled: raw.enabled === undefined ? true : !!raw.enabled,
          });
        }
        update.rates = cleaned;
      }

      if (typeof body.bulkEnabled === 'boolean') update.bulkEnabled = body.bulkEnabled;
      if (typeof body.additionalCopyEnabled === 'boolean') update.additionalCopyEnabled = body.additionalCopyEnabled;

      if (body.bulkThresholdCents !== undefined) {
        const t = Number(body.bulkThresholdCents);
        if (!Number.isInteger(t) || t < 1) {
          return res.status(400).json({ error: 'The discount threshold must be a whole number of paise, at least 1.' });
        }
        update.bulkThresholdCents = t;
      }

      return res.json(await storage.updateShopRateCard(req.params.shopId, update));
    } catch (err: any) {
      // Validation failures above are the merchant's to fix, not a server fault.
      return res.status(400).json({ error: err.message });
    }
  });

  /**
   * What this shop's portal asks a customer for.
   *
   * Public, because the customer page must render the right fields before
   * anyone has signed in. It exposes only booleans — no shop detail.
   */
  /**
   * The capability catalogue itself: what a shop may offer, and what it starts
   * with. Static, so the setup screen renders before any shop is loaded.
   */
  app.get('/api/service-catalogue', (_req: Request, res: Response) => {
    return res.json({
      capabilities: SERVICE_CATALOGUE,
      groups: SERVICE_GROUPS,
      defaults: defaultEnabledServices(),
    });
  });

  /**
   * What a customer may choose at this shop, already resolved.
   *
   * The customer page could derive this itself from the services and the rate
   * grid, but then two implementations would have to agree forever. One answer,
   * computed where the refusal is also computed.
   */
  app.get('/api/shops/:shopId/portal-options', async (req: Request, res: Response) => {
    try {
      const [config, card] = await Promise.all([
        storage.getShopPortalConfig(req.params.shopId),
        storage.getShopRateCard(req.params.shopId),
      ]);
      return res.json(derivePortalOptions(config.enabledServices, card));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------------------
  // Shop profile and staff (PRD 20)
  // ------------------------------------------------------------------------

  /** The shop's own details, for the profile screen. */
  app.get('/api/shops/:shopId/profile', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const shop = await storage.getShop(req.params.shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      // Deliberately not the payout details. Those belong to the money screen
      // and there is no reason for a profile form to carry a bank account.
      return res.json({
        profile: {
          name: shop.name,
          ownerEmail: shop.ownerEmail,
          contactPhone: shop.contactPhone ?? '',
          addressStreet1: shop.addressStreet1 ?? '',
          addressStreet2: shop.addressStreet2 ?? '',
          addressCity: shop.addressCity ?? '',
          addressState: shop.addressState ?? '',
          addressPostalCode: shop.addressPostalCode ?? '',
          addressCountry: shop.addressCountry ?? 'IN',
          gstin: shop.gstin ?? '',
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/profile', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const body = req.body || {};
      const text = (v: unknown, max: number) =>
        v === undefined ? undefined : String(v).replace(/\s+/g, ' ').trim().slice(0, max);

      const name = text(body.name, 120);
      if (name !== undefined && name === '') {
        return res.status(400).json({ error: 'A shop needs a name.' });
      }

      // Shape-checked, not checksummed. A GSTIN is 15 characters: two state
      // digits, a ten-character PAN, an entity digit, a Z, and a check
      // character. Refusing a legitimate number because a checksum
      // implementation disagrees is worse than storing what the owner read off
      // their certificate, so this rejects only what is plainly not one.
      const gstin = text(body.gstin, 20)?.toUpperCase();
      if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(gstin)) {
        return res.status(400).json({
          error: 'That does not look like a GSTIN. It is 15 characters, e.g. 27ABCDE1234F1Z5.',
        });
      }

      const updated = await storage.updateShopProfile(req.params.shopId, {
        name,
        contactPhone: text(body.contactPhone, 20),
        addressStreet1: text(body.addressStreet1, 160),
        addressStreet2: text(body.addressStreet2, 160),
        addressCity: text(body.addressCity, 80),
        addressState: text(body.addressState, 80),
        addressPostalCode: text(body.addressPostalCode, 12),
        addressCountry: text(body.addressCountry, 2)?.toUpperCase(),
        gstin,
      });

      if (!updated) return res.status(404).json({ error: 'Shop not found.' });
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Changes the signed-in user's own password.
   *
   * Requires the current one. Without that, anyone who finds an unlocked
   * counter PC with the dashboard open can lock the owner out of their own
   * shop — and a print shop's PC is not a private device.
   */
  app.post('/api/merchant/password', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { shopId: undefined });
    if (!merchant) return;

    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Enter your current password and the new one.' });
      }

      const weak = validatePasswordStrength(String(newPassword));
      if (weak) return res.status(400).json({ error: weak });

      const user = await storage.getMerchantUser(merchant.sub);
      if (!user) return res.status(401).json({ error: 'This account no longer exists.' });

      const stored = await storage.getMerchantByEmail(user.email);
      if (!stored || !verifyPassword(String(currentPassword), stored.passwordHash)) {
        return res.status(403).json({ error: 'That is not your current password.' });
      }

      // Checked, not assumed. A password change that quietly does nothing
      // leaves someone believing they have rotated a credential they have not.
      const changed = await storage.updateMerchantPassword(merchant.sub, hashPassword(String(newPassword)));
      if (!changed) {
        return res.status(500).json({ error: 'The password could not be changed. Try again.' });
      }

      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Everyone who can sign in to this shop. */
  app.get('/api/shops/:shopId/staff', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      return res.json({ staff: await storage.listMerchantUsers(req.params.shopId) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Adds a staff account.
   *
   * Staff only, never another owner. The owner is whoever claimed the shop, and
   * letting that be handed out from this screen would mean a staff member could
   * be promoted to someone who can change prices and move money.
   */
  app.post('/api/shops/:shopId/staff', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { email, name, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'An email address and a password are required.' });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      const cleanEmail = String(email).trim().toLowerCase();
      if (await storage.getMerchantByEmail(cleanEmail)) {
        return res.status(409).json({ error: 'Someone already signs in with that email address.' });
      }

      const user = await storage.createMerchantUser({
        shopId: req.params.shopId,
        email: cleanEmail,
        passwordHash: hashPassword(String(password)),
        name: name ? String(name).trim().slice(0, 80) : undefined,
        role: 'staff',
      });

      return res.status(201).json({ user });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Disables or re-enables a staff account. */
  app.post('/api/shops/:shopId/staff/:userId/status', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId, userId } = req.params;
      const status = req.body?.status === 'active' ? 'active' : 'disabled';

      // Locking yourself out of your own shop is not a thing anyone means to
      // do, and there is nobody above the owner to undo it.
      if (userId === merchant.sub) {
        return res.status(409).json({ error: 'You cannot disable your own account.' });
      }

      const target = await storage.getMerchantUser(userId);
      if (!target || target.shopId !== shopId) {
        return res.status(404).json({ error: 'That person does not work at this shop.' });
      }

      if (target.role === 'owner') {
        return res.status(409).json({ error: 'The shop owner cannot be disabled.' });
      }

      const updated = await storage.updateMerchantUser(userId, { status });
      if (!updated) {
        return res.status(500).json({ error: 'That account could not be updated. Try again.' });
      }

      return res.json({ user: updated });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/shops/:shopId/portal-config', async (req: Request, res: Response) => {
    try {
      const config = await storage.getShopPortalConfig(req.params.shopId);
      // Resolved here rather than in storage, so "never configured" and
      // "offers nothing" stay distinguishable in the database.
      return res.json({ ...config, enabledServices: resolveEnabledServices(config.enabledServices) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/portal-config', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const body = req.body || {};
      const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

      const next: Partial<ShopPortalConfig> = {};
      if (bool(body.collectCustomerName) !== undefined) next.collectCustomerName = body.collectCustomerName;
      if (bool(body.customerNameRequired) !== undefined) next.customerNameRequired = body.customerNameRequired;
      if (bool(body.collectCustomerPhone) !== undefined) next.collectCustomerPhone = body.collectCustomerPhone;
      if (bool(body.customerPhoneRequired) !== undefined) next.customerPhoneRequired = body.customerPhoneRequired;

      if (typeof body.autoPrintMode === 'string' && AUTO_PRINT_MODES.includes(body.autoPrintMode)) {
        next.autoPrintMode = body.autoPrintMode;
      }
      if (typeof body.separatorMode === 'string' && SEPARATOR_MODES.includes(body.separatorMode)) {
        next.separatorMode = body.separatorMode;
      }
      if (body.separatorMinQueue !== undefined) {
        const n = Number(body.separatorMinQueue);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'The backlog size must be a whole number, at least 1.' });
        }
        next.separatorMinQueue = n;
      }

      if (Array.isArray(body.enabledServices)) {
        // Filtered against the catalogue rather than stored as sent, so a stale
        // or invented key cannot reach the portal. Order is the shop's and is
        // preserved; duplicates are collapsed.
        const known = new Set(SERVICE_CATALOGUE.map((c) => c.key));
        const seen = new Set<string>();
        next.enabledServices = body.enabledServices
          .filter((k: unknown): k is string => typeof k === 'string')
          .filter((k: string) => known.has(k) && !seen.has(k) && (seen.add(k), true));
      }

      // Required without collected is unsatisfiable: the portal would never
      // show the field, and every order would then be refused for missing it.
      const merged = { ...(await storage.getShopPortalConfig(req.params.shopId)), ...next };
      if (merged.customerNameRequired && !merged.collectCustomerName) next.customerNameRequired = false;
      if (merged.customerPhoneRequired && !merged.collectCustomerPhone) next.customerPhoneRequired = false;

      return res.json(await storage.updateShopPortalConfig(req.params.shopId, next));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/shops/:shopId/stats', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const stats = await storage.getShopStats(shopId);
      return res.json({ stats });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Recent Jobs for Shop Owner Dashboard
   */
  app.get('/api/shops/:shopId/jobs', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const limit = Math.min(Number(req.query.limit) || 50, 500);

      // Fetched wide, then filtered here, so the counts describe the shop's
      // whole recent history rather than whichever page happened to load. A tab
      // reading "Rejected 0" because the rejections fell off the end of the
      // page is worse than no count at all.
      const all = await storage.getRecentJobsForShop(shopId, 500);

      const bucket = typeof req.query.status === 'string' ? req.query.status : 'all';
      const search = typeof req.query.q === 'string' ? req.query.q : '';
      const month = typeof req.query.month === 'string' ? req.query.month : '';

      let jobs = all;

      // YYYY-MM, matched on the string rather than by parsing dates: the
      // timestamps are ISO and already in that order, and a Date round-trip
      // would quietly shift a job either side of midnight into another month.
      if (/^\d{4}-\d{2}$/.test(month)) {
        jobs = jobs.filter((j) => String(j.createdAt).startsWith(month));
      }

      if (bucket !== 'all') {
        jobs = jobs.filter((j) => bucketForState(j.printState) === bucket);
      }

      if (search) {
        jobs = jobs.filter((j) => jobMatchesSearch(j, search));
      }

      return res.json({
        jobs: jobs.slice(0, limit),
        // Counted after the month filter but before status and search, so the
        // tabs say how many are in each bucket *right now* rather than how many
        // survived the box the merchant is currently typing in.
        counts: countJobBuckets(
          /^\d{4}-\d{2}$/.test(month)
            ? all.filter((j) => String(j.createdAt).startsWith(month))
            : all
        ),
        total: jobs.length,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Printer & Shop Info by Printer ID
   */
  app.get('/api/printers/:printerId', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const printer = await storage.getPrinter(printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Printer not found.' });
      }
      const shop = await storage.getShop(printer.shopId);
      const telemetry = await storage.getPrinterTelemetry(printerId);

      // This endpoint is necessarily public: the printer id is printed on the
      // QR poster and the customer page needs the shop name and status. It must
      // therefore expose nothing an attacker could use.
      //
      // It previously returned the printer's agent API key, which authenticates
      // the print agent — so anyone who scanned a poster could poll that shop's
      // queue, claim its jobs and report false statuses. It also returned the
      // owner's email address.
      return res.json({
        printer: {
          id: printer.id,
          shopId: printer.shopId,
          printerName: printer.printerName,
          status: printer.status,
          qrTargetUrl: printer.qrTargetUrl,
        },
        shop: shop ? { id: shop.id, name: shop.name } : undefined,
        telemetry,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });


  /**
   * Get Printer Telemetry & Online Status
   */
  app.get('/api/printers/:printerId/telemetry', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const telemetry = await storage.getPrinterTelemetry(printerId);

      // Necessarily public: the customer page checks this before taking an
      // order, so a shop with a dead agent does not collect money it cannot
      // fulfil. It therefore answers only "can this printer take a job right
      // now", and not the agent version or device id it used to volunteer —
      // that is fleet detail, useful for targeting and of no use to a customer.
      return res.json({
        isOnline: telemetry?.isOnline ?? false,
        paperStatus: telemetry?.paperStatus ?? 'UNKNOWN',
        lastHeartbeat: telemetry?.lastHeartbeat ?? null,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Mints a short-lived, single-use, printer-scoped authorisation to download
   * that printer's appsettings.json.
   *
   * This exists because the download itself is a browser navigation, which
   * cannot carry an Authorization header. The session check happens here, where
   * it can, and the download below carries only the resulting token — never the
   * printer's permanent API key.
   */
  app.post('/api/printers/:printerId/agent-config-token', async (req: Request, res: Response) => {
    try {
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;

      const issued = issueConfigDownloadToken({
        printerId: ctx.printer.id,
        shopId: ctx.printer.shopId,
        issuedTo: ctx.merchant.sub,
      });

      // The token itself is never logged: it is a bearer credential for the
      // next two minutes, and an access log is exactly where it must not be.
      return res.status(201).json({
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        expiresInSeconds: issued.expiresInSeconds,
        url: `/api/printers/${encodeURIComponent(ctx.printer.id)}/agent-config?token=${encodeURIComponent(issued.token)}`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Download Pre-Configured appsettings.json for Windows Print Agent.
   *
   * Authorised by a token from the endpoint above, not by a session, and not by
   * nothing at all — which is what it was. The file contains the printer's
   * agent API key, and printer ids are public (they are on the QR poster), so
   * an unauthenticated version of this route handed a shop's agent credentials
   * to anyone who scanned its poster.
   */
  app.get('/api/printers/:printerId/agent-config', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const presented = typeof req.query.token === 'string' ? req.query.token : '';

      if (!presented) {
        return res.status(401).json({
          error: 'A download authorisation is required. Use the download button in your dashboard.',
        });
      }

      // Signature, expiry and the printer binding are all checked together, so
      // a valid token for another printer cannot read this one.
      const claims = verifyConfigDownloadToken(presented, printerId);
      if (!claims) {
        return res.status(401).json({
          error: 'This download link is invalid or has expired. Use the download button in your dashboard again.',
        });
      }

      // Single use. A link left in browser history or a proxy log cannot be
      // replayed; the short expiry is the backstop if this store is unavailable.
      const replayKey = `${CONFIG_DOWNLOAD_SCOPE}:${claims.jti}`;
      if (await storage.getIdempotencyRecord(replayKey)) {
        return res.status(401).json({
          error: 'This download link has already been used. Use the download button in your dashboard again.',
        });
      }

      const printer = await storage.getPrinter(printerId);
      if (!printer || printer.shopId !== claims.shopId) {
        return res.status(404).json({ error: 'Printer not found.' });
      }

      await storage.saveIdempotencyRecord({
        key: replayKey,
        scope: CONFIG_DOWNLOAD_SCOPE,
        // No request body is involved, and the jti already makes the key unique.
        requestHash: claims.jti,
        statusCode: 200,
        responseBody: {},
        createdAt: new Date().toISOString(),
        // Outlives the token, so a burnt jti cannot come back before it expires.
        expiresAt: new Date(Date.now() + CONFIG_DOWNLOAD_TTL_MS * 2).toISOString(),
      });

      await storage.recordSecurityEvent({
        printerId: printer.id,
        type: 'AGENT_CONFIG_DOWNLOADED',
        severity: 'info',
        // Who and which printer — never the key or the token.
        detail: { issuedTo: claims.issuedTo },
      });

      const apiBaseUrl = process.env.API_BASE_URL || 'https://prinok-api.onrender.com';

      // The agent resolves flat keys first and falls back to the nested PrintOk
      // section, so emit both: agents released before v1.1.0 only read the nested
      // shape and would otherwise silently fall back to localhost defaults.
      const config = {
        PrintOkApiUrl: apiBaseUrl,
        AgentApiKey: printer.apiKey,
        ShopId: printer.shopId,
        PrinterId: printer.id,
        PrinterName: '',
        PollIntervalMs: 3000,
        HeartbeatIntervalSeconds: 30,
        PrintOk: {
          ApiBaseUrl: apiBaseUrl,
          ApiKey: printer.apiKey,
          ShopId: printer.shopId,
          PrinterId: printer.id,
          PollIntervalMs: 3000,
          HeartbeatIntervalSeconds: 30
        },
        Logging: {
          LogLevel: {
            Default: 'Information',
            'Microsoft.Hosting.Lifetime': 'Information'
          }
        }
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="appsettings.json"`);
      return res.send(JSON.stringify(config, null, 2));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------------------
  // Platform administration (PRD 21)
  // ------------------------------------------------------------------------

  /**
   * Resolves the calling operator from a bearer token.
   * Responds and returns null on failure, so callers can `if (!admin) return;`.
   */
  async function authenticateAdmin(req: Request, res: Response): Promise<AdminTokenPayload | null> {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) {
      res.status(401).json({ error: 'Unauthorized: sign in to the admin console.' });
      return null;
    }

    const payload = verifyAdminToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Session expired or invalid. Sign in again.' });
      return null;
    }

    // A disabled account must lose access immediately, not at token expiry.
    const user = await storage.getAdminUser(payload.sub);
    if (!user || user.status !== 'active') {
      res.status(401).json({ error: 'This admin account is no longer active.' });
      return null;
    }

    return payload;
  }

  /**
   * Creates the very first operator account.
   *
   * Open only while no admin exists, so it cannot be used to add accounts later.
   * Every subsequent account is created by a signed-in operator.
   */
  app.post('/api/admin/bootstrap', async (req: Request, res: Response) => {
    try {
      if ((await storage.countAdminUsers()) > 0) {
        return res.status(409).json({ error: 'An administrator already exists. Sign in instead.' });
      }

      const { email, password, name } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required.' });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      const user = await storage.createAdminUser({
        email: String(email),
        passwordHash: hashPassword(String(password)),
        name,
        role: 'owner',
      });

      return res.status(201).json({ user, token: issueAdminToken(user) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required.' });
      }

      const user = await storage.getAdminUserByEmail(String(email));

      // Same response whether the account is missing, disabled or the password
      // is wrong, so this cannot be used to enumerate accounts.
      const ok = user && user.status === 'active' && verifyPassword(String(password), user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }

      await storage.recordAdminLogin(user!.id);
      const { passwordHash, ...safe } = user!;
      return res.json({ user: safe, token: issueAdminToken(safe) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/me', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    const user = await storage.getAdminUser(admin.sub);
    return res.json({ user, needsBootstrap: false });
  });

  /** Whether the console still needs its first account created. */
  app.get('/api/admin/status', async (_req: Request, res: Response) => {
    try {
      return res.json({ needsBootstrap: (await storage.countAdminUsers()) === 0 });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/overview', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      return res.json({ overview: await storage.getAdminOverview() });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/shops', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const includeArchived = req.query.includeArchived === 'true';
      return res.json({ shops: await storage.listAdminShopSummaries(limit, includeArchived) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Whether a shop can be hard deleted, without changing anything.
   * The console calls this before offering a destructive action.
   */
  app.get('/api/admin/shops/:shopId/removal-safety', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      return res.json({ safety: await storage.getShopRemovalSafety(req.params.shopId) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Removes shops (PRD 21).
   *
   * Handles one or many in the same call, so bulk cleanup and a single deletion
   * share one guarded path rather than two that can drift.
   *
   * mode 'delete'  - permanent, and refused for any shop that has taken a paid
   *                  job, because that would destroy payment records
   * mode 'archive' - hides the shop but keeps everything, the only safe option
   *                  once real money has moved through it
   * mode 'restore' - undoes an archive
   *
   * A bulk request is not atomic on purpose: one shop being undeletable must not
   * prevent the rest from being cleaned up. Every outcome is reported per shop.
   */
  app.post('/api/admin/shops/remove', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    if (!canWrite(admin.role)) {
      return res.status(403).json({ error: 'Your role is read-only.' });
    }

    try {
      const { shopIds, mode, reason, force, confirm } = req.body || {};
      const ids: string[] = Array.isArray(shopIds) ? shopIds : shopIds ? [shopIds] : [];

      if (ids.length === 0) {
        return res.status(400).json({ error: 'shopIds is required.' });
      }
      if (ids.length > 100) {
        return res.status(400).json({ error: 'At most 100 shops can be removed in one request.' });
      }
      if (!['delete', 'archive', 'restore'].includes(mode)) {
        return res.status(400).json({ error: "mode must be 'delete', 'archive' or 'restore'." });
      }

      // Overriding the paid-job guard destroys payment records along with the
      // shop, so it takes the highest role and a typed confirmation rather than
      // a boolean that could be set by accident.
      const forceDelete = mode === 'delete' && force === true;
      if (forceDelete) {
        if (admin.role !== 'owner') {
          return res.status(403).json({
            error: 'Only an owner can delete shops that have taken payment.',
          });
        }
        if (confirm !== 'DELETE PAID SHOPS') {
          return res.status(400).json({
            error: "Forced deletion requires confirm: 'DELETE PAID SHOPS'.",
          });
        }
      }

      const results = [];
      for (const shopId of ids) {
        // Capture what is about to be destroyed, so the audit entry still
        // explains the deletion after the row is gone.
        const safety = await storage.getShopRemovalSafety(shopId);

        let result;
        if (mode === 'delete') {
          result = await storage.hardDeleteShop(shopId, forceDelete);
        } else if (mode === 'archive') {
          result = await storage.archiveShop(shopId, admin.email, reason);
        } else {
          result = await storage.restoreShop(shopId);
        }

        if (result.ok) {
          await storage.recordAdminAudit({
            actorId: admin.sub,
            actorEmail: admin.email,
            // A forced deletion is recorded distinctly so it stands out from
            // ordinary cleanup in the audit trail.
            action: forceDelete && safety.paidJobCount > 0
              ? 'SHOP_FORCE_DELETED'
              : `SHOP_${result.action.toUpperCase()}`,
            targetType: 'shop',
            targetId: shopId,
            detail: {
              reason,
              forced: forceDelete,
              paidJobCount: safety.paidJobCount,
              totalJobCount: safety.totalJobCount,
              printerCount: safety.printerCount,
            },
          });
        }

        results.push(result);
      }

      return res.json({
        results,
        succeeded: results.filter((r) => r.ok).length,
        refused: results.filter((r) => !r.ok).length,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Link a shop to Razorpay Route so its share settles automatically.
   *
   * Creating the account is only the first step: Razorpay still requires the
   * shop to complete KYC before any transfer will settle, which is why the
   * status is surfaced rather than assumed.
   */
  app.post('/api/shops/:shopId/razorpay-account', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const shop = await storage.getShop(shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      if (shop.razorpayAccountId) {
        // Already linked; report live status rather than creating a duplicate.
        const status = await routeService.getLinkedAccount(shop.razorpayAccountId);
        if (status.ok && status.status) {
          await storage.updateShopRazorpayAccount(shopId, {
            accountId: shop.razorpayAccountId,
            status: status.status === 'activated' ? 'activated' : 'needs_kyc',
          });
        }
        return res.json({
          accountId: shop.razorpayAccountId,
          status: status.status || shop.razorpayAccountStatus,
          alreadyLinked: true,
        });
      }

      const { phone, businessType, contactName, address } = req.body || {};

      // What the shop gave at signup is the default; the request body may still
      // override it, so a shop can correct its details at onboarding time
      // without editing its profile first.
      const effectivePhone = phone || shop.contactPhone;

      if (!effectivePhone) {
        return res.status(400).json({
          error:
            'A contact phone number is required to create a Razorpay linked account. ' +
            'Add one to the shop profile, or send it with this request.',
        });
      }

      const effectiveAddress = address || {
        street1: shop.addressStreet1,
        street2: shop.addressStreet2,
        city: shop.addressCity,
        state: shop.addressState,
        postalCode: shop.addressPostalCode,
        country: shop.addressCountry || 'IN',
      };

      const result = await routeService.createLinkedAccount({
        shopId,
        shopName: shop.name,
        ownerEmail: shop.ownerEmail,
        phone: effectivePhone,
        businessType,
        contactName,
        address: effectiveAddress,
      });

      if (!result.ok) {
        await storage.updateShopRazorpayAccount(shopId, {
          status: 'not_linked',
          error: result.error,
        });
        return res.status(result.routeUnavailable ? 503 : 400).json({
          error: result.error,
          routeUnavailable: result.routeUnavailable === true,
        });
      }

      await storage.updateShopRazorpayAccount(shopId, {
        accountId: result.accountId,
        status: result.status === 'activated' ? 'activated' : 'needs_kyc',
        error: null,
      });

      return res.status(201).json({
        accountId: result.accountId,
        status: result.status,
        message:
          'Linked account created. Razorpay will ask for KYC documents before payouts can settle.',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Current Route status for a shop, refreshed from Razorpay when linked. */
  app.get('/api/shops/:shopId/razorpay-account', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const shop = await storage.getShop(req.params.shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      if (!shop.razorpayAccountId) {
        return res.json({
          status: 'not_linked',
          routeEnabled: routeService.isEnabled,
          error: shop.razorpayAccountError,
        });
      }

      const live = await routeService.getLinkedAccount(shop.razorpayAccountId);
      if (live.ok && live.status) {
        await storage.updateShopRazorpayAccount(req.params.shopId, {
          accountId: shop.razorpayAccountId,
          status: live.status === 'activated' ? 'activated' : 'needs_kyc',
        });
      }

      return res.json({
        accountId: shop.razorpayAccountId,
        status: live.status || shop.razorpayAccountStatus,
        routeEnabled: routeService.isEnabled,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Published plan catalogue (PRD 41).
   *
   * Public and unauthenticated: the landing page renders from this, so the
   * prices a shop is shown are the prices the API actually applies.
   */
  app.get('/api/plans', (_req: Request, res: Response) => {
    return res.json({
      plans: PLAN_CATALOGUE,
      paymentGateway: {
        feeBps: PAYMENT_GATEWAY_FEE_BPS,
        label: PAYMENT_GATEWAY_LABEL,
        note: 'Charged by Razorpay and deducted before settlement. Separate from the PrintOk service fee.',
      },
    });
  });

  /**
   * Public contact form submission.
   *
   * Enquiries are stored rather than emailed, so nothing depends on a mail
   * provider being configured and a message cannot be silently lost. Delivery
   * or notification can be layered on later without changing capture.
   */
  app.post('/api/contact', async (req: Request, res: Response) => {
    try {
      const { name, email, phone, shopName, message, website } = req.body || {};

      // Honeypot: a real person never fills a field they cannot see. Answer 201
      // so a bot cannot tell it was rejected.
      if (website) {
        return res.status(201).json({ success: true });
      }

      const trimmedName = String(name || '').trim();
      const trimmedEmail = String(email || '').trim().toLowerCase();
      const trimmedMessage = String(message || '').trim();

      if (!trimmedName || !trimmedEmail || !trimmedMessage) {
        return res.status(400).json({ error: 'Name, email and message are required.' });
      }
      if (trimmedName.length > 120 || trimmedEmail.length > 200) {
        return res.status(400).json({ error: 'Name or email is too long.' });
      }
      if (trimmedMessage.length < 10) {
        return res.status(400).json({ error: 'Please describe what you need in a little more detail.' });
      }
      if (trimmedMessage.length > 4000) {
        return res.status(400).json({ error: 'Message is too long. Please keep it under 4000 characters.' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        return res.status(400).json({ error: 'That email address does not look right.' });
      }

      // Per-address ceiling on top of the per-IP limiter, so one sender cannot
      // flood the inbox from a rotating address pool.
      const recent = await storage.countRecentEnquiriesFrom(trimmedEmail, 60 * 60 * 1000);
      if (recent >= 3) {
        return res.status(429).json({
          error: 'We already have your recent messages. We will reply shortly.',
        });
      }

      const enquiry = await storage.createContactEnquiry({
        name: trimmedName,
        email: trimmedEmail,
        phone: phone ? String(phone).trim().slice(0, 40) : undefined,
        shopName: shopName ? String(shopName).trim().slice(0, 160) : undefined,
        message: trimmedMessage,
        source: 'landing',
        // Coarse origin only, hashed, for abuse investigation.
        ipHash: req.ip
          ? crypto.createHash('sha256').update(req.ip).digest('hex').slice(0, 32)
          : undefined,
        userAgent: (req.headers['user-agent'] || '').toString().slice(0, 400),
      });

      return res.status(201).json({ success: true, enquiryId: enquiry.id });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Enquiries from the contact form (PRD 24). */
  app.get('/api/admin/contact-enquiries', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      const limit = Math.min(Number(req.query.limit) || 100, 300);
      return res.json({
        enquiries: await storage.listContactEnquiries(status, limit),
        newCount: await storage.countNewContactEnquiries(),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/admin/contact-enquiries/:id', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    if (!canWrite(admin.role)) {
      return res.status(403).json({ error: 'Your role is read-only.' });
    }

    try {
      const { status, notes } = req.body || {};
      if (!['new', 'read', 'replied', 'archived'].includes(status)) {
        return res.status(400).json({ error: "status must be 'new', 'read', 'replied' or 'archived'." });
      }

      const enquiry = await storage.updateContactEnquiryStatus(
        req.params.id, status, admin.email, notes
      );
      if (!enquiry) return res.status(404).json({ error: 'Enquiry not found.' });

      return res.json({ enquiry });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Operator action history (PRD 22). */
  app.get('/api/admin/audit', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      return res.json({ entries: await storage.listAdminAudit(limit) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Change a shop's tier, commission or status (PRD 41). */
  app.patch('/api/admin/shops/:shopId/plan', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    if (!canWrite(admin.role)) {
      return res.status(403).json({ error: 'Your role is read-only.' });
    }

    try {
      const { planTier, commissionBps, planStatus } = req.body || {};

      if (planTier && !PLAN_TIERS.includes(planTier)) {
        return res.status(400).json({
          error: `Unknown plan tier '${planTier}'. Expected one of: ${PLAN_TIERS.join(', ')}.`,
        });
      }
      if (planStatus && !['active', 'suspended', 'cancelled'].includes(planStatus)) {
        return res.status(400).json({ error: `Unknown plan status '${planStatus}'.` });
      }
      if (commissionBps !== undefined) {
        const bps = Number(commissionBps);
        // Guard against a typo silently charging shops 100%.
        if (!Number.isInteger(bps) || bps < 0 || bps > 5000) {
          return res.status(400).json({ error: 'commissionBps must be an integer between 0 and 5000 (0-50%).' });
        }
      }

      // Moving tier adopts that tier's published fee unless one is given
      // explicitly, so a shop is never left paying its old rate on a new plan.
      const resolvedCommission = commissionBps !== undefined
        ? Number(commissionBps)
        : (planTier ? getPlan(planTier)?.commissionBps : undefined);

      const plan = await storage.updateShopPlan(req.params.shopId, {
        planTier, commissionBps: resolvedCommission, planStatus,
      });
      if (!plan) return res.status(404).json({ error: 'Shop not found.' });

      await storage.recordAdminAudit({
        actorId: admin.sub,
        actorEmail: admin.email,
        action: 'PLAN_CHANGED',
        targetType: 'shop',
        targetId: req.params.shopId,
        detail: { planTier, commissionBps, planStatus },
      });

      return res.json({ plan });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * The shop refuses a job, refunding the customer in full.
   *
   * A shop has to be able to say no — the paper is the wrong size, the printer
   * is broken, the document is something it will not print. Doing that while
   * the customer has already paid means sending the money back, so the two are
   * one action rather than a cancellation the shop must remember to refund.
   *
   * The refund is issued only after the job has been moved to RefundPending, so
   * a job is never recorded as refunded before Razorpay has accepted it, and a
   * refund that fails leaves a state that says so rather than one that lies.
   */
  app.post('/api/shops/:shopId/jobs/:jobId/decline', async (req: Request, res: Response) => {
    const { shopId, jobId } = req.params;

    const merchant = await authenticateMerchant(req, res, { shopId });
    if (!merchant) return;

    try {
      const reason = String((req.body || {}).reason || '').trim();
      if (!reason) {
        return res.status(400).json({
          error: 'A reason is required. The customer is told why their job was refused.',
        });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) return res.status(404).json({ error: 'Print job not found.' });

      // Scoped to the shop in the URL, which the session is already checked
      // against — so one shop cannot decline another's work.
      if (job.shopId !== shopId) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // Paper and toner are already spent once it has printed. Refusing then is
      // a refund decision for a human, not a button.
      if ([PrintState.Printed, PrintState.ReadyForCollection, PrintState.Completed].includes(job.printState)) {
        return res.status(409).json({
          error: 'This job has already printed and cannot be declined. Issue a refund manually if it was wrong.',
        });
      }

      const declined = await storage.declineJob(jobId, reason, {
        actor: `shop:${merchant.sub}`,
        detail: { declinedBy: merchant.email },
      });

      if (!declined.ok) {
        const status = declined.code === 'NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ error: declined.reason });
      }

      // Nothing was taken, so there is nothing to send back.
      if (declined.job.paymentState !== PaymentState.RefundPending) {
        return res.json({
          success: true,
          job: declined.job,
          refund: { issued: false, reason: 'No payment had been taken for this job.' },
        });
      }

      const refund = await razorpayService.refundPayment(
        String(job.paymentRef || ''),
        job.totalPriceInCents,
        { jobId: job.id, shopId: job.shopId, reason }
      );

      if (!refund.ok) {
        // The job stays in RefundPending: the shop's decision stands, and the
        // money is visibly still owed rather than quietly forgotten.
        return res.status(202).json({
          success: true,
          job: declined.job,
          refund: { issued: false, error: refund.error },
          message:
            'The job was declined, but the refund could not be issued automatically. ' +
            'It must be refunded from the Razorpay dashboard.',
        });
      }

      const recorded = await storage.recordJobRefund(
        jobId,
        { refundId: refund.refundId, amountInCents: refund.amountInCents },
        { actor: `shop:${merchant.sub}` }
      );

      return res.json({
        success: true,
        job: recorded.ok ? recorded.job : declined.job,
        refund: { issued: true, refundId: refund.refundId, amountInCents: refund.amountInCents },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Jobs waiting on a human decision (PRD 12).
   */
  app.get('/api/shops/:shopId/jobs/requires-action', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const jobs = await storage.getJobsRequiringAction(req.params.shopId, limit);
      return res.json({ jobs });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Sweep for jobs abandoned by a dead or disconnected agent (PRD 12, 13).
   * Runs automatically on a timer; exposed so it can also be triggered manually.
   */
  app.post('/api/admin/reclaim-stale-jobs', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const result = await storage.reclaimStaleJobs();
      return res.json({
        requeued: result.requeued.length,
        escalated: result.escalated.length,
        jobIds: result,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Regenerate a printer's QR code against the currently configured web URL.
   * Needed for printers registered while PUBLIC_WEB_URL was unset, whose posters
   * encode an unreachable localhost address.
   */
  app.post('/api/printers/:printerId/regenerate-qr', async (req: Request, res: Response) => {
    try {
      // Authorise before anything else. Checking configuration first told an
      // anonymous caller, through a 500, that the route existed and how it was
      // deployed — a signed-in check must come before any other answer.
      //
      // Regenerating invalidates every poster already printed and stuck to a
      // counter, so this has to be the shop's own decision.
      const ctx = await authorizePrinter(req, res, { requireOwner: true });
      if (!ctx) return;
      const printer = ctx.printer;

      const configuredWebUrl = process.env.PUBLIC_WEB_URL;
      if (!configuredWebUrl) {
        return res.status(500).json({
          error: 'PUBLIC_WEB_URL is not configured; regenerating would reproduce the same broken URL.',
        });
      }

      const baseUrl = configuredWebUrl.replace(/\/$/, '');
      const updated = await storage.regeneratePrinterQr(printer.id, baseUrl, generateQrCodeDataUrl);
      return res.json({ printer: updated });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Issue a short-lived pairing code for a printer (PRD 7.1).
   * The shop owner reads this off the dashboard and enters it on the shop PC.
   */
  app.post('/api/printers/:printerId/pairing-code', async (req: Request, res: Response) => {
    try {
      // A pairing code is exchanged for a device token that can read this
      // shop's print jobs. Unauthenticated, this route was a complete
      // authentication bypass: a printer id off a QR poster was enough to pair
      // an attacker's own machine to the shop.
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;
      const printerId = ctx.printer.id;

      const code = generatePairingCode();
      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
      await storage.createPairingCode(printerId, code, expiresAt);

      return res.status(201).json({
        code,
        printerId,
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: Math.round(PAIRING_CODE_TTL_MS / 1000),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Pair an agent install and issue its device-scoped token (PRD 7.1, 7.2).
   * The token is returned exactly once; only its hash is stored.
   */
  app.post('/api/agent/pair', async (req: Request, res: Response) => {
    try {
      const { pairingCode, deviceName, osVersion, agentVersion } = req.body || {};
      if (!pairingCode) {
        return res.status(400).json({ error: 'pairingCode is required.' });
      }

      const normalized = normalizePairingCode(String(pairingCode));
      const deviceId = `dev_${crypto.randomBytes(8).toString('hex')}`;

      const claimed = await storage.consumePairingCode(normalized, deviceId);
      if (!claimed) {
        await storage.recordSecurityEvent({
          type: 'PAIRING_REJECTED',
          severity: 'warning',
          detail: { reason: 'Unknown, expired or already-used pairing code.' },
        });
        // Deliberately vague: do not reveal which of the three it was.
        return res.status(401).json({ error: 'Pairing code is invalid or has expired. Generate a new one.' });
      }

      const printer = await storage.getPrinter(claimed.printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Printer not found.' });
      }

      const issued = issueDeviceToken();
      await storage.createAgentDevice({
        printerId: claimed.printerId,
        deviceId,
        tokenHash: issued.tokenHash,
        tokenExpiresAt: issued.expiresAt,
        deviceName,
        osVersion,
        agentVersion,
      });

      await storage.recordSecurityEvent({
        printerId: claimed.printerId,
        deviceId,
        type: 'PAIRED',
        severity: 'info',
        detail: { deviceName, osVersion, agentVersion },
      });

      return res.status(201).json({
        deviceId,
        // Shown once. The server keeps only the hash and cannot return it again.
        deviceToken: issued.token,
        tokenExpiresAt: issued.expiresAt.toISOString(),
        printerId: printer.id,
        shopId: printer.shopId,
        apiBaseUrl: process.env.API_BASE_URL || 'https://prinok-api.onrender.com',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Paired agent installs for a printer (PRD 7.1). */
  app.get('/api/printers/:printerId/devices', async (req: Request, res: Response) => {
    try {
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;

      const devices = await storage.listAgentDevices(ctx.printer.id);
      return res.json({ devices });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Revoke one agent install without re-keying the printer (PRD 7.2). */
  app.post('/api/printers/:printerId/devices/:deviceId/revoke', async (req: Request, res: Response) => {
    try {
      // Revoking stops a shop printing, so it must be the shop's own call.
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;

      const { printerId, deviceId } = req.params;
      const device = await storage.getAgentDevice(deviceId);
      if (!device || device.printerId !== printerId) {
        return res.status(404).json({ error: 'Device not found for this printer.' });
      }

      const revoked = await storage.revokeAgentDevice(deviceId, req.body?.reason);

      await storage.recordSecurityEvent({
        printerId,
        deviceId,
        type: 'REVOKED',
        severity: 'warning',
        detail: { reason: req.body?.reason || 'unspecified' },
      });

      return res.json({ device: revoked });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Agent security audit trail for a printer (PRD 7.2). */
  app.get('/api/printers/:printerId/security-events', async (req: Request, res: Response) => {
    try {
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;

      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const events = await storage.listSecurityEvents(ctx.printer.id, limit);
      return res.json({ events });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Download Windows Print Agent Executable / Release Package
   */
  app.get('/api/agent-installer', async (req: Request, res: Response) => {
    try {
      // ?format=zip returns the full bundle (executable + appsettings template +
      // setup instructions); the default is the standalone self-contained .exe.
      const wantsBundle = String(req.query.format || '').toLowerCase() === 'zip';

      const customUrl = process.env.AGENT_INSTALLER_URL;
      if (customUrl && !wantsBundle) {
        return res.redirect(customUrl);
      }

      const githubRepo = process.env.PRINT_AGENT_REPO || 'Ayan-css/PrintOK';
      const assetName = wantsBundle ? 'PrintAgent-win-x64.zip' : 'WindowsPrintAgent.exe';
      const releaseUrl = `https://github.com/${githubRepo}/releases/download/latest/${assetName}`;
      return res.redirect(releaseUrl);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Customer Create Print Job Endpoint (Multi-Format Document Engine)
   */
  app.post('/api/print-jobs', async (req: Request, res: Response) => {
    try {
      const {
        printerId, fileName, fileBase64, copies, isColor, isDuplex, paperSize,
        customerName, customerPhone,
      } = req.body as CreatePrintJobDto;
      const autoApprove = req.query.autoApprove !== 'false';

      if (!printerId || !fileName || !fileBase64) {
        return res.status(400).json({ error: 'printerId, fileName, and fileBase64 are required.' });
      }

      const printer = await storage.getPrinter(printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Target printer not found.' });
      }

      // Customer identity, only if this shop asked for it.
      //
      // Read from the shop's config rather than trusted from the request: a
      // caller must not be able to attach a name and phone to a job at a shop
      // that never asked for one, because the privacy policy tells that shop's
      // customers nothing of the sort is collected.
      const portal = await storage.getShopPortalConfig(printer.shopId);
      const identity = readCustomerIdentity(portal, { customerName, customerPhone });
      if ('error' in identity) {
        return res.status(400).json({ error: identity.error });
      }

      // The shop only sells what it has switched on. Hiding a control on the
      // customer page is presentation; this is the part that actually stops a
      // colour job reaching a shop with a mono printer, whether it came from a
      // stale page, a cached one, or a script.
      const options = derivePortalOptions(
        portal.enabledServices,
        await storage.getShopRateCard(printer.shopId)
      );
      const unavailable = checkJobAgainstPortal(options, {
        isColor: !!isColor,
        isDuplex: !!isDuplex,
        paperSize: paperSize || 'A4',
        copies: copies || 1,
        pageRange: (req.body as any)?.pageRange,
      });
      if (unavailable) {
        return res.status(400).json({ error: unavailable });
      }

      // Multi-format document inspection & server-side page count verification
      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const docResult = await processDocument(fileName, fileBuffer);

      if (!docResult.isSupported) {
        return res.status(400).json({ error: docResult.errorMessage });
      }

      // Tamper-proof page count override
      const verifiedPageCount = docResult.pageCount;

      // "Print everything" queues the job before payment clears. That is a
      // shop choosing to print first and collect at the counter — and choosing
      // to eat the paper when someone walks away. It is not a default.
      //
      // Passed as its own flag rather than as autoApprove: that one marks the
      // payment settled, and reusing it here would record an unpaid job as Paid.
      const queueWithoutPayment = !autoApprove && portal.autoPrintMode === 'all';

      const job = await storage.createPrintJob(
        printerId,
        fileName,
        fileBase64,
        verifiedPageCount,
        copies || 1,
        !!isColor,
        autoApprove,
        !!isDuplex,
        paperSize || 'A4',
        { ...identity.value, queueWithoutPayment }
      );

      // If job is immediately queued, push notification to active WebSocket agent
      if (job.printState === PrintState.Queued && wsServer) {
        wsServer.notifyJobQueued(job);
      }

      const response: CreatePrintJobResponse = { job };
      return res.status(201).json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Heartbeat Endpoint
   */
  app.post('/api/agent/heartbeat', async (req: Request, res: Response) => {
    try {
      const identity = await authenticateAgent(storage, req, res);
      if (!identity) return;
      const printer = { id: identity.printerId, shopId: identity.shopId };

      const { paperStatus } = req.body || {};
      const telemetry = await storage.recordHeartbeat(printer.id, paperStatus || 'OK');
      return res.json({ success: true, telemetry });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * One-Click Manual Print Override (For offline cash payment / merchant override)
   */
  /**
   * Releases a job the shop was holding.
   *
   * Only for shops printing on their own say-so. A job in any other state is
   * refused rather than force-queued: "print this now" must not become a way to
   * push an unpaid or already-printing job through.
   */
  app.post('/api/shops/:shopId/jobs/:jobId/release', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const { shopId, jobId } = req.params;
      const job = await storage.getPrintJob(jobId);
      if (!job || job.shopId !== shopId) {
        return res.status(404).json({ error: 'Job not found for this shop.' });
      }

      if (job.printState !== PrintState.HeldForRelease) {
        return res.status(409).json({
          error: `This job is ${job.printState}, not waiting to be released.`,
          job,
        });
      }

      const result = await storage.updateJobPrintState(jobId, PrintState.Queued, undefined, {
        actor: `shop:${merchant.sub}`,
      });
      if (!result.ok) {
        // NOT_FOUND carries no job; the union has already been narrowed above
        // by the explicit lookup, so this is the illegal-transition case.
        return res.status(409).json({ error: result.reason });
      }

      if (wsServer && result.job) wsServer.notifyJobQueued(result.job);
      return res.json({ job: result.job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/print-jobs/:id/manual-override', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await storage.confirmPaymentAndQueueJob(id, { actor: 'shop' });
      if (!result.ok) {
        const status = result.code === 'NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ error: result.reason });
      }
      const job = result.job;

      if (wsServer) {
        wsServer.notifyJobQueued(job);
      }

      return res.json({ success: true, message: 'Job manually approved & queued for print.', job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });


  /**
   * Create Razorpay Payment Order Endpoint
   */
  app.post('/api/payments/create-order', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.body;
      if (!jobId) {
        return res.status(400).json({ error: 'jobId is required.' });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // A job that is already paid must not be charged twice.
      if (job.paymentState === PaymentState.Paid) {
        return res.status(409).json({ error: 'This job has already been paid for.' });
      }

      // Split to the shop's own Razorpay account where Route is available, so
      // the money settles to the shop directly instead of pooling with us.
      // Falls back to the single-account flow when it is not.
      let transfer;
      let serviceFeeCents;

      if (routeService.isEnabled) {
        const shop = await storage.getShop(job.shopId);
        const plan = await storage.getShopPlan(job.shopId);

        if (shop?.razorpayAccountId && shop.razorpayAccountStatus === 'activated' && plan) {
          const built = routeService.buildTransfer(
            shop.razorpayAccountId, job.totalPriceInCents, plan.commissionBps, job.id
          );
          transfer = built.transfer;
          serviceFeeCents = built.serviceFeeCents;
        }
      }

      // Razorpay refuses anything under a rupee. A shop's own rate card can
      // produce such a job, and without this the customer meets a gateway error
      // at the moment they try to pay, with no way to tell what went wrong.
      if (job.totalPriceInCents < MIN_ORDER_AMOUNT_PAISE) {
        return res.status(400).json({
          error:
            'This job is below the ₹1 minimum a card or UPI payment can be taken for. ' +
            'Please pay at the counter instead.',
        });
      }

      const orderResult = await razorpayService.createOrder(jobId, job.totalPriceInCents, transfer);

      if (transfer && serviceFeeCents !== undefined) {
        await storage.recordJobSettlement(job.id, transfer.amount, serviceFeeCents);
      }

      return res.json(orderResult);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Confirms a payment that Razorpay Checkout reported as successful.
   *
   * The browser cannot be trusted to say "I paid", so the signature Razorpay
   * returns is verified against our key secret before the job is queued. The
   * webhook remains the authoritative backstop if the browser never reaches
   * this endpoint.
   */
  app.post('/api/payments/verify', async (req: Request, res: Response) => {
    try {
      const { jobId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};

      if (!jobId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({
          error: 'jobId, razorpayOrderId, razorpayPaymentId and razorpaySignature are required.',
        });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // Replayed confirmation for an already-paid job is a success, not an error.
      if (job.paymentState === PaymentState.Paid) {
        return res.json({ success: true, message: 'Payment already confirmed.', job });
      }

      const valid = razorpayService.verifyCheckoutSignature(
        String(razorpayOrderId), String(razorpayPaymentId), String(razorpaySignature)
      );
      if (!valid) {
        return res.status(400).json({ error: 'Payment signature could not be verified.' });
      }

      const result = await storage.confirmPaymentAndQueueJob(jobId, {
        actor: 'customer',
        detail: { paymentRef: String(razorpayPaymentId), provider: 'razorpay' },
      });
      if (!result.ok) {
        const status = result.code === 'NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ error: result.reason });
      }

      if (wsServer) wsServer.notifyJobQueued(result.job);

      return res.json({ success: true, job: result.job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Payment Webhook Endpoint (HMAC SHA256 Signature Verification)
   */
  /**
   * The only Razorpay events that mean the customer's money has actually been
   * taken. Anything else — a failure, an authorization, a refund — must never
   * queue a job for printing.
   */
  const PAYMENT_CONFIRMING_EVENTS = new Set(['payment.captured', 'order.paid']);

  app.post('/api/payments/webhook', async (req: Request, res: Response) => {
    try {
      // Razorpay sends its signature in a header and its job reference inside
      // the payment entity's notes. The older flat body shape is still accepted
      // so existing callers keep working - both go through the same real
      // signature check.
      // Razorpay signs the raw body and sends the digest in this header. A
      // signature carried inside the body cannot cover itself, so the header is
      // the only accepted source.
      const signature = req.headers['x-razorpay-signature'] as string | undefined;
      const body = req.body || {};

      const jobId =
        body?.payload?.payment?.entity?.notes?.jobId ||
        (body as PaymentWebhookDto).jobId;

      const paymentRef =
        body?.payload?.payment?.entity?.id || (body as PaymentWebhookDto).paymentId;

      if (!jobId || !signature) {
        return res.status(400).json({ error: 'A job reference and signature are required.' });
      }

      const rawBody = (req as any).rawBody || JSON.stringify(body);
      if (!razorpayService.verifyWebhookSignature(rawBody, signature)) {
        return res.status(400).json({ error: 'Invalid HMAC payment webhook signature.' });
      }

      // Which event this is decides whether money actually arrived. Nothing
      // checked it before: every signed webhook carrying a job reference was
      // treated as a confirmation, and `payment.failed` carries the same
      // payment entity and the same notes as `payment.captured`. With that
      // event subscribed, a declined card marked the job paid and sent it to
      // the printer — the customer got their document and nobody was charged.
      //
      // A webhook with no event is the legacy flat body, which only ever meant
      // a confirmation; live Razorpay traffic always carries one.
      const event: string | undefined = body?.event;

      if (event && !PAYMENT_CONFIRMING_EVENTS.has(event)) {
        // Answered 200 deliberately: a non-2xx makes Razorpay retry the same
        // event for hours, and this one was understood — it just is not a
        // payment.
        console.log(`[Webhook] Ignoring '${event}' for job ${jobId}: not a payment confirmation.`);
        return res.json({
          success: true,
          ignored: event,
          message: 'Event acknowledged; it does not confirm a payment.',
        });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // Idempotency: If job is already paid, return existing status
      if (job.paymentState === PaymentState.Paid) {
        return res.json({ success: true, message: 'Payment already processed.', job });
      }

      const paymentResult = await storage.confirmPaymentAndQueueJob(jobId, {
        actor: 'webhook',
        detail: { paymentRef },
      });
      if (!paymentResult.ok) {
        const status = paymentResult.code === 'NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ error: paymentResult.reason });
      }
      const updatedJob = paymentResult.job;

      // Instant push notification over WebSocket
      if (wsServer) {
        wsServer.notifyJobQueued(updatedJob);
      }

      return res.json({ success: true, message: 'Payment confirmed & job queued.', job: updatedJob });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Print Job Status by Job ID
   */
  app.get('/api/print-jobs/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const job = await storage.getPrintJob(id);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }
      return res.json({ job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Polling Endpoint
   */
  app.get('/api/agent/jobs/pending', async (req: Request, res: Response) => {
    try {
      const identity = await authenticateAgent(storage, req, res);
      if (!identity) return;
      const printer = { id: identity.printerId, shopId: identity.shopId };

      // Claim each job for the calling device before handing it over. The job
      // moves Queued -> Assigned, so a second agent polling concurrently is told
      // the job is taken rather than printing it a second time (PRD 11).
      const deviceId = identity.deviceId || (req.headers['x-agent-device-id'] as string) || printer.id;
      const pendingJobs = await storage.getPendingJobsForPrinter(printer.id);

      // Whether a separator sheet belongs in front of these jobs, decided once
      // against the depth of the queue as it stood before anything was claimed.
      //
      // Deciding per job after claiming would compare against a queue this very
      // loop is draining, so the first job in a rush would get a separator and
      // the last would not — which is the wrong way round.
      const portal = await storage.getShopPortalConfig(printer.shopId);
      const separator = shouldPrintSeparator(portal, pendingJobs.length)
        ? portal.separatorMode
        : 'none';

      const claimedJobs = [];
      for (const job of pendingJobs) {
        const claim = await storage.assignJobToDevice(job.id, deviceId);
        if (claim.ok) {
          claimedJobs.push(claim.job);
        }
      }

      const response: AgentPollResponse = { jobs: claimedJobs, separator };
      return res.json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Update Status Endpoint
   */
  app.post('/api/agent/jobs/:id/status', async (req: Request, res: Response) => {
    try {
      const identity = await authenticateAgent(storage, req, res);
      if (!identity) return;
      const printer = { id: identity.printerId, shopId: identity.shopId };

      const { id } = req.params;
      const { printState, errorMessage } = req.body as AgentUpdateStatusDto;
      const deviceId = identity.deviceId || (req.headers['x-agent-device-id'] as string) || printer.id;

      // The job must belong to the printer this agent authenticated as.
      // Without this an agent in one shop could drive another shop's jobs to
      // Printed or Failed — including marking a paid job printed that was never
      // printed. 404 rather than 403, so job ids cannot be probed.
      const target = await storage.getPrintJob(id);
      if (!target || target.printerId !== printer.id) {
        return res.status(404).json({ error: 'Job not found for this printer.' });
      }

      const requestedState = parsePrintState(String(printState));
      if (!requestedState) {
        return res.status(400).json({ error: `Unknown print state '${printState}'.` });
      }

      const result = await storage.updateJobPrintState(id, requestedState, errorMessage, {
        actor: `agent:${deviceId}`,
        deviceId,
        // Classify who can resolve this, so the right person is asked (PRD 12).
        ...(requestedState === PrintState.Failed
          ? { failureCategory: classifyFailure(errorMessage) }
          : {}),
      });

      if (!result.ok) {
        if (result.code === 'NOT_FOUND') {
          return res.status(404).json({ error: result.reason });
        }
        // The job moved on underneath the agent (cancelled, or already terminal).
        // 409 tells the agent to stop rather than retry the same report forever.
        return res.status(409).json({ error: result.reason, job: result.job });
      }

      return res.json({ job: result.job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Shop Payout & Instant Withdrawal Summary
   */
  app.get('/api/shops/:shopId/payout-summary', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const [stats, shop, plan] = await Promise.all([
        storage.getShopStats(shopId),
        storage.getShop(shopId),
        storage.getShopPlan(shopId),
      ]);

      const grossCents = stats ? stats.todayRevenueCents : 0;

      // The shop's own commission, not a hardcoded 2%: a Start shop pays 8% and
      // was previously shown a figure from a plan it is not on.
      const commissionBps = plan?.commissionBps ?? 800;
      const { gatewayFeeCents, serviceFeeCents, netCents } =
        calculateShopNetCents(grossCents, commissionBps);

      const routeLinked = shop?.razorpayAccountStatus === 'activated';

      return res.json({
        shopId,
        grossCents,
        commissionBps,
        razorpayFeeCents: gatewayFeeCents,
        platformCommissionCents: serviceFeeCents,
        netAvailableCents: netCents,
        // The shop's own payout destination. This was hardcoded, so every shop
        // was shown the same address regardless of what it had registered.
        payoutUpiId: shop?.upiId || null,
        settlement: routeLinked ? 'automatic' : 'manual',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Shop Instant Payout Withdrawal Endpoint
   */
  /**
   * What the shop has earned, order by order.
   *
   * Built from the jobs themselves rather than a ledger table, because there is
   * no ledger table yet and inventing one that is not written to by the payment
   * path would be worse than deriving from the source of truth.
   *
   * The fee figures are estimates, and say so. Razorpay reports the actual fee
   * and tax on the payment object, and until the webhook stores those this can
   * only apply the published rate — a number that is close but not the one that
   * will appear on a settlement statement.
   */
  app.get('/api/shops/:shopId/earnings', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const [shop, plan, jobs] = await Promise.all([
        storage.getShop(shopId),
        storage.getShopPlan(shopId),
        storage.getRecentJobsForShop(shopId, 500),
      ]);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';

      // Compared as ISO strings. The timestamps already sort correctly that
      // way, and a Date round-trip would shift a job either side of midnight
      // into the wrong day.
      const inRange = (iso: string) =>
        (!from || iso >= from) && (!to || iso <= `${to}T23:59:59.999Z`);

      const commissionBps = plan?.commissionBps ?? 800;

      // Only money that actually arrived. A job awaiting payment has earned
      // nothing, and a refunded one has un-earned what it took.
      const earned = jobs.filter(
        (j) => j.paymentState === PaymentState.Paid && inRange(String(j.createdAt))
      );

      const rows = earned.map((job) => {
        const gross = job.totalPriceInCents || 0;
        const { gatewayFeeCents, serviceFeeCents, netCents } = calculateShopNetCents(gross, commissionBps);

        return {
          jobId: job.id,
          orderId: job.orderId,
          tokenNumber: job.tokenNumber ?? null,
          createdAt: job.createdAt,
          fileName: job.fileName,
          customerName: job.customerName ?? null,
          paymentRef: job.paymentRef ?? null,
          printState: job.printState,
          grossCents: gross,
          // What the shop actually banked on this order, and what each
          // deduction was for. A single "net" number invites the question this
          // answers.
          razorpayFeeCents: gatewayFeeCents,
          platformCommissionCents: serviceFeeCents,
          netCents,
        };
      });

      const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((t, r) => t + pick(r), 0);

      return res.json({
        settlement: shop.razorpayAccountStatus === 'activated' ? 'automatic' : 'pending-route',
        commissionBps,
        gatewayFeeBps: PAYMENT_GATEWAY_FEE_BPS,
        // Named so nobody reads these as a settlement statement.
        feesAreEstimated: true,
        totals: {
          orders: rows.length,
          grossCents: sum((r) => r.grossCents),
          razorpayFeeCents: sum((r) => r.razorpayFeeCents),
          platformCommissionCents: sum((r) => r.platformCommissionCents),
          netCents: sum((r) => r.netCents),
        },
        rows: rows.slice(0, 200),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/withdraw', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const shop = await storage.getShop(shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      // This endpoint previously answered "Instant UPI payout request processed
      // successfully" while moving no money and recording nothing. Telling a
      // shop owner their money has been sent when it has not is worse than
      // having no button at all, so it now reports the truth.
      if (shop.razorpayAccountStatus === 'activated') {
        return res.status(409).json({
          error:
            'This shop settles automatically. Each paid order is transferred to your own ' +
            'Razorpay account at the time of payment, so there is nothing to withdraw here.',
          settlement: 'automatic',
        });
      }

      return res.status(501).json({
        error:
          'Manual withdrawal is not available yet. Connect your shop to Razorpay from the ' +
          'dashboard to receive each order directly, or contact support for a manual payout.',
        settlement: 'manual',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return app;
}

