# Shopify Auto Categorizer (Custom App)

Bu küçük uygulama, **Shopify mağazana eklenen her yeni ürünü** otomatik olarak bir **Shopify Standard Product Type** (kategori) ile etiketler ve gerekirse ek **tag**'ler ekler.

## Ne yapar?
- `products/create` webhook'unu dinler.
- Ürünün başlık/açıklamasına göre **kategori tahmini** yapar.
- Shopify Admin API ile `standard_product_type` alanını günceller, tag ekler.
- İstersen **OpenAI** anahtarı vererek AI destekli sınıflandırmayı açabilirsin.
- 28.000+ mevcut ürün için `npm run backfill` ile **geriye dönük** toplu güncelleme yapabilirsin.

## Kurulum
1. **Yeni Özel Uygulama (Custom App) oluştur**: Shopify Admin → Settings → Apps and sales channels → Develop apps → Create app.
2. **API erişimi (Admin API scopes)**: En azından `read_products`, `write_products` yetkileri ver.
3. **Access Token**'ı kopyala ve `.env` dosyasına koy.
4. Webhook Secret (App signing secret) değerini de `.env` içine koy.
5. Bu projeyi bir sunucuya (Vercel, Render, Fly.io, Railway, kendi VPS) deploy et.
6. `.env` dosyası örneği için `.env.example`'a bak.

## Webhook ayarı
- Shopify Admin → Settings → Notifications → Webhooks → **Products/create** → URL: `https://SUNUCUN/webhooks/shopify/products`
- Format: JSON
- Secret: Uygulama sekretin (HMAC doğrulaması için).

## Çalıştırma
```bash
npm install
cp .env.example .env  # değerleri doldur
npm run dev           # localhost:3000
```
Geriye dönük güncelleme (28k ürün için parça parça işler):
```bash
npm run backfill
```

## Kendi kuralların
- `mapping.json` içindeki `rules` alanına **anahtar kelime → kategori** eşleşmelerini ekle.
- AI kullanmak istersen `.env` içine `OPENAI_API_KEY` koy – kuralları bulamazsa AI'ye sorar.

## Notlar
- `standard_product_type` alanı **Shopify taksonomisi** ile uyumludur (ör: `Health & Beauty > Personal Care > Skin Care`).
- Otomatik koleksiyon kurmak istersen, tag’leri kullanıp Shopify’da **Automated Collection** kuralları ile sınıflandırabilirsin.
- Büyük kataloglarda API limitlerini gözetmek için işleme arası gecikme eklemek gerekebilir.
