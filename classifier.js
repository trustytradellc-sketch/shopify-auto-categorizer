import fs from 'fs'
import path from 'path'
import axios from 'axios'

const mappingPath = path.join(process.cwd(), 'mapping.json')
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'))

/**
 * Simple keyword-based classifier with optional OpenAI assist.
 * @param {object} product Shopify product object
 * @returns {{category: string, tags: string[], confidence: number, method: string}}
 */
export async function classifyProduct(product) {
  const title = (product.title || '').toLowerCase()
  const body = (product.body_html || '').toLowerCase()
  const vendor = (product.vendor || '').toLowerCase()
  const aggregate = `${title} ${stripHtml(body)} ${vendor}`

  // 1) keyword rules
  for (const rule of mapping.rules) {
    const hit = rule.keywords.some(k => aggregate.includes(k.toLowerCase()))
    if (hit) {
      return { category: rule.category, tags: rule.tags || [], confidence: 0.85, method: 'rules' }
    }
  }

  // 2) Optional OpenAI fallback
  if (process.env.OPENAI_API_KEY) {
    try {
      const prompt = `You are a Shopify product taxonomy assistant. 
Given a product title and description, map it to the closest Shopify Standard Product Type (taxonomy path). 
Return JSON with fields: category (string), tags (array of strings).

Title: ${product.title}
Description: ${stripHtml(product.body_html || '')}

Only respond with JSON.`

      const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }})

      const text = resp.data.choices?.[0]?.message?.content || '{}'
      const guess = JSON.parse(extractJson(text))
      return { category: guess.category || mapping.fallback_category, tags: guess.tags || [], confidence: 0.75, method: 'openai' }
    } catch (e) {
      console.error('OpenAI classify error', e.message)
    }
  }

  // 3) Fallback
  return { category: mapping.fallback_category, tags: [], confidence: 0.2, method: 'fallback' }
}

function stripHtml(html) { return (html || '').replace(/<[^>]*>/g, ' ') }
function extractJson(s) {
  const m = s.match(/\{[\s\S]*\}/)
  return m ? m[0] : '{}'
}
