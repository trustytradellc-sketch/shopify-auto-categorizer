import 'dotenv/config'
import express from 'express'
import bodyParser from 'body-parser'
import crypto from 'crypto'
import axios from 'axios'
import { classifyProduct } from './classifier.js'

const app = express()
const PORT = process.env.PORT || 3000

// raw body for HMAC verification
app.use('/webhooks/shopify/products', bodyParser.raw({ type: 'application/json' }))

app.get('/', (_req, res) => res.send('Shopify Auto Categorizer is running'))

app.post('/webhooks/shopify/products', async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    return res.status(401).send('Invalid HMAC')
  }
  try {
    const product = JSON.parse(req.body.toString('utf-8'))
    const result = await classifyProduct(product)
    console.log('Classification:', { id: product.id, title: product.title, ...result })

    // Update product category (standard product type) + tags
    await updateShopifyProduct(product.id, result.category, result.tags)

    res.status(200).send('ok')
  } catch (e) {
    console.error('Webhook error', e)
    res.status(500).send('error')
  }
})

function verifyShopifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256']
  const secret = process.env.SHOPIFY_APP_WEBHOOK_SECRET
  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('base64')
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))
}

async function updateShopifyProduct(productId, standardProductType, extraTags = []) {
  const shop = process.env.SHOPIFY_SHOP
  const token = process.env.SHOPIFY_ACCESS_TOKEN
  const version = process.env.SHOPIFY_API_VERSION || '2024-07'

  // 1) Get existing tags to avoid overwriting
  const prod = await axios.get(`https://${shop}/admin/api/${version}/products/${productId}.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  })
  const currentTags = (prod.data.product.tags || '').split(',').map(s => s.trim()).filter(Boolean)
  const newTags = Array.from(new Set([...currentTags, ...extraTags]))

  // 2) Update via REST (standard_product_type supported on REST)
  const payload = { product: { id: productId, standard_product_type: standardProductType, tags: newTags.join(', ') } }
  await axios.put(`https://${shop}/admin/api/${version}/products/${productId}.json`, payload, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
  })
}

app.listen(PORT, () => console.log(`Auto Categorizer listening on :${PORT}`))
