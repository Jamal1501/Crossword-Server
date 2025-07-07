// scripts/generateVariantMap.js
import fetch from 'node-fetch';
import fs from 'fs/promises';
import dotenv from 'dotenv';
dotenv.config();

export async function generateMap() {
  const shopifyProducts = await fetchShopifyProducts();
  const printifyProducts = await fetchPrintifyProducts();

  const map = {};

  for (const sProduct of shopifyProducts) {
    const shopifyHandle = sProduct.handle?.trim().toLowerCase();
    if (!shopifyHandle) continue;

    const matchingPrintify = printifyProducts.data.find(p => {
      const title = p.title?.trim().toLowerCase();
      return title === shopifyHandle || title === sProduct.title?.trim().toLowerCase();
    });

if (matchingPrintify) {
  map[sProduct.id.toString()] = matchingPrintify.id.toString();
} else {
  console.warn(`❌ No Printify match for Shopify product: "${sProduct.title}" (handle: ${shopifyHandle})`);
}


  }

  await fs.writeFile(new URL('../variant-map.json', import.meta.url), JSON.stringify(map, null, 2));
  console.log(`✅ Generated variant-map.json with ${Object.keys(map).length} entries`);
  return map;
}

async function fetchShopifyProducts() {
  const { SHOPIFY_STORE, SHOPIFY_API_KEY, SHOPIFY_PASSWORD } = process.env;
  const auth = Buffer.from(`${SHOPIFY_API_KEY}:${SHOPIFY_PASSWORD}`).toString('base64');

  const res = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json`, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await res.json();
  return data.products || [];
}

async function fetchPrintifyProducts() {
  const response = await fetch(
    `https://api.printify.com/v1/shops/${process.env.PRINTIFY_STORE_ID}/products.json`,
    { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_TOKEN}` } }
  );

  if (!response.ok) throw new Error(`Printify API error: ${response.status}`);
  
  const json = await response.json();
  console.log('📦 Printify products response:', JSON.stringify(json, null, 2)); // ← Add this
  return json;
}
  const data = await res.json();
  return data || [];
}
