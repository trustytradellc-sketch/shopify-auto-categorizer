// server.js - Hamza için “tam yetkili” AI kategorilendirme + SEO servisi
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import Bottleneck from 'bottleneck';
import Database from 'better-sqlite3';
import { OpenAI } from 'openai';
import pino from 'pino';

// ====== ENV ======
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
  console.error('ENV eksik: OPENAI_API_KEY / SHOPIFY_ACCESS_TOKEN / SHOPIFY_SHOP zorunlu.');
  process.exit(1);
}

// ====== LOG ======
const log = pino({
  level: NODE_ENV === 'development' ? 'debug' : 'info',
  transport: NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined
});

// ====== DB (idempotency, checkpoints) ======
const db = new Database('./data.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS processed (id TEXT PRIMARY KEY, updated_at TEXT, reason TEXT);
CREATE TABLE IF NOT EXISTS checkpoints (key TEXT PRIMARY KEY, val TEXT);
`);
const setCheckpoint = db.prepare('REPLACE INTO checkpoints(key,val) VALUES(?,?)');
const getCheckpoint = db.prepare('SELECT val FROM checkpoints WHERE key=?');

// ====== Shopify helpers ======
const SHOPIFY_ADMIN = `https://${SHOPIFY_SHOP}/admin/api/2024-07`;
const shopify = axios.create({
  baseURL: SHOPIFY_ADMIN,
  headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' }
});
const limiter = new Bottleneck({ minTime: 400, maxConcurrent: 1 }); // 2.5 req/sn

async function shopifyCall(fn, ...args) {
  return limiter.schedule(async () => {
    try {
      return await fn(...args);
    } catch (err) {
      const r = err.response;
      if (r && (r.status === 429 || r.status >= 500)) {
        const retry = Number(r.headers['retry-after'] || 2);
        log.warn({ status: r.status }, `Shopify retrying in ${retry}s`);
        await new Promise(res => setTimeout(res, retry * 1000));
        return await fn(...args);
      }
      throw err;
    }
  });
}

async function getAllProducts({ since } = {}) {
  const items = [];
  let pageInfo = null;
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

async function setMetafields(productId, metafields) {
  // upsert metafields (namespace: auto_ai)
  for (const mf of metafields) {
    await shopifyCall(() =>
      shopify.post(`/metafields.json`, {
        metafield: {
          owner_id: productId,
          owner_resource: 'product',
          namespace: 'auto_ai',
          key: mf.key,
          type: mf.type || 'single_line_text_field',
          value: mf.value
        }
      })
    ).catch(async (e) => {
      // Try update if exists
      const existing = await shopify.get(`/products/${productId}/metafields.json?namespace=auto_ai&key=${mf.key}`).then(r=>r.data.metafields[0]).catch(()=>null);
      if (existing) {
        await shopify.put(`/metafields/${existing.id}.json`, { metafield: { id: existing.id, value: mf.value } });
      } else {
        throw e;
      }
    });
  }
}

// ====== HMAC verify for webhooks ======
function verifyShopifyHmac(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const digest = crypto.createHmac('sha256', SHOPIFY_APP_WEBHOOK_SECRET)
    .update(req.rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hmac || ''), Buffer.from(digest));
}

// ====== OpenAI categorizer & SEO ======
const openai = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: Number(OPENAI_API_TIMEOUT) * 1000 });

const SYSTEM = `
You are a senior US e-commerce merchandiser + SEO expert. 
Task: Given a Shopify product, output:
- "category_path": a > separated path (e.g., "Beauty > Fragrance > Women's Perfume")
- "ai_tags": 5-12 concise tags (comma separated, no '#')
- "seo_title": 58-62 chars, includes brand and key attribute
- "seo_description": 140-155 chars, benefit-led, no quotes
- "lang": keep in English unless LANG is 'tr', then Turkish.
Return strict JSON with these keys.
Prefer existing Shopify standard taxonomy if obvious.
`;

async function aiCategorizeAndSeo(prod) {
  const lang = LANG.toLowerCase();
  const bodyText = (prod.body_html || '').replace(/<[^>]+>/g, ' ').slice(0, 2000);
  const prompt = `
LANG: ${lang}
Product:
- Title: ${prod.title || ''}
- Vendor/Brand: ${prod.vendor || ''}
- Tags: ${(prod.tags || '').toString()}
- Type: ${prod.product_type || ''}
- Options: ${prod.options?.map(o=>`${o.name}:${o.values?.slice(0,5).join('/')}`).join(', ') || ''}
- Variants(excerpt): ${prod.variants?.slice(0,3).map(v=>`${v.title} | ${v.option1||''} ${v.option2||''} ${v.option3||''}`).join(' ; ') || ''}
- Body: ${bodyText}

IMPORTANT: Respond ONLY with compact JSON: {"category_path":"","ai_tags":"","seo_title":"","seo_description":""}
`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt }
    ]
  });
  let txt = resp.choices[0].message.content || '{}';
  // try to parse json safely
  const match = txt.match(/\{[\s\S]*\}$/);
  const json = match ? match[0] : txt;
  const out = JSON.parse(json);
  return out;
}

