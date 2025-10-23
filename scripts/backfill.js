import 'dotenv/config';
import pino from 'pino';
import { OpenAI } from 'openai';

import { createShopifyService } from '../lib/shopify.js';
import { createCategorizer } from '../lib/categorizer.js';
import { createProductProcessor } from '../lib/processor.js';

const {
  NODE_ENV = 'production',
  LANG = 'en',
  OPENAI_API_KEY,
  OPENAI_API_TIMEOUT = '180',
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_SHOP
} = process.env;

const log = pino({
  level: NODE_ENV === 'development' ? 'debug' : 'info',
  transport: NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined
});

const missingEnv = [];
if (!SHOPIFY_ACCESS_TOKEN) missingEnv.push('SHOPIFY_ACCESS_TOKEN');
if (!SHOPIFY_SHOP) missingEnv.push('SHOPIFY_SHOP');

if (missingEnv.length) {
  log.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY, timeout: Number(OPENAI_API_TIMEOUT) * 1000 })
  : null;

if (!openai) {
  log.warn('OPENAI_API_KEY not set. Running backfill with rule-based classifier only.');
}

const shopify = createShopifyService({
  shop: SHOPIFY_SHOP,
  accessToken: SHOPIFY_ACCESS_TOKEN,
  logger: log
});

const categorizer = createCategorizer({ lang: LANG, openai, logger: log });
const processor = createProductProcessor({ shopify, categorizer, lang: LANG, logger: log });

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  for (const arg of args) {
    if (arg.startsWith('--since=')) {
      options.since = arg.slice('--since='.length);
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

async function run() {
  const { since, dryRun } = parseArgs();
  log.info({ since, dryRun }, 'Starting Shopify backfill');
  const products = await shopify.getAllProducts({ since });
  log.info({ count: products.length }, 'Fetched products');

  let processed = 0;
  for (const product of products) {
    if (dryRun) {
      const classification = await categorizer.categorize(product);
      log.info({ id: product.id, category: classification.category_path, method: classification.method }, 'Dry-run classification');
    } else {
      await processor.processProduct(product, 'backfill-cli');
    }
    processed += 1;
    if (processed % 25 === 0) {
      log.info({ processed, total: products.length }, 'Backfill progress');
    }
  }
  log.info({ processed }, 'Backfill complete');
}

run().catch(err => {
  log.error({ err: err?.message || err }, 'Backfill failed');
  process.exit(1);
});
