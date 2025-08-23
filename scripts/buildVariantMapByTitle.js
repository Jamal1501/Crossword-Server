import fs from 'fs/promises';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const { SHOPIFY_STORE, SHOPIFY_PASSWORD, PRINTIFY_API_KEY, PRINTIFY_SHOP_ID } = process.env;

function norm(s='') {
  return s.toString().trim().toLowerCase();
}

async function fetchShopifyProducts() {
  const res = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json`, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_PASSWORD,
      'Content-Type': 'application/json',
    }
  });
  if (!res.ok) throw new Error(`Shopify products failed: ${res.status}`);
  const json = await res.json();
  return json.products || [];
}

async function fetchPrintifyProducts() {
  const res = await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json`, {
    headers: {
      Authorization: `Bearer ${PRINTIFY_API_KEY}`,
      'Content-Type': 'application/json',
    }
  });
  if (!res.ok) throw new Error(`Printify products failed: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.data) ? json.data : json; // API sometimes returns {data:[]}
}

function indexPrintifyByTitle(printifyProducts) {
  const byTitle = new Map();
  for (const p of printifyProducts) {
    byTitle.set(norm(p.title), p);
  }
  return byTitle;
}

export async function buildVariantMap() {
  const [shopifyProducts, printifyProducts] = await Promise.all([
    fetchShopifyProducts(),
    fetchPrintifyProducts()
  ]);

  const pIndex = indexPrintifyByTitle(printifyProducts);
  const map = {};

  for (const sp of shopifyProducts) {
    const target = pIndex.get(norm(sp.title));
    if (!target) continue;

    // Build a lookup of "Color / Size" -> Printify variant id
    const pvByTitle = new Map();
    for (const v of (target.variants || [])) {
      pvByTitle.set(norm(v.title), v.id);
    }

    for (const sv of (sp.variants || [])) {
      // Shopify variant title typically looks like "White / 3XL"
      const key = norm(sv.title);
      const printifyVid = pvByTitle.get(key);
      if (printifyVid) {
        // ✅ map Shopify LONG variant id -> Printify variant id
        map[String(sv.id)] = printifyVid;
      }
    }
  }

  await fs.writeFile('./variant-map.json', JSON.stringify(map, null, 2));
  console.log(`✅ variant-map.json written with ${Object.keys(map).length} entries`);
  return map;
}

// CLI
if (process.argv[1].endsWith('buildVariantMapByTitle.js')) {
  buildVariantMap().catch(err => {
    console.error('❌ buildVariantMapByTitle failed:', err);
    process.exit(1);
  });
}
