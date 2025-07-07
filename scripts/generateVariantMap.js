import fs from 'fs/promises';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const { SHOPIFY_STORE, SHOPIFY_PASSWORD, PRINTIFY_API_KEY, PRINTIFY_SHOP_ID } = process.env;

if (!SHOPIFY_STORE || !SHOPIFY_PASSWORD || !PRINTIFY_API_KEY || !PRINTIFY_SHOP_ID) {
  throw new Error('Missing required environment variables.');
}

async function fetchShopifyProducts() {
  const res = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json`, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_PASSWORD,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  const json = await res.json();
  return json.products;
}

async function fetchPrintifyProducts() {
  const res = await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json`, {
    headers: {
      Authorization: `Bearer ${PRINTIFY_API_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Printify API error: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.data) ? json.data : json;
}

export async function generateMap() {
  const shopifyProducts = await fetchShopifyProducts();
  const printifyProducts = await fetchPrintifyProducts();

  const variantMap = {};

  for (const sProduct of shopifyProducts) {
    if (sProduct.status !== 'active') continue;

    for (const sVariant of sProduct.variants) {
      const sTitle = sProduct.title?.trim().toLowerCase();
      const sVariantId = sVariant.id.toString();

      const matchingPrintify = printifyProducts.find(p => {
        const pTitle = p.title?.trim().toLowerCase();
        return pTitle === sTitle;
      });

      if (matchingPrintify) {
        const pVariant = matchingPrintify.variants?.[0];
        if (pVariant?.id) {
          variantMap[sVariantId] = pVariant.id;
        }
      } else {
        console.warn(`❌ No Printify match for Shopify product "${sProduct.title}"`);
      }
    }
  }

  const json = JSON.stringify(variantMap, null, 2);
  await fs.writeFile('./variant-map.json', json);
  console.log(`✅ Generated variant-map.json with ${Object.keys(variantMap).length} entries`);
  return variantMap;
}

if (process.argv[1].endsWith('generateVariantMap.js')) {
  generateMap().catch(err => {
    console.error('❌ Error generating variant map:', err);
  });
}
