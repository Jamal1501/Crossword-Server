// scripts/generateVariantMap.js
import fetch from 'node-fetch';
import fs from 'fs/promises';
import dotenv from 'dotenv';
dotenv.config();

export async function generateMap() {
  const shopify = await fetchShopifyVariants();
  const printify = await fetchPrintifyVariants();

  const map = {};

  for (const s of shopify) {
    if (!s.sku) continue;
    const match = printify.find(p => p.sku === s.sku);
    if (match) {
      map[s.shopifyVariantId] = match.printifyVariantId;
    }
  }

  await fs.writeFile(new URL('../variant-map.json', import.meta.url), JSON.stringify(map, null, 2));
  console.log('✅ Generated variant-map.json');
  return map;
}

async function fetchShopifyVariants() {
  const { SHOPIFY_STORE, SHOPIFY_API_KEY, SHOPIFY_PASSWORD } = process.env;
  const auth = Buffer.from(`${SHOPIFY_API_KEY}:${SHOPIFY_PASSWORD}`).toString('base64');

  const response = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json`, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();
  return data.products.flatMap(p =>
    p.variants.map(v => ({
      shopifyVariantId: v.id.toString(),
      sku: v.sku
    }))
  );
}

async function fetchPrintifyVariants() {
  const { PRINTIFY_SHOP_ID, PRINTIFY_API_KEY } = process.env;

  const response = await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json`, {
    headers: {
      Authorization: `Bearer ${PRINTIFY_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

 const json = await response.json();
const products = Array.isArray(json.data) ? json.data : json;

return products.flatMap(p =>
  p.variants.map(v => ({
    printifyVariantId: v.id,
    sku: v.sku
  }))
);
}
