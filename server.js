// server.js - Shopify ürünleri için AI + Rule Based Kategorilendirici ve SEO Otomasyonu
import express from 'express';
import crypto from 'crypto';
import getRawBody from 'raw-body';

import {
  BACKFILL_TOKEN,
  LANG,
  PORT,
  SHOPIFY_APP_WEBHOOK_SECRET,
  log
} from './src/config.js';
import { getAllProducts } from './src/shopify.js';
import { processProduct, processProducts } from './src/processor.js';

const app = express();

app.use((req, res, next) => {
  if (req.headers['x-shopify-topic']) {
    getRawBody(req).then((buf) => {
      req.rawBody = buf;
      next();
    }).catch(next);
  } else {
    express.json({ limit: '2mb' })(req, res, next);
  }
});

app.get('/health', (_, res) => res.json({ ok: true, lang: LANG }));

app.post('/backfill', express.json(), async (req, res) => {
  if (!BACKFILL_TOKEN || req.get('X-Backfill-Token') !== BACKFILL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const since = req.query.since || null;
  res.json({ started: true, since });
  const products = await getAllProducts({ since });
  await processProducts(products, 'backfill');
});

app.post('/webhooks/products_create', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('HMAC failed');
  const product = JSON.parse(req.rawBody.toString());
  processProduct(product, 'webhook_create');
  res.status(200).send('ok');
});

app.post('/webhooks/products_update', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('HMAC failed');
  const product = JSON.parse(req.rawBody.toString());
  processProduct(product, 'webhook_update');
  res.status(200).send('ok');
});

app.listen(PORT, () => {
  log.info(`AI Categorizer running on :${PORT}`);
});

function verifyShopifyHmac(req) {
  if (!SHOPIFY_APP_WEBHOOK_SECRET) {
    log.warn('SHOPIFY_APP_WEBHOOK_SECRET missing — skipping webhook signature verification');
    return true;
  }
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
