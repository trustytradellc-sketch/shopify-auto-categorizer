export function createProductProcessor({ shopify, categorizer, lang = 'en', logger }) {
  if (!shopify) throw new Error('shopify service required');
  if (!categorizer) throw new Error('categorizer required');

  async function alreadyProcessed(product) {
    const metafield = await shopify.getMetafield(product.id, 'last_processed_updated_at');
    return metafield && metafield.value === product.updated_at;
  }

  async function markProcessed(product) {
    await shopify.setMetafield(product.id, 'last_processed_updated_at', product.updated_at);
  }

  function mergeTags(existing, generated) {
    const normalized = new Set();
    const tags = [];
    for (const tag of [...existing, ...generated]) {
      const value = (tag || '').toString().trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (normalized.has(key)) continue;
      normalized.add(key);
      tags.push(value);
    }
    return tags.slice(0, 25);
  }

  async function processProduct(product, source = 'unknown') {
    try {
      if (!product?.id) return;
      if (await alreadyProcessed(product)) return;

      const classification = await categorizer.categorize(product);
      const existingTags = (product.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      const mergedTags = mergeTags(existingTags, classification.tags || []);

      const currentSeoTitle = product.metafields_global_title_tag || '';
      const currentSeoDescription = product.metafields_global_description_tag || '';
      const nextSeoTitle = (classification.seo_title || '').slice(0, 70);
      const nextSeoDescription = (classification.seo_description || '').slice(0, 320);

      const needsSeoTitle = !currentSeoTitle || currentSeoTitle.length < 40;
      const needsSeoDescription = !currentSeoDescription || currentSeoDescription.length < 80;

      await shopify.updateProduct(product.id, {
        product_type: classification.category_path,
        standard_product_type: classification.category_path,
        tags: mergedTags.join(', '),
        metafields_global_title_tag: needsSeoTitle ? nextSeoTitle : currentSeoTitle,
        metafields_global_description_tag: needsSeoDescription ? nextSeoDescription : currentSeoDescription
      });

      await shopify.setMetafield(product.id, 'category_path', classification.category_path);
      await shopify.setMetafield(product.id, 'ai_tags', mergedTags.join(', '));
      await shopify.setMetafield(product.id, 'lang', lang);
      await shopify.setMetafield(product.id, 'source', source);
      await shopify.setMetafield(product.id, 'method', classification.method || 'rules');
      await shopify.setMetafield(product.id, 'confidence', String(classification.confidence ?? ''));
      if (needsSeoTitle) await shopify.setMetafield(product.id, 'seo_title', nextSeoTitle);
      if (needsSeoDescription) await shopify.setMetafield(product.id, 'seo_description', nextSeoDescription);

      await markProcessed(product);
      logger?.info({ id: product.id, method: classification.method }, 'Product processed');
    } catch (error) {
      logger?.error({ id: product?.id, err: error?.response?.data || error?.message }, 'Process error');
    }
  }

  return {
    processProduct,
    alreadyProcessed
  };
}
