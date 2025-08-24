import fs from 'fs/promises';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const { SHOPIFY_STORE, SHOPIFY_PASSWORD, PRINTIFY_API_KEY, PRINTIFY_SHOP_ID } = process.env;

if (!SHOPIFY_STORE || !SHOPIFY_PASSWORD || !PRINTIFY_API_KEY || !PRINTIFY_SHOP_ID) {
  throw new Error('Missing required environment variables.');
}

const norm = (s = '') => s.toString().trim().toLowerCase();

async function fetchShopifyProducts() {
  const res = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json`, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_PASSWORD,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  const json = await res.json();
  return json.products || [];
}

async function fetchPrintifyProducts() {
  const res = await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json`, {
    headers: { Authorization: `Bearer ${PRINTIFY_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Printify API error: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.data) ? json.data : json; // API sometimes returns { data: [...] }
}

export async function generateMap() {
  const [shopifyProducts, printifyProducts] = await Promise.all([
    fetchShopifyProducts(),
    fetchPrintifyProducts(),
  ]);

  // Index Printify products by normalized title
  const pByTitle = new Map();
  for (const p of printifyProducts) pByTitle.set(norm(p.title), p);

  const variantMap = {}; // Shopify LONG variant ID -> Printify variant ID

  for (const sProduct of shopifyProducts) {
    if (sProduct.status && sProduct.status !== 'active') continue;

    const pMatch = pByTitle.get(norm(sProduct.title));
    if (!pMatch) {
      console.warn(`❌ No Printify match for Shopify product "${sProduct.title}"`);
      continue;
    }

    // Build "Color / Size" -> Printify variant id look-up
    const pVarByTitle = new Map();
    for (const v of (pMatch.variants || [])) {
      pVarByTitle.set(norm(v.title), v.id);
    }

    for (const sVariant of (sProduct.variants || [])) {
      // Shopify variant.title is typically exactly "Color / Size" (e.g., "White / 3XL")
      const key = norm(sVariant.title);
      const pVid = pVarByTitle.get(key);

      if (pVid) {
        variantMap[String(sVariant.id)] = pVid;
      } else {
        // Fallback: try color-only match (some catalogs format slightly differently)
        const guess = [...pVarByTitle.entries()].find(([k]) => key.includes(k));
        if (guess) {
          variantMap[String(sVariant.id)] = guess[1];
          console.warn(`⚠️ Approx matched "${sProduct.title}" -> "${sVariant.title}" to Printify "${guess[0]}"`);
        } else {
          console.warn(`❌ No Printify variant for Shopify "${sProduct.title}" -> "${sVariant.title}"`);
        }
      }
    }
  }

  await fs.writeFile('./variant-map.json', JSON.stringify(variantMap, null, 2));
  console.log(`✅ Generated variant-map.json with ${Object.keys(variantMap).length} entries`);
  return variantMap;
}

// CLI
if (process.argv[1].endsWith('generateVariantMap.js')) {
  generateMap().catch(err => {
    console.error('❌ Error generating variant map:', err);
    process.exit(1);
  });
}
