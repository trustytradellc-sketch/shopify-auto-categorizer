import axios from 'axios';
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

const missingEnv = ['SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_SHOP']
  .filter((key) => !process.env[key]);

if (missingEnv.length) {
  console.error(`Missing required env vars: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const log = pino({
  level: NODE_ENV === 'development' ? 'debug' : 'info',
  transport: NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined
});

const SHOPIFY_ADMIN = `https://${SHOPIFY_SHOP}/admin/api/2024-07`;

const shopify = axios.create({
  baseURL: SHOPIFY_ADMIN,
  headers: {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json'
  }
});

const limiter = new Bottleneck({ minTime: 400, maxConcurrent: 1 });

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY, timeout: Number(OPENAI_API_TIMEOUT) * 1000 })
  : null;

export {
  PORT,
  NODE_ENV,
  BACKFILL_TOKEN,
  LANG,
  OPENAI_API_KEY,
  SHOPIFY_APP_WEBHOOK_SECRET,
  SHOPIFY_ADMIN,
  shopify,
  limiter,
  openai,
  log
};
