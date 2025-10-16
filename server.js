// server.js - Hamza: AI kategori + SEO (DB yok; metafield ile idempotent)
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import Bottleneck from 'bottleneck';
import { OpenAI } from 'openai';
import pino from 'pino';

const {
  PORT = 10000,
  NODE_ENV = 'production',
  BACKFILL_TOKEN = '',
  LANG = 'en',
  OPENAI_API_KEY,
  OPENAI_API_TIMEOUT = '180',
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_APP_WEBHOOK_SECRET,
  SHOPIFY_SHOP
} = process.env;

if (!OPENAI_API_KEY || !SHOPIFY_ACCESS_TOKEN || !SHOPIFY_SHOP) {
  console.error('ENV eksik: OPENAI_API_KEY / SHOPIFY_ACCESS_TOKEN / SHOPIFY_SHOP');
  process.exit(1);
}

const log = pino({
  level: NODE_ENV === 'development' ? 'debug' : 'info',
  transport: NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined
});

const SHOPIFY_ADMIN = `https://${SHOPIFY_SHOP}/admin/api/2024-07`;
const shopify = axios.create({
  baseURL: SHOPIFY_ADMIN,
  headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' }
});
const limiter = new Bottleneck({ minTime: 400, maxConcurrent: 1 });

async function shopifyCall(fn, ...args) {
  return limiter.schedule(async () => {
    try { return await fn(...args); }
    catch (err) {
      const r = err.response;
      if (r && (r.status === 429 || r.status >= 500)) {
        const retry = Number(r.headers['retry-after'] || 2);
        await new Promise(res => setTimeout(res, retry * 1000));
        return await fn(...args);
      }
      throw err;
    }
  });
}

async function getAllProducts({ since } = {}) {
  const items = [];
  let url = `/products.json?limit=250&status=any${since ? `&updated_at_min=${encodeURIComponent(since)}` : ''}`;
  while (true) {
    const res = await shopifyCall(() => shopify.get(url));
    items.push(...res.data.products);
    const link = res.headers.link || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!m) break;
    url = m[1].replace(SHOPIFY_ADMIN, '');
  }
  return items;
}

async function updateProduct(id, payload) {
  return shopifyCall(() => shopify.put(`/products/${id}.json`, { product: { id, ...payload } }));
}

async function getMetafield(productId, key) {
  const res = await shopifyCall(() =>
    shopify.get(`/products/${productId}/metafields.json?namespace=auto_ai&key=${key}`)
  ).catch(() => null);
  return res?.data?.metafields?.[0] || null;
}

async function setMetafield(productId, key, value, type = 'single_line_text_field') {
  // upsert
  const existing = await getMetafield(productId, key);
  if (existing) {
    await shopifyCall(() => shopify.put(`/metafields/${existing.id}.json`, { metafield: { id: existing.id, value } }));
  } else {
    await shopifyCall(() => shopify.post(`/metafields.json`, {
      metafield: {
        owner_id: productId, owner_resource: 'product',
        namespace: 'auto_ai', key, type, value
      }
    }));
  }
}

function verifyShopifyHmac(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', SHOPIFY_APP_WEBHOOK_SECRET)
    .update(req.rawBody, 'utf8').digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest)); }
  catch { return false; }
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: Number(OPENAI_API_TIMEOUT) * 1000 });

const SYSTEM = `
You are a senior US e-commerce merchandiser + SEO expert. 
Task: Given a Shopify product, output:
- "category_path": a > separated path (e.g., "Beauty > Fragrance > Women's Perfume")
- "ai_tags": 5-12 concise tags (comma separated)
- "seo_title": 58-62 chars
- "seo_description": 140-155 chars
- Use English unless LANG='tr'.
Return strict JSON only.
`;

async function aiCategorizeAndSeo(prod) {
  const bodyText = (prod.body_html || '').replace(/<[^>]+>/g, ' ').slice(0, 2000);
  const prompt = `
LANG: ${LANG}
Title: ${prod.title || ''}
Brand: ${prod.vendor || ''}
Tags: ${(prod.tags || '').toString()}
Type: ${prod.product_type || ''}
Options: ${prod.options?.map(o=>`${o.name}:${o.values?.slice(0,5).join('/')}`).join(', ') || ''}
Variants: ${prod.variants?.slice(0,3).map(v=>v.title).join(' ; ') || ''}
Body: ${bodyText}
Return JSON: {"category_path":"","ai_tags":"","seo_title":"","seo_description":""}
`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }]
  });
  const txt = resp.choices[0].message.content || '{}';
  const json = (txt.match(/\{[\s\S]*\}$/) || [txt])[0];
  return JSON.parse(json);
}

// === Idempotency: ürün metafield’ı ile ===
// key: last_processed_updated_at => Shopify'daki product.updated_at ile karşılaştır
async function alreadyProcessed(product) {
  const mf = await getMetafield(product.id, 'last_processed_updated_at');
  return mf && mf.value === product.updated_at;
}

async function markProcessed(product) {
  await setMetafield(product.id, 'last_processed_updated_at', product.updated_at);
}

async function processProduct(prod, source='unknown') {
  try {
    if (await alreadyProcessed(prod)) {
      log.debug({ id: prod.id }, 'Skip (already processed)');
      return;
    }

    const ai = await aiCategorizeAndSeo(prod);
    const existingTags = (prod.tags || '').split(',').map(t=>t.trim()).filter(Boolean);
    const aiTags = (ai.ai_tags || '').split(',').map(t=>t.trim()).filter(Boolean);
    const mergedTags = Array.from(new Set([...existingTags, ...aiTags])).slice(0, 25);

    const currentSeo = prod.metafields_global_title_tag || '';
    const currentDesc = prod.metafields_global_description_tag || '';
    const t = (ai.seo_title || '').slice(0, 70);
    const d = (ai.seo_description || '').slice(0, 320);

    const needsSeoTitle = !currentSeo || currentSeo.length < 40;
    const needsSeoDesc  = !currentDesc || currentDesc.length < 80;

    await updateProduct(prod.id, {
      product_type: ai.category_path || prod.product_type || '',
      tags: mergedTags.join(', '),
      metafields_global_title_tag: needsSeoTitle ? t : currentSeo,
      metafields_global_description_tag: needsSeoDesc ? d : currentDesc
    });

    await setMetafield(prod.id, 'category_path', ai.category_path);
    await setMetafield(prod.id, 'ai_tags', mergedTags.join(', '));
    await setMetafield(prod.id, 'lang', LANG);
    await setMetafield(prod.id, 'source', source);
    if (needsSeoTitle) await setMetafield(prod.id, 'seo_title', t);
    if (needsSeoDesc)  await setMetafield(prod.id, 'seo_description', d);

    await markProcessed(prod);
    log.info({ id: prod.id }, 'Processed');
  } catch (e) {
    log.error({ id: prod?.id, err: e?.response?.data || e.message }, 'Process error');
  }
}

// === App ===
const app = express();
app.use((req, res, next) => {
  if (req.headers['x-shopify-topic']) {
    getRawBody(req).then(buf => { req.rawBody = buf; next(); }).catch(next);
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
  try {
    const products = await getAllProducts({ since });
    for (const p of products) { await processProduct(p, 'backfill'); }
  } catch (e) { log.error(e); }
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