// ====== Core processing ======
async function alreadyProcessed(pid, updatedAt) {
  const row = db.prepare('SELECT updated_at FROM processed WHERE id=?').get(pid);
  if (!row) return false;
  return row.updated_at === updatedAt;
}

function markProcessed(pid, updatedAt, reason='ok') {
  db.prepare('REPLACE INTO processed(id,updated_at,reason) VALUES(?,?,?)').run(pid, updatedAt, reason);
}

async function processProduct(prod, source='unknown') {
  try {
    if (await alreadyProcessed(String(prod.id), prod.updated_at)) {
      log.debug({ id: prod.id }, 'Skip (idempotent)');
      return;
    }

    const ai = await aiCategorizeAndSeo(prod);

    // merge tags
    const existingTags = (prod.tags || '').split(',').map(t=>t.trim()).filter(Boolean);
    const aiTags = (ai.ai_tags || '').split(',').map(t=>t.trim()).filter(Boolean);
    const mergedTags = Array.from(new Set([...existingTags, ...aiTags])).slice(0, 25);

    // product_type / seo
    const payload = {
      product_type: ai.category_path || prod.product_type || '',
      tags: mergedTags.join(', '),
      // SEO: only set if weak or empty
      title: prod.title, // title bırak
      body_html: prod.body_html
    };

    const currentSeo = prod.metafields_global_title_tag || '';
    const currentDesc = prod.metafields_global_description_tag || '';
    const t = (ai.seo_title || '').slice(0, 70);
    const d = (ai.seo_description || '').slice(0, 320);

    const needsSeoTitle = !currentSeo || currentSeo.length < 40;
    const needsSeoDesc  = !currentDesc || currentDesc.length < 80;

    const metafields = [
      { key: 'category_path', value: ai.category_path },
      { key: 'ai_tags', value: mergedTags.join(', ') },
      { key: 'source', value: source },
      { key: 'lang', value: LANG }
    ];

    if (needsSeoTitle) metafields.push({ key: 'seo_title', value: t });
    if (needsSeoDesc)  metafields.push({ key: 'seo_description', value: d });

    await updateProduct(prod.id, {
      product_type: payload.product_type,
      tags: payload.tags,
      metafields_global_title_tag: needsSeoTitle ? t : currentSeo,
      metafields_global_description_tag: needsSeoDesc ? d : currentDesc
    });

    await setMetafields(prod.id, metafields);

    markProcessed(String(prod.id), prod.updated_at);
    log.info({ id: prod.id }, 'Processed');
  } catch (e) {
    log.error({ id: prod?.id, err: e?.response?.data || e.message }, 'Process error');
    markProcessed(String(prod.id), prod.updated_at, 'error');
  }
}

// ====== Express app ======
const app = express();

// keep raw body for webhook verify
app.use((req, res, next) => {
  if (req.headers['x-shopify-topic']) {
    getRawBody(req).then(buf => { req.rawBody = buf; next(); }).catch(next);
  } else {
    express.json({ limit: '2mb' })(req, res, next);
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Manual backfill trigger (protect with token)
app.post('/backfill', express.json(), async (req, res) => {
  if (!BACKFILL_TOKEN || req.get('X-Backfill-Token') !== BACKFILL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const since = req.query.since || getCheckpoint.get('since')?.val || null;
  res.json({ started: true, since });
  startBackfill(since).catch(e=>log.error(e, 'backfill error'));
});

// Webhooks
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

// ====== Backfill runner ======
async function startBackfill(since) {
  log.info({ since }, 'Backfill started');
  const products = await getAllProducts({ since });
  for (const p of products) {
    await processProduct(p, 'backfill');
    setCheckpoint.run('since', new Date().toISOString());
  }
  log.info('Backfill completed');
}

// ====== Startup ======
app.listen(PORT, () => {
  log.info(`AI Categorizer running on :${PORT}`);
  // Optional: auto backfill on boot (first run)
  const bootSince = getCheckpoint.get('since')?.val || null;
  if (!bootSince) {
    log.info('First boot: running initial backfill (all products)');
    startBackfill(null).catch(e => log.error(e));
  }
});
