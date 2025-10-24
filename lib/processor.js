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

  function mergeTags(existing, generated, replace = false) {
    const normalized = new Set();
    const tags = [];
    const pool = replace ? generated : [...existing, ...generated];
    for (const tag of pool) {
      const value = (tag || '').toString().trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (normalized.has(key)) continue;
      normalized.add(key);
      tags.push(value);
    }
    return tags.slice(0, 25);
  }

  async function processProduct(product, source = 'unknown', options = {}) {
    try {
      if (!product?.id) return;
      const {
        dryRun = false,
        classification: classificationOverride,
        replaceTags = false,
        replaceSeo = false,
        force = false,
        body_html: bodyOverride
      } = options;

      if (!force && await alreadyProcessed(product)) {
        return { skipped: true, reason: 'already_processed' };
      }

      const classification = classificationOverride || await categorizer.categorize(product);
      const existingTags = (product.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      const mergedTags = mergeTags(existingTags, classification.tags || [], replaceTags);

      const currentSeoTitle = product.metafields_global_title_tag || '';
      const currentSeoDescription = product.metafields_global_description_tag || '';
      const nextSeoTitle = (classification.seo_title || '').slice(0, 70);
      const nextSeoDescription = (classification.seo_description || '').slice(0, 320);

      const wantsSeoTitle = replaceSeo && Boolean(classification.seo_title);
      const wantsSeoDescription = replaceSeo && Boolean(classification.seo_description);
      const needsSeoTitle = wantsSeoTitle || !currentSeoTitle || currentSeoTitle.length < 40;
      const needsSeoDescription = wantsSeoDescription || !currentSeoDescription || currentSeoDescription.length < 80;

      const payload = {
        product_type: classification.category_path,
        standard_product_type: classification.category_path,
        tags: mergedTags.join(', '),
        metafields_global_title_tag: needsSeoTitle ? nextSeoTitle : currentSeoTitle,
        metafields_global_description_tag: needsSeoDescription ? nextSeoDescription : currentSeoDescription
      };

      if (bodyOverride) {
        payload.body_html = bodyOverride;
      }

      if (dryRun) {
        return {
          dryRun: true,
          classification,
          payload,
          tags: mergedTags
        };
      }

      await shopify.updateProduct(product.id, payload);

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
      return { classification, payload, tags: mergedTags };
    } catch (error) {
      logger?.error({ id: product?.id, err: error?.response?.data || error?.message }, 'Process error');
      throw error;
    }
  }

  return {
    processProduct,
    alreadyProcessed
  };
}
