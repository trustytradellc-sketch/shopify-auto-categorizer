# Shopify Auto Categorizer (Custom App)

Bu küçük uygulama, **Shopify mağazana eklenen her yeni ürünü** otomatik olarak bir **Shopify Standard Product Type** (kategori) ile etiketler ve gerekirse ek **tag**'ler ekler.

## Ne yapar?
- `products/create` ve `products/update` webhook'larını dinler.
- Ürünün başlık/açıklamasına göre **kural tabanlı** kategoriyi bulur; düşük güven skorunda **OpenAI**'dan destek ister.
- Shopify Admin API ile `standard_product_type` ve `product_type` alanlarını günceller, yeni tag'ler ekler, SEO başlık/açıklamalarını doldurur.
- 40.000+ ürünlük kataloglarda hız limiti gözeterek çalışır (tek iş parçacığı + yeniden deneme mekanizması).
- İstersen **OpenAI** anahtarı vererek hibrit modu açabilirsin; anahtar yoksa sadece kurallar çalışır.
- Tüm mevcut ürünleri `npm run backfill` komutuyla **geriye dönük** olarak düzeltebilirsin.
- Telefonundan ya da ChatGPT Action üzerinden doğal dilde komut vererek kategorileri, SEO metinlerini ve kural haritasını yönetebilirsin (`/commands` endpoint'i).

## Kurulum
1. **Yeni Özel Uygulama (Custom App) oluştur**: Shopify Admin → Settings → Apps and sales channels → Develop apps → Create app.
2. **API erişimi (Admin API scopes)**: En azından `read_products`, `write_products` yetkileri ver.
3. **Access Token**'ı kopyala ve `.env` dosyasına koy (`SHOPIFY_ACCESS_TOKEN`).
4. Webhook Secret (App signing secret) değerini de `.env` içine koy (`SHOPIFY_APP_WEBHOOK_SECRET`).
5. OpenAI kullanacaksan `OPENAI_API_KEY` ekle (opsiyonel).
6. Uzaktan komutları güvene almak için `COMMAND_TOKEN` oluştur.
7. Toplu iş tetiklemek için `BACKFILL_TOKEN` oluştur (opsiyonel, REST endpoint'i korur).
8. Bu projeyi bir sunucuya (Vercel, Render, Fly.io, Railway, kendi VPS) deploy et.
9. `.env` dosyası örneği için `.env.example`'a bak.

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
Geriye dönük güncelleme (komut `scripts/backfill.js` ile aynı mantığı paylaşır):
```bash
# tüm ürünler
npm run backfill

# belirli tarihten itibaren güncellenen ürünler
npm run backfill -- --since=2024-01-01T00:00:00-05:00

# sadece sonuçları görmek, Shopify'a yazmamak için
npm run backfill -- --dry-run
```

### Uzaktan komut merkezi (`/commands`)

- Endpoint: `POST /commands`
- Header: `X-Command-Token: <COMMAND_TOKEN>` (ya da body içinde `{"token":"..."}`)
- Body seçenekleri:
  - Doğrudan JSON komutları

    ```json
    {
      "commands": [
        { "action": "reprocess_product", "params": { "id": 123456789 } },
        {
          "action": "manual_set",
          "params": {
            "id": 123456789,
            "category_path": "Beauty > Skincare > Face Serums",
            "tags": ["vitamin c", "brightening"],
            "seo_title": "TrustyTrade Vitamin C Brightening Serum"
          }
        }
      ]
    }
    ```

  - Ya da doğal dil komutu (OpenAI anahtarın varsa):

    ```json
    {
      "prompt": "Reprocess the last serum we imported and move it into Beauty > Skincare > Face Serums with brightening tags"
    }
    ```

Desteklenen aksiyonlar:

| Action | Açıklama |
| --- | --- |
| `backfill` | Tüm ürünleri sırayla işler (opsiyonel `since`, `limit`). Asenkron job olarak kuyruğa alınır, `job_status` ile takip et. |
| `reprocess_product` | Tek ürünü yeniden kategorize eder (OpenAI + kurallar). |
| `manual_set` | Ürünün kategori/tag/SEO değerlerini elle belirler, gerekirse açıklamayı (`body_html`) günceller. |
| `update_seo` | Sadece SEO başlığı/açıklaması ve/veya ürün açıklamasını günceller. |
| `preview` | Ürünü güncellemeden kategori + SEO önerisi döndürür. |
| `list_rules` | Aktif kural haritasını görüntüler (opsiyonel `limit`). |
| `add_rule` / `remove_rule` | `mapping.json` içindeki kuralları uzaktan günceller ve belleği yeniler. |
| `refresh_rules` | `mapping.json` dosyasını diskten yeniden yükler. |
| `job_status` / `list_jobs` | Asenkron backfill işlerinin durumunu görüntüler. |

> ChatGPT Actions: `POST /commands` endpoint'ini Action olarak tanımlayıp `COMMAND_TOKEN` header'ı ekleyerek doğrudan sohbet içinden "Ürün 12345'i serum kategorisine taşı" gibi komutlar verebilirsin.

## Kendi kuralların
- `mapping.json` içindeki `rules` alanına **anahtar kelime → kategori** eşleşmelerini ekle. `keywords` dizisi OR (veya) mantığında çalışır; istersen `regex` alanıyla gelişmiş ifade yazabilirsin.
- Kategori yolunu Shopify taksonomisine göre yaz (örn. `Beauty > Skincare > Face Serums`).
- `tags` alanıyla kategoriye özel ekstra tag'ler üretebilirsin; sistem ayrıca marka + ürün başlığından akıllı tag türetir.
- AI kullanmak istersen `.env` içine `OPENAI_API_KEY` koy – kuralın güven skoru düşükse OpenAI'dan yeni kategori/SEO isteyip sonucu harmanlar.

## Notlar
- `standard_product_type` alanı **Shopify taksonomisi** ile uyumludur (ör: `Health & Beauty > Personal Care > Skin Care`).
- Otomatik koleksiyon kurmak istersen, tag’leri kullanıp Shopify’da **Automated Collection** kuralları ile sınıflandırabilirsin.
- Büyük kataloglarda API limitlerini gözetmek için istekler Bottleneck ile otomatik yavaşlatılır (varsayılan 400ms). Gerekirse `lib/shopify.js` içinde `minTime` değerini güncelle.
- Sınıflandırma çıktıları `auto_ai` namespace'i altında metafield olarak saklanır; Shopify içinde raporlamak için bu metafield'ları kullanabilirsin.
- `COMMAND_TOKEN` ile korunan komut endpoint'i sayesinde ChatGPT / cep telefonu gibi herhangi bir istemciden güvenli şekilde talimat verebilirsin.
