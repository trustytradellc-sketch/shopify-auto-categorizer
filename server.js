// server.js - Hamza: Shopify ürünleri için AI + Rule Based Kategorilendirici ve SEO Otomasyonu
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
You are a senior US e-commerce merchandiser and SEO specialist.
Given a Shopify product, provide:
- "category_path" (Amazon-style path)
- "ai_tags" (comma separated, max 12)
- "seo_title" (58-62 chars)
- "seo_description" (140-155 chars)
Always output valid JSON only.
`;

// ==== AMAZON-TARZ GENİŞ KATEGORİ HARİTASI ====
const CATEGORY_RULES = [
  { re: /(perfume|parfum|fragrance|eau de parfum|delina)/i, path: "Beauty > Fragrance > Women's Perfume" },
  { re: /(serum|retinol|vitamin\s*c|peptide|hyaluronic)/i, path: "Beauty > Skincare > Face Serums" },
  { re: /(cream|moisturizer|hydrating|crème|repair)/i, path: "Beauty > Skincare > Face Moisturizers" },
  { re: /(cleanser|face wash)/i, path: "Beauty > Skincare > Cleansers" },
  { re: /(mask|sheet mask|clay mask)/i, path: "Beauty > Skincare > Face Masks" },
  { re: /(sunscreen|spf\s*\d+)/i, path: "Beauty > Skincare > Sunscreens" },
  { re: /(filter|everydrop|water filter|cartridge)/i, path: "Appliances > Water Filters & Cartridges" },
  { re: /(shampoo|conditioner|hair oil|hair mask)/i, path: "Beauty > Hair Care > Shampoo & Treatments" },
  { re: /(lipstick|lip gloss|lip balm)/i, path: "Beauty > Makeup > Lips" },
  { re: /(foundation|concealer|primer)/i, path: "Beauty > Makeup > Face" },
  { re: /(mascara|eyeliner|eyeshadow|brow)/i, path: "Beauty > Makeup > Eyes" },
  { re: /(toy|doll|lego|puzzle)/i, path: "Toys & Games > Learning & Education" },
  { re: /(candle|scented candle)/i, path: "Home & Kitchen > Home Fragrance > Candles" },
  { re: /(earring|necklace|bracelet)/i, path: "Jewelry > Accessories" },
  { re: /(gauge|hararet|temperature gauge)/i, path: "Automotive > Replacement Parts > Gauges" },
  { re: /.*/i, path: "Miscellaneous" }
];

function ruleBasedCategorize(prod) {
  const text = `${prod.title || ''} ${prod.vendor || ''} ${(prod.body_html || '').replace(/<[^>]+>/g, ' ')}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) {
      const brand = prod.vendor || 'Brand';
      const core = (prod.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const tags = Array.from(new Set([
        brand, ...core.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 8),
        rule.path.split('>').pop().trim()
      ])).slice(0, 12).join(', ');
      const seo_title = `${brand} ${core}`.slice(0, 62);
      const seo_description = `Shop ${brand} ${core} with fast US shipping. Authentic product, easy returns.`.slice(0, 155);
      const score = rule.path === 'Miscellaneous' ? 0.3 : 0.9;
      return { category_path: rule.path, ai_tags: tags, seo_title, seo_description, score };
    }
  }
  return { category_path: "Miscellaneous", ai_tags: "", seo_title: "", seo_description: "", score: 0.1 };
}

// ==== Hibrit sınıflandırma ====
async function aiCategorizeAndSeo(prod) {
  const rule = ruleBasedCategorize(prod);
  if (rule.score >= 0.8) return rule;

  const bodyText = (prod.body_html || '').replace(/<[^>]+>/g, ' ').slice(0, 2000);
  const prompt = `
LANG: ${LANG}
Rule category guess: ${rule.category_path}

Product:
- Title: ${prod.title || ''}
- Brand: ${prod.vendor || ''}
- Tags: ${(prod.tags || '').toString()}
- Type: ${prod.product_type || ''}
- Options: ${prod.options?.map(o=>`${o.name}:${o.values?.slice(0,5).join('/')}`).join(', ') || ''}
- Variants: ${prod.variants?.slice(0,3).map(v=>v.title).join(' ; ') || ''}
- Body: ${bodyText}

If rule category looks correct, keep it. Otherwise, suggest better.
Return JSON only with category_path, ai_tags, seo_title, seo_description.
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }]
    });
    const txt = resp.choices[0].message.content || '{}';
    const json = (txt.match(/\{[\s\S]*\}$/) || [txt])[0];
    const ai = JSON.parse(json);
    return {
      category_path: ai.category_path || rule.category_path,
      ai_tags: ai.ai_tags || rule.ai_tags,
      seo_title: ai.seo_title || rule.seo_title,
      seo_description: ai.seo_description || rule.seo_description
    };
  } catch {
    return rule;
  }
}

// ==== İşlem & idempotent ====
async function alreadyProcessed(product) {
  const mf = await getMetafield(product.id, 'last_processed_updated_at');
  return mf && mf.value === product.updated_at;
}
async function markProcessed(product) {
  await setMetafield(product.id, 'last_processed_updated_at', product.updated_at);
}

async function processProduct(prod, source='unknown') {
  try {
    if (await alreadyProcessed(prod)) return;
    const ai = await aiCategorizeAndSeo(prod);

    const existingTags = (prod.tags || '').split(',').map(t=>t.trim()).filter(Boolean);
    const mergedTags = Array.from(new Set([...existingTags, ...(ai.ai_tags||'').split(',').map(t=>t.trim())])).slice(0, 25);

    const currentSeo = prod.metafields_global_title_tag || '';
    const currentDesc = prod.metafields_global_description_tag || '';
    const t = (ai.seo_title || '').slice(0, 70);
    const d = (ai.seo_description || '').slice(0, 320);
    const needsSeoTitle = !currentSeo || currentSeo.length < 40;
    const needsSeoDesc  = !currentDesc || currentDesc.length < 80;

    await updateProduct(prod.id, {
      product_type: ai.category_path,
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

// ==== Express ====
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
  if (!BACKFILL_TOKEN || req.get('X-Backfill-Token') !== BACKFILL_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const since = req.query.since || null;
  res.json({ started: true, since });
  const products = await getAllProducts({ since });
  for (const p of products) await processProduct(p, 'backfill');
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
