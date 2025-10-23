import { LANG, openai } from './config.js';

const CATEGORY_RULES = [
  { re: /(perfume|parfum|fragrance|eau de parfum|eau de toilette|cologne|body mist)/i, path: "Beauty > Fragrance > Women's Perfume", score: 0.92 },
  { re: /(aftershave|men's cologne|eau de cologne)/i, path: "Beauty > Fragrance > Men's Cologne", score: 0.9 },
  { re: /(serum|retinol|vitamin\s*c|peptide|hyaluronic|ampoule|essence|niacinamide)/i, path: "Beauty > Skincare > Face Serums", score: 0.92 },
  { re: /(cream|moisturizer|hydrating|gel cream|face cream|night cream|day cream)/i, path: "Beauty > Skincare > Face Moisturizers", score: 0.9 },
  { re: /(cleanser|face wash|cleansing balm|micellar water)/i, path: "Beauty > Skincare > Cleansers", score: 0.9 },
  { re: /(mask|sheet mask|clay mask|mud mask|peel off mask)/i, path: "Beauty > Skincare > Face Masks", score: 0.9 },
  { re: /(sunscreen|spf\s*\d+|sun cream|sunblock)/i, path: "Beauty > Skincare > Sunscreens", score: 0.9 },
  { re: /(toner|lotion|facial mist)/i, path: "Beauty > Skincare > Toners", score: 0.85 },
  { re: /(eye cream|eye serum|eye gel|dark circle)/i, path: "Beauty > Skincare > Eye Treatments", score: 0.88 },
  { re: /(lip balm|lip mask|lip treatment)/i, path: "Beauty > Skincare > Lip Care", score: 0.85 },
  { re: /(body wash|body scrub|bath gel|shower gel|body lotion|body butter)/i, path: "Beauty > Bath & Body > Body Care", score: 0.85 },
  { re: /(shampoo|conditioner|hair mask|hair oil|leave-in|styling cream|hair spray)/i, path: "Beauty > Hair Care > Shampoo & Treatments", score: 0.9 },
  { re: /(hair tool|flat iron|curling iron|hair dryer|styler|straightener)/i, path: "Beauty > Hair Care > Styling Tools", score: 0.85 },
  { re: /(lipstick|lip gloss|lip stain)/i, path: "Beauty > Makeup > Lips", score: 0.9 },
  { re: /(foundation|concealer|primer|bb cream|cc cream|setting powder|setting spray)/i, path: "Beauty > Makeup > Face", score: 0.9 },
  { re: /(mascara|eyeliner|eyeshadow|brow pencil|brow gel|eye palette)/i, path: "Beauty > Makeup > Eyes", score: 0.9 },
  { re: /(nail polish|nail lacquer|gel polish|nail kit)/i, path: "Beauty > Nail Care > Nail Polish", score: 0.85 },
  { re: /(supplement|vitamin|collagen|probiotic|gummy|omega|capsule)/i, path: "Health & Wellness > Vitamins & Supplements", score: 0.82 },
  { re: /(facial device|cleansing brush|microcurrent|derma|skin device)/i, path: "Beauty > Skincare Tools", score: 0.82 },
  { re: /(candle|scented candle|diffuser|reed diffuser|wax melt)/i, path: "Home & Kitchen > Home Fragrance > Candles", score: 0.85 },
  { re: /(filter|everydrop|water filter|cartridge|replacement filter)/i, path: "Appliances > Water Filters & Filtration Systems > Water Filter Cartridges", score: 0.9 },
  { re: /(earring|necklace|bracelet|ring|jewelry)/i, path: "Apparel & Accessories > Jewelry > Fashion Jewelry", score: 0.85 },
  { re: /(watch|chronograph|timepiece)/i, path: "Apparel & Accessories > Jewelry > Watches", score: 0.82 },
  { re: /(toy|doll|lego|puzzle|playset|building set)/i, path: "Toys & Games > Learning & Education", score: 0.8 },
  { re: /(home decor|decor|vase|wall art|clock|resin art)/i, path: "Home & Garden > Decor", score: 0.8 },
  { re: /(kitchen|cookware|pan|pot|appliance|blender|mixer|air fryer)/i, path: "Home & Kitchen > Kitchen & Dining", score: 0.78 },
  { re: /(pet|dog|cat|pet toy|pet food|pet treat)/i, path: "Pet Supplies > General", score: 0.75 },
  { re: /(baby|infant|toddler|stroller|crib|baby toy)/i, path: "Baby & Toddler > Nursery & Essentials", score: 0.75 },
  { re: /(fitness|yoga|exercise|dumbbell|workout|gym)/i, path: "Sports & Outdoors > Exercise & Fitness", score: 0.75 },
  { re: /(automotive|car part|gauge|accessory|tire)/i, path: "Automotive > Replacement Parts & Accessories", score: 0.72 },
  { re: /(electronics|headphone|earbuds|speaker|charger|camera)/i, path: "Electronics > Electronics Accessories", score: 0.72 },
  { re: /.*/i, path: "Miscellaneous", score: 0.3 }
];

function cleanText(value) {
  return (value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildTags(product, path) {
  const brand = product.vendor || 'Brand';
  const titleTokens = cleanText(product.title)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  const categoryLeaf = path.split('>').pop().trim().toLowerCase();
  const tags = new Set([brand, categoryLeaf]);
  for (const token of titleTokens.slice(0, 10)) tags.add(token);
  return Array.from(tags).filter(Boolean).slice(0, 12).join(', ');
}

function ruleBasedCategorize(product) {
  const text = `${product.title || ''} ${product.vendor || ''} ${cleanText(product.body_html)}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) {
      const brand = product.vendor || 'Brand';
      const core = cleanText(product.title).slice(0, 60);
      const tags = buildTags(product, rule.path);
      const seoTitle = `${brand} ${core}`.trim().slice(0, 62);
      const seoDescription = `Shop ${core} by ${brand} with fast US shipping. Authentic products, easy returns.`.slice(0, 155);
      return {
        category_path: rule.path,
        ai_tags: tags,
        seo_title: seoTitle,
        seo_description: seoDescription,
        score: rule.score ?? 0.8
      };
    }
  }
  return {
    category_path: 'Miscellaneous',
    ai_tags: buildTags(product, 'Miscellaneous'),
    seo_title: '',
    seo_description: '',
    score: 0.2
  };
}

async function aiCategorizeAndSeo(product) {
  const rule = ruleBasedCategorize(product);
  if (rule.score >= 0.8 || !openai) return rule;

  const bodyText = cleanText(product.body_html).slice(0, 2000);
  const prompt = `LANG: ${LANG}\nRule category guess: ${rule.category_path}\n\nProduct:\n- Title: ${product.title || ''}\n- Brand: ${product.vendor || ''}\n- Tags: ${(product.tags || '').toString()}\n- Type: ${product.product_type || ''}\n- Options: ${product.options?.map((o) => `${o.name}:${o.values?.slice(0, 5).join('/')}`).join(', ') || ''}\n- Variants: ${product.variants?.slice(0, 3).map((v) => v.title).join(' ; ') || ''}\n- Body: ${bodyText}\n\nIf rule category looks correct, keep it. Otherwise, suggest better.\nReturn JSON only with category_path, ai_tags, seo_title, seo_description.`;

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are a senior US e-commerce merchandiser and SEO specialist. Given a Shopify product, provide:\n- "category_path" (Amazon-style path)\n- "ai_tags" (comma separated, max 12)\n- "seo_title" (58-62 chars)\n- "seo_description" (140-155 chars)\nAlways output valid JSON only.`
        },
        { role: 'user', content: prompt }
      ]
    });

    const txt = resp.choices[0].message.content || '{}';
    const json = (txt.match(/\{[\s\S]*\}$/) || [txt])[0];
    const ai = JSON.parse(json);
    return {
      category_path: ai.category_path || rule.category_path,
      ai_tags: ai.ai_tags || rule.ai_tags,
      seo_title: ai.seo_title || rule.seo_title,
      seo_description: ai.seo_description || rule.seo_description,
      score: 0.75
    };
  } catch {
    return rule;
  }
}

export { aiCategorizeAndSeo, ruleBasedCategorize };
