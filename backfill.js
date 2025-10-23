#!/usr/bin/env node
import { log } from './src/config.js';
import { getAllProducts } from './src/shopify.js';
import { processProduct } from './src/processor.js';

function parseArgs(argv) {
  const options = { since: null, limit: null, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith('--since=')) options.since = arg.split('=')[1];
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.split('=')[1]) || null;
    else if (arg === '--dry-run') options.dryRun = true;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  log.info({ options }, 'Starting backfill');

  const products = await getAllProducts({ since: options.since });
  const selected = options.limit ? products.slice(0, options.limit) : products;
  log.info({ total: products.length, selected: selected.length }, 'Fetched products from Shopify');

  if (options.dryRun) {
    log.info('Dry run enabled — no updates will be pushed');
    return;
  }

  let index = 0;
  for (const product of selected) {
    await processProduct(product, 'cli_backfill');
    index += 1;
    if (index % 25 === 0) {
      log.info({ processed: index, remaining: selected.length - index }, 'Backfill progress');
    }
  }

  log.info({ processed: index }, 'Backfill completed');
}

main().catch((error) => {
  log.error({ err: error?.response?.data || error.message }, 'Backfill failed');
  process.exit(1);
});
