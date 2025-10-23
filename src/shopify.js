import { limiter, shopify, SHOPIFY_ADMIN } from './config.js';

async function shopifyCall(fn, ...args) {
  return limiter.schedule(async () => {
    try {
      return await fn(...args);
    } catch (err) {
      const r = err.response;
      if (r && (r.status === 429 || r.status >= 500)) {
        const retry = Number(r.headers?.['retry-after'] || 2);
        await new Promise((res) => setTimeout(res, retry * 1000));
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
        owner_id: productId,
        owner_resource: 'product',
        namespace: 'auto_ai',
        key,
        type,
        value
      }
    }));
  }
}

export {
  shopifyCall,
  getAllProducts,
  updateProduct,
  getMetafield,
  setMetafield
};
