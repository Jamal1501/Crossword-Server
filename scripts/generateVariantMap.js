import fs from 'fs/promises';
import fetch from 'node-fetch';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const {
  SHOPIFY_STORE,
  SHOPIFY_PASSWORD,
  PRINTIFY_API_KEY,
  PRINTIFY_SHOP_ID
} = process.env;

if (!SHOPIFY_STORE || !SHOPIFY_PASSWORD || !PRINTIFY_API_KEY || !PRINTIFY_SHOP_ID) {
  throw new Error('Missing required environment variables.');
}

const VARIANT_MAP_PATH  = path.join(process.cwd(), 'variant-map.json');
const VARIANT_META_PATH = path.join(process.cwd(), 'variant-meta.json'); // NEW

const norm = (s = '') => s.toString().trim().toLowerCase();

// ---------- Fetch helpers (paginated) ----------
async function fetchShopifyProducts() {
  const out = [];
  let pageInfo = null;
  // Use REST with page_info pagination
  // Start with first page (limit=250)
  while (true) {
    const base = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json?limit=250&fields=id,title,status,variants`;
    const url = pageInfo ? `${base}&page_info=${encodeURIComponent(pageInfo)}` : base;
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_PASSWORD,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
    const json = await res.json();
    const products = Array.isArray(json?.products) ? json.products : [];
    out.push(...products);
    // parse Link header
    const link = res.headers.get('link');
    const next = link && /<([^>]+)>;\s*rel="next"/i.test(link);
    if (!next) break;
    const m = link.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/i);
    pageInfo = m ? m[1] : null;
    if (!pageInfo) break;
  }
  return out;
}

async function fetchPrintifyProducts() {
  const out = [];
  let page = 1;
  while (true) {
    const url = `https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json?page=${page}&limit=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${PRINTIFY_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Printify API error: ${res.status}`);
    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
    if (!data.length) break;
    out.push(...data);
    if (data.length < 100) break;
    page += 1;
    if (page > 25) break; // safety
  }
  return out;
}

// ---------- Indexers ----------
function indexPrintifyByTitle(printifyProducts) {
  const map = new Map();
  for (const p of printifyProducts) {
    map.set(norm(p.title), p);
  }
  return map;
}

function compactSizeToken(s) {
  const t = norm(s);
  // Normalize common size tokens
  if (t === 'xs') return 'xs';
  if (t === 's')  return 's';
  if (t === 'm')  return 'm';
  if (t === 'l')  return 'l';
  if (t === 'xl') return 'xl';
  if (t === 'xxl' || t === '2xl') return 'xxl';
  if (t === 'xxxl' || t === '3xl') return 'xxxl';
  return t;
}

function splitColorSize(title) {
  // Expect "Color / Size" but be tolerant
  const parts = norm(title).split('/').map(x => x.trim());
  const color = parts[0] || '';
  const size  = compactSizeToken(parts[1] || '');
  return { color, size };
}

// ---------- Variant mapping logic ----------
function mapOneVariant({ sProduct, sVariant, pProduct, variantMetaOut }) {
  if (!pProduct) return null;

  // Build indices for Printify variants
  const pvByTitle = new Map();         // "Color / Size" -> id
  const pvBySku   = new Map();         // sku -> id
  const pvOpts    = [];                // {color,size,id}
  for (const v of (pProduct.variants || [])) {
    const vt = norm(v.title || '');
    if (vt) pvByTitle.set(vt, v.id);
    if (v.sku) pvBySku.set(norm(v.sku), v.id);

    const { color, size } = splitColorSize(v.title || '');
    pvOpts.push({ color, size, id: v.id });
    // Fill variantMeta: { [printifyVariantId]: { bp, pp, product_id } }
    variantMetaOut[v.id] = {
      blueprintId: pProduct.blueprint_id,
      printProviderId: pProduct.print_provider_id,
      printifyProductId: pProduct.id
    };
  }

  // 1) SKU exact match
  const sSku = norm(sVariant.sku || '');
  if (sSku && pvBySku.has(sSku)) return pvBySku.get(sSku);

  // 2) Exact "Color / Size" title match
  const sTitle = norm(sVariant.title || '');
  if (pvByTitle.has(sTitle)) return pvByTitle.get(sTitle);

  // 3) Single-variant product
  if ((pProduct.variants || []).length === 1) return pProduct.variants[0].id;

  // 4) Option-based fuzzy
  const { color: sColorRaw, size: sSizeRaw } = splitColorSize(sVariant.title || '');
  const sColor = sColorRaw;
  const sSize  = sSizeRaw;
  // Exact color+size
  let hit = pvOpts.find(v => v.color === sColor && v.size === sSize);
  if (hit) return hit.id;

  // Partial contains
  hit = pvOpts.find(v => (sColor ? v.color.includes(sColor) : true) && (sSize ? v.size.includes(sSize) : true));
  if (hit) return hit.id;

  return null;
}

// ---------- Main generator ----------
export async function generateMap() {
  console.log('🔄 Fetching Shopify + Printify catalogs (paginated)…');
  const [shopifyProducts, printifyProducts] = await Promise.all([
    fetchShopifyProducts(),
    fetchPrintifyProducts(),
  ]);

  console.log(`🛍️ Shopify products: ${shopifyProducts.length}`);
  console.log(`🖨️ Printify products: ${printifyProducts.length}`);

  const byTitle = indexPrintifyByTitle(printifyProducts);

  const variantMap = {};   // Shopify LONG variant ID -> Printify variant ID
  const variantMeta = {};  // Printify variant ID -> { blueprintId, printProviderId, printifyProductId }

  for (const sProduct of shopifyProducts) {
    // Shopify REST sometimes omits status; if present and not 'active', skip
    if (sProduct.status && sProduct.status !== 'active') continue;

    // Exact title match first
    let pMatch = byTitle.get(norm(sProduct.title));

    // Fallbacks for slight title drift
    if (!pMatch) {
      const cleaned = norm(sProduct.title)
        .replace(/\s*-\s*(gift|custom|image\s*upload|product.*)$/gi, '')
        .replace(/\s*\(.*?\)\s*$/g, '')
        .trim();
      pMatch = byTitle.get(cleaned);
    }
    if (!pMatch) {
      // Partial contains as last resort
      const t = norm(sProduct.title);
      for (const [k, v] of byTitle.entries()) {
        if (k.includes(t) || t.includes(k)) { pMatch = v; break; }
      }
    }

    if (!pMatch) {
      console.warn(`❌ No Printify product match for Shopify "${sProduct.title}"`);
      continue;
    }

    for (const sVariant of (sProduct.variants || [])) {
      const mapped = mapOneVariant({
        sProduct,
        sVariant,
        pProduct: pMatch,
        variantMetaOut: variantMeta
      });
      if (mapped) {
        variantMap[String(sVariant.id)] = mapped;
      } else {
        console.warn(`⚠️ Could not map Shopify variant ${sVariant.id} "${sVariant.title}" of "${sProduct.title}"`);
      }
    }
  }

  await fs.writeFile(VARIANT_MAP_PATH, JSON.stringify(variantMap, null, 2));
  await fs.writeFile(VARIANT_META_PATH, JSON.stringify(variantMeta, null, 2)); // NEW
  console.log(`✅ Wrote ${Object.keys(variantMap).length} entries to ${VARIANT_MAP_PATH}`);
  console.log(`✅ Wrote ${Object.keys(variantMeta).length} entries to ${VARIANT_META_PATH}`);
  return { variantMap, variantMeta };
}

// CLI
if (process.argv[1].endsWith('generateVariantMap.js')) {
  generateMap().catch(err => {
    console.error('❌ Error generating variant map:', err);
    process.exit(1);
  });
}
