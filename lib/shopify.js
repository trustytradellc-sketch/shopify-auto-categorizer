import axios from 'axios';
import Bottleneck from 'bottleneck';

export function createShopifyService({ shop, accessToken, apiVersion = '2024-07', logger, minTime = 400 }) {
  if (!shop) throw new Error('SHOPIFY_SHOP missing');
  if (!accessToken) throw new Error('SHOPIFY_ACCESS_TOKEN missing');

  const baseURL = `https://${shop}/admin/api/${apiVersion}`;
  const client = axios.create({
    baseURL,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json'
    }
  });

  const limiter = new Bottleneck({ minTime, maxConcurrent: 1 });

  async function schedule(fn, ...args) {
    return limiter.schedule(async () => {
      try {
        return await fn(...args);
      } catch (err) {
        const response = err.response;
        if (response && (response.status === 429 || response.status >= 500)) {
          const retry = Number(response.headers?.['retry-after'] || 2);
          await new Promise(resolve => setTimeout(resolve, retry * 1000));
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
      const res = await schedule(() => client.get(url));
      items.push(...res.data.products);
      const linkHeader = res.headers.link || '';
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (!match) break;
      url = match[1].replace(baseURL, '');
    }
    return items;
  }

  async function updateProduct(id, payload) {
    return schedule(() => client.put(`/products/${id}.json`, { product: { id, ...payload } }));
  }

  async function getMetafield(productId, key) {
    const res = await schedule(() =>
      client.get(`/products/${productId}/metafields.json?namespace=auto_ai&key=${key}`)
    ).catch(() => null);
    return res?.data?.metafields?.[0] || null;
  }

  async function setMetafield(productId, key, value, type = 'single_line_text_field') {
    const existing = await getMetafield(productId, key);
    if (existing) {
      await schedule(() => client.put(`/metafields/${existing.id}.json`, { metafield: { id: existing.id, value } }));
    } else {
      await schedule(() => client.post('/metafields.json', {
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

  async function deleteMetafield(id) {
    await schedule(() => client.delete(`/metafields/${id}.json`));
  }

  return {
    baseURL,
    client,
    schedule,
    getAllProducts,
    updateProduct,
    getMetafield,
    setMetafield,
    deleteMetafield,
    logger
  };
}
