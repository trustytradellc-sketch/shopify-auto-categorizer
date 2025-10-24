// server.js - Hamza: Shopify ürünleri için AI + Rule Based Kategorilendirici ve SEO Otomasyonu
import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import { OpenAI } from 'openai';
import pino from 'pino';

import { createShopifyService } from './lib/shopify.js';
import { createCategorizer } from './lib/categorizer.js';
import { createProductProcessor } from './lib/processor.js';
import { createCommandHandler } from './lib/commands.js';

const {
  PORT = 10000,
  NODE_ENV = 'production',
  BACKFILL_TOKEN = '',
  COMMAND_TOKEN = '',
  LANG = 'en',
  OPENAI_API_KEY,
  OPENAI_API_TIMEOUT = '180',
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_APP_WEBHOOK_SECRET,
  SHOPIFY_SHOP
} = process.env;

const log = pino({
  level: NODE_ENV === 'development' ? 'debug' : 'info',
  transport: NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined
});

const missingEnv = [];
if (!SHOPIFY_ACCESS_TOKEN) missingEnv.push('SHOPIFY_ACCESS_TOKEN');
if (!SHOPIFY_SHOP) missingEnv.push('SHOPIFY_SHOP');
if (!SHOPIFY_APP_WEBHOOK_SECRET) missingEnv.push('SHOPIFY_APP_WEBHOOK_SECRET');

if (missingEnv.length) {
  log.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  log.warn('OPENAI_API_KEY not set. Running in rule-based mode only.');
}

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY, timeout: Number(OPENAI_API_TIMEOUT) * 1000 })
  : null;

const shopify = createShopifyService({
  shop: SHOPIFY_SHOP,
  accessToken: SHOPIFY_ACCESS_TOKEN,
  logger: log
});

const categorizer = createCategorizer({ lang: LANG, openai, logger: log });
const processor = createProductProcessor({ shopify, categorizer, lang: LANG, logger: log });
const commandHandler = createCommandHandler({ shopify, processor, categorizer, openai, logger: log });

function verifyShopifyHmac(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', SHOPIFY_APP_WEBHOOK_SECRET)
    .update(req.rawBody, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
  } catch {
    return false;
  }
}

const app = express();
app.use((req, res, next) => {
  if (req.headers['x-shopify-topic']) {
    getRawBody(req)
      .then(buffer => {
        req.rawBody = buffer;
        next();
      })
      .catch(next);
  } else {
    express.json({ limit: '2mb' })(req, res, next);
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.post('/backfill', express.json(), async (req, res) => {
  if (!BACKFILL_TOKEN || req.get('X-Backfill-Token') !== BACKFILL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const since = req.query.since || null;
  res.json({ started: true, since });
  const products = await shopify.getAllProducts({ since });
  log.info({ count: products.length, since }, 'Backfill fetched products');
  for (const product of products) {
    await processor.processProduct(product, 'backfill');
  }
});

app.post('/commands', async (req, res) => {
  if (!COMMAND_TOKEN) {
    return res.status(503).json({ error: 'COMMAND_TOKEN not configured' });
  }
  const supplied = req.get('X-Command-Token') || req.body?.token;
  if (supplied !== COMMAND_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await commandHandler.handle(req.body || {});
    res.json(result);
  } catch (error) {
    log.error({ err: error?.message }, 'Command handler error');
    res.status(400).json({ error: error?.message || 'Command failed' });
  }
});

app.post('/webhooks/products_create', async (req, res) => {
  if (!verifyShopifyHmac(req)) {
    return res.status(401).send('HMAC failed');
  }
  const product = JSON.parse(req.rawBody.toString());
  processor
    .processProduct(product, 'webhook_create')
    .catch(err => log.error({ id: product?.id, err: err?.message }, 'Async webhook create error'));
  res.status(200).send('ok');
});

app.post('/webhooks/products_update', async (req, res) => {
  if (!verifyShopifyHmac(req)) {
    return res.status(401).send('HMAC failed');
  }
  const product = JSON.parse(req.rawBody.toString());
  processor
    .processProduct(product, 'webhook_update')
    .catch(err => log.error({ id: product?.id, err: err?.message }, 'Async webhook update error'));
  res.status(200).send('ok');
});

app.listen(PORT, () => {
  log.info(`AI Categorizer running on :${PORT}`);
});
