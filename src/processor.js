import { LANG, log } from './config.js';
import { aiCategorizeAndSeo } from './categorizer.js';
import { getMetafield, setMetafield, updateProduct } from './shopify.js';

async function alreadyProcessed(product) {
  const metafield = await getMetafield(product.id, 'last_processed_updated_at');
  return metafield && metafield.value === product.updated_at;
}

async function markProcessed(product) {
  await setMetafield(product.id, 'last_processed_updated_at', product.updated_at);
}

function mergeTags(existing, aiTags) {
  const existingTags = (existing || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const aiTagList = (aiTags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return Array.from(new Set([...existingTags, ...aiTagList])).slice(0, 25).join(', ');
}

async function processProduct(product, source = 'unknown') {
  try {
    if (await alreadyProcessed(product)) return;

    const ai = await aiCategorizeAndSeo(product);
    const mergedTags = mergeTags(product.tags, ai.ai_tags);

    const currentSeoTitle = product.metafields_global_title_tag || '';
    const currentSeoDescription = product.metafields_global_description_tag || '';
    const nextSeoTitle = (ai.seo_title || '').slice(0, 70);
    const nextSeoDescription = (ai.seo_description || '').slice(0, 320);
    const needsSeoTitle = !currentSeoTitle || currentSeoTitle.length < 40;
    const needsSeoDescription = !currentSeoDescription || currentSeoDescription.length < 80;

    await updateProduct(product.id, {
      product_type: ai.category_path,
      tags: mergedTags,
      metafields_global_title_tag: needsSeoTitle ? nextSeoTitle : currentSeoTitle,
      metafields_global_description_tag: needsSeoDescription ? nextSeoDescription : currentSeoDescription
    });

    await setMetafield(product.id, 'category_path', ai.category_path);
    await setMetafield(product.id, 'ai_tags', mergedTags);
    await setMetafield(product.id, 'lang', LANG);
    await setMetafield(product.id, 'source', source);
    if (needsSeoTitle) await setMetafield(product.id, 'seo_title', nextSeoTitle);
    if (needsSeoDescription) await setMetafield(product.id, 'seo_description', nextSeoDescription);

    await markProcessed(product);
    log.info({ id: product.id, source }, 'Processed product');
  } catch (error) {
    log.error({ id: product?.id, err: error?.response?.data || error.message }, 'Process error');
  }
}

async function processProducts(products, source = 'backfill') {
  for (const product of products) {
    await processProduct(product, source);
  }
}

export {
  processProduct,
  processProducts
};
