import { loadMapping } from './mapping.js';

const DEFAULT_FALLBACK = 'Miscellaneous';

const STOPWORDS = new Set(['the', 'and', 'with', 'for', 'gift', 'size', 'set', 'kit', 'new']);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRules() {
  const mapping = loadMapping();
  const fallback = mapping.fallback_category || DEFAULT_FALLBACK;
  const rules = (mapping.rules || []).map(rule => {
    const keywords = (rule.keywords || []).filter(Boolean);
    const pattern = rule.regex
      ? new RegExp(rule.regex, 'i')
      : keywords.length
        ? new RegExp(keywords.map(escapeRegex).join('|'), 'i')
        : /.*/i;
    return {
      name: rule.name || rule.category,
      pattern,
      category: rule.category,
      tags: rule.tags || [],
      confidence: rule.confidence || 0.92
    };
  });
  return { rules, fallback };
}

function normalizeText(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(str) {
  return str
    .toLowerCase()
    .split(/[^a-z0-9&]+/)
    .map(t => t.trim())
    .filter(t => t && !STOPWORDS.has(t));
}

function buildSeo(product, category) {
  const brand = (product.vendor || '').trim() || 'Brand';
  const title = normalizeText(product.title || '');
  const core = title.slice(0, 80) || category.split('>').pop().trim();
  const baseTitle = `${brand} ${core}`.trim();
  const seoTitle = baseTitle.length > 62 ? `${baseTitle.slice(0, 59).trim()}…` : baseTitle;
  const leaf = category.split('>').pop().trim();
  const description = `Discover ${core} from ${brand}. Shop authentic ${leaf.toLowerCase()} with fast shipping and easy returns.`;
  const seoDescription = description.length > 155 ? `${description.slice(0, 152).trim()}…` : description;
  return { brand, core, seoTitle, seoDescription };
}

function composeTags(product, category, extraTags = []) {
  const { brand, core } = buildSeo(product, category);
  const tokens = tokenize(core).slice(0, 10);
  const leaf = category.split('>').pop().trim();
  const candidates = [brand, leaf, ...extraTags, ...tokens];
  const unique = [];
  for (const tag of candidates) {
    const value = (tag || '').toString().trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    if (unique.some(t => t.toLowerCase() === lower)) continue;
    unique.push(value);
  }
  return unique.slice(0, 12);
}

export function ruleBasedCategorize(product) {
  const { rules, fallback } = buildRules();
  const haystack = `${normalizeText(product.title)} ${normalizeText(product.vendor)} ${normalizeText(product.body_html)}`.toLowerCase();
  for (const rule of rules) {
    if (rule.pattern.test(haystack)) {
      return finalizeResult(product, {
        category_path: rule.category,
        tags: rule.tags,
        confidence: rule.confidence,
        method: 'rules'
      });
    }
  }
  return finalizeResult(product, {
    category_path: fallback,
    tags: [],
    confidence: 0.4,
    method: 'fallback'
  });
}

function finalizeResult(product, result) {
  const category = result.category_path || DEFAULT_FALLBACK;
  const extras = Array.isArray(result.tags)
    ? result.tags
    : typeof result.tags === 'string'
      ? result.tags.split(',').map(t => t.trim()).filter(Boolean)
      : [];
  const tags = composeTags(product, category, extras);
  const { seoTitle, seoDescription } = buildSeo(product, category);
  return {
    category_path: category,
    tags,
    seo_title: result.seo_title || seoTitle,
    seo_description: result.seo_description || seoDescription,
    confidence: result.confidence ?? 0.8,
    method: result.method || 'rules'
  };
}

async function askOpenAI(product, ruleGuess, { lang, openai, logger }) {
  if (!openai) return null;
  const bodyText = normalizeText(product.body_html || '').slice(0, 2000);
  const prompt = `LANG: ${lang}
Rule category guess: ${ruleGuess.category_path}

Product:
- Title: ${product.title || ''}
- Brand: ${product.vendor || ''}
- Tags: ${(product.tags || '').toString()}
- Type: ${product.product_type || ''}
- Options: ${product.options?.map(o => `${o.name}:${(o.values || []).slice(0,5).join('/')}`).join(', ') || ''}
- Variants: ${(product.variants || []).slice(0,3).map(v => v.title).join(' ; ') || ''}
- Body: ${bodyText}

If rule category looks correct, keep it. Otherwise, suggest better.
Return JSON only with category_path, ai_tags (array or comma string), seo_title, seo_description.`;

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are a senior US e-commerce merchandiser and SEO specialist. Given a Shopify product, respond with JSON only.'
        },
        { role: 'user', content: prompt }
      ]
    });
    const message = resp.choices?.[0]?.message?.content || '{}';
    const jsonText = (message.match(/\{[\s\S]*\}/) || [message])[0];
    const parsed = JSON.parse(jsonText);
    const category = parsed.category_path || parsed.category || ruleGuess.category_path;
    const tags = Array.isArray(parsed.ai_tags)
      ? parsed.ai_tags
      : typeof parsed.ai_tags === 'string'
        ? parsed.ai_tags.split(',').map(t => t.trim()).filter(Boolean)
        : [];
    return {
      category_path: category,
      tags: tags.length ? tags : ruleGuess.tags,
      seo_title: parsed.seo_title || ruleGuess.seo_title,
      seo_description: parsed.seo_description || ruleGuess.seo_description,
      confidence: parsed.confidence || 0.85,
      method: 'openai'
    };
  } catch (error) {
    logger?.warn({ err: error?.response?.data || error?.message }, 'OpenAI fallback failed');
    return null;
  }
}

export function createCategorizer({ lang = 'en', openai, logger } = {}) {
  return {
    async categorize(product) {
      const ruleGuess = ruleBasedCategorize(product);
      if (!openai || ruleGuess.confidence >= 0.8) {
        return ruleGuess;
      }
      const ai = await askOpenAI(product, ruleGuess, { lang, openai, logger });
      return ai ? finalizeResult(product, ai) : ruleGuess;
    }
  };
}
