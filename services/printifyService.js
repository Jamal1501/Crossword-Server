// services/printifyService.js
import fetch from 'node-fetch';

const BASE_URL = 'https://api.printify.com/v1';
const { PRINTIFY_API_KEY, PRINTIFY_SHOP_ID } = process.env;
const SHOP_ID = process.env.PRINTIFY_SHOP_ID;
const PIFY_HEADERS = {
  Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
  'Content-Type': 'application/json'
};

const ONLY_VISIBLE = process.env.PRINTIFY_ONLY_VISIBLE !== '0'; // default true
const EXCLUDE_TITLE_RE = new RegExp(
  process.env.PRINTIFY_EXCLUDE_TITLES_REGEX || '(test|desktop|api|quntity|crossword custom order)',
  'i'
);

async function fetchAllProductsPagedFiltered() {
  const all = [];
  let page = 1;
  for (;;) {
    const url = `${BASE_URL}/shops/${SHOP_ID}/products.json?page=${page}`;
    const resp = await safeFetch(url, { headers: PIFY_HEADERS });
    const data = Array.isArray(resp?.data) ? resp.data : (Array.isArray(resp) ? resp : []);
    if (!data.length) break;

    const cleaned = data.filter(p => {
      if (ONLY_VISIBLE && p?.visible !== true) return false; // skip unpublished/drafts
      if (p?.is_locked === true) return false;               // skip locked/in-progress
      if (EXCLUDE_TITLE_RE.test(p?.title || '')) return false; // skip obvious tests
      return true;
    });

    all.push(...cleaned);
    if (!resp?.next_page_url) break;
    page++;
  }
  return all;
}

const _catalogCache = new Map(); // key `${bp}:${pp}` -> variants payload
async function fetchCatalogVariants(bp, pp) {
  const key = `${bp}:${pp}`;
  if (_catalogCache.has(key)) return _catalogCache.get(key);
  const url = `${BASE_URL}/catalog/blueprints/${bp}/print_providers/${pp}/variants.json`;
  const data = await safeFetch(url, { headers: PIFY_HEADERS });
  _catalogCache.set(key, data);
  return data;
}

function looksBogusBlueprint(bp) {
  const n = Number(bp);
  return !n || String(n).length < 3 || n === 1111 || n === 11111;
}

async function providerHasVariant(bp, pp, variantId) {
  try {
    const data = await fetchCatalogVariants(bp, pp);
    return !!data?.variants?.some(v => Number(v.id) === Number(variantId));
  } catch {
    return false;
  }
}

async function getVariantPlaceholderByPos(blueprintId, printProviderId, variantId, pos = 'front') {
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`;
  const data = await safeFetch(url, { headers: authHeaders() });
  const v = data?.variants?.find(v => v.id === parseInt(variantId));
  const ph = v?.placeholders?.find(p => p.position === pos);
  return ph ? { width: ph.width, height: ph.height } : null;
}
/**
 * Resolve a valid (blueprint_id, print_provider_id) for a given catalog variant id.
 * 1) Try the filtered shop product that actually contains this variant.
 * 2) If that product is junk (bp invalid or provider doesn’t offer the variant), scan other
 *    (bp,pp) combos from your filtered products and pick the first that truly offers it.
 */
async function resolveBpPpForVariant(variantId) {
  const products = await fetchAllProductsPagedFiltered();

  // Try direct product that includes this variant
  for (const p of products) {
    if (p?.variants?.some(v => Number(v.id) === Number(variantId))) {
      const bp = Number(p.blueprint_id);
      const pp = Number(p.print_provider_id);
      if (!looksBogusBlueprint(bp) && await providerHasVariant(bp, pp, variantId)) {
        return { blueprintId: bp, printProviderId: pp, product: p };
      }
    }
  }

  // Fallback: scan all (bp,pp) combos from filtered products
  const combos = [];
  for (const p of products) {
    const bp = Number(p.blueprint_id);
    const pp = Number(p.print_provider_id);
    if (!looksBogusBlueprint(bp)) combos.push({ bp, pp, p });
  }
  for (const c of combos) {
    if (await providerHasVariant(c.bp, c.pp, variantId)) {
      return { blueprintId: c.bp, printProviderId: c.pp, product: c.p };
    }
  }

  throw new Error(`Unable to resolve a valid blueprint/provider for variant ${variantId} (checked ${products.length} products)`);
}


if (!PRINTIFY_API_KEY || !PRINTIFY_SHOP_ID) {
  throw new Error('Missing PRINTIFY_API_KEY or PRINTIFY_SHOP_ID env vars');
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${PRINTIFY_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Crossword-Automation/1.2',
    ...extra,
  };
}

export async function safeFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${options.method || 'GET'} ${url} → ${res.status}\n${txt}`);
  }
  return res.status === 204 ? null : await res.json();
}

/* --------------------------
   Small helper lookups
--------------------------- */

export async function getShopId() {
  const data = await safeFetch(`${BASE_URL}/shops.json`, { headers: authHeaders() });
  const shops = Array.isArray(data) ? data : (data?.data || []);
  if (!shops.length) throw new Error('No Printify shops available for this API key');
  return shops[0].id;
}

export async function findBlueprintId(keyword = '') {
  const data = await safeFetch(`${BASE_URL}/catalog/blueprints.json`, { headers: authHeaders() });
  const bps = Array.isArray(data) ? data : (data?.data || []);
  if (!bps.length) throw new Error('No blueprints returned by Printify');

  if (!keyword) return bps[0].id;

  const kw = String(keyword).toLowerCase();
  const hit =
    bps.find(b => String(b.title || '').toLowerCase().includes(kw)) ||
    bps.find(b => String(b.name || '').toLowerCase().includes(kw));

  return (hit || bps[0]).id;
}

export async function listPrintProviders(blueprintId) {
  if (!blueprintId) throw new Error('listPrintProviders: missing blueprintId');
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers.json`;
  const data = await safeFetch(url, { headers: authHeaders() });
  return Array.isArray(data) ? data : (data?.data || []);
}

export async function listVariants(blueprintId, printProviderId) {
  if (!blueprintId || !printProviderId) {
    throw new Error('listVariants: missing blueprintId or printProviderId');
  }
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`;
  const data = await safeFetch(url, { headers: authHeaders() });
  return Array.isArray(data?.variants) ? data.variants : (data?.data || []);
}

async function getVariantPlaceholder(blueprintId, printProviderId, variantId) {
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`;
  const data = await safeFetch(url, { headers: authHeaders() });
  const v = data?.variants?.find(v => v.id === parseInt(variantId));
  const ph = v?.placeholders?.find(p => p.position === 'front');
  return ph ? { width: ph.width, height: ph.height } : null;
}

// Allow enlarging to fully contain within the placeholder box
function clampContainScale({ Aw, Ah, Iw, Ih, requested = 1 }) {
  if (!Aw || !Ah || !Iw || !Ih) return requested ?? 1;
  const sMax = Math.min(1, (Ah / Aw) * (Iw / Ih)); // Printify scale = fraction of area width
  return Math.max(0, sMax * (requested ?? 1));      // requested=1 → full contain
}


/* --------------------------
   Upload helpers
--------------------------- */

export async function uploadImageFromUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new Error('Invalid imageUrl input');
  }
  try {
    new URL(imageUrl);
  } catch {
    throw new Error('Invalid URL format');
  }
  const body = {
    url: imageUrl,
    file_name: `crossword_${Date.now()}.png`,
  };
  const url = `${BASE_URL}/uploads/images.json`;
  return safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}

export async function uploadImageFromBase64(base64Image) {
  if (!base64Image || typeof base64Image !== 'string') {
    throw new Error('Invalid base64Image input');
  }
  let base64Content;
  let mimeType = 'image/png';
  if (base64Image.startsWith('data:')) {
    const [header, content] = base64Image.split(',');
    if (!content) throw new Error('Invalid data URL format');
    base64Content = content;
    const mimeMatch = header.match(/data:([^;]+)/);
    if (mimeMatch) mimeType = mimeMatch[1];
  } else {
    base64Content = base64Image;
  }
  if (!base64Content.length) {
    throw new Error('Empty base64 content');
  }
  const timestamp = Date.now();
  const extension = mimeType.split('/')[1] || 'png';
  const fileName = `crossword_${timestamp}.${extension}`;
  const body = {
    contents: base64Content,
    file_name: fileName,
  };
  const url = `${BASE_URL}/uploads/images.json`;
  return safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}

/* --------------------------
   Optional sample creator
--------------------------- */

export async function createTestProduct({ shopifyTitle, shopifyHandle }) {
  const payload = {
    title: shopifyTitle,
    description: "Auto-created crossword gift product.",
    blueprint_id: 1,          // ← replace with your actual blueprint
    print_provider_id: 1,     // ← replace with your actual provider
    variants: [
      {
        id: 111,              // ← replace with actual variant ID
        price: 1500,
        is_enabled: true
      }
    ],
    print_areas: [
      {
        variant_ids: [111],
        placeholders: [
          {
            position: "front",
            images: [
              {
                id: "PLACEHOLDER_IMAGE_ID",
                x: 0.5,
                y: 0.5,
                scale: 1,
                angle: 0
              }
            ]
          }
        ]
      }
    ],
    external: {
      handle: `https://your-store.myshopify.com/products/${shopifyHandle}`
    }
  };

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products.json`;
  const response = await safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  return response;
}

async function getVariantPlaceholderNames(blueprintId, printProviderId, variantId) {
  try {
    const data = await safeFetch(
      `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`,
      { headers: authHeaders() }
    );
    const v = data?.variants?.find(v => v.id === parseInt(variantId));
    return (v?.placeholders || []).map(p => p.position).filter(Boolean);
  } catch {
    return ['front']; // fallback
  }
}

/* --------------------------
   Order creation (front/back)
--------------------------- */

// REPLACE YOUR ENTIRE createOrder(...) WITH THIS VERSION
export async function createOrder({
  imageUrl,
  backImageUrl,
  base64Image,
  variantId,
  quantity = 1,
  position,
  backPosition,
  recipient,
  printArea, // not used, but accepted
  meta       // not used, but accepted
}) {
  if ((!imageUrl && !base64Image) || !variantId || !recipient) {
    console.error('❌ Missing required fields:', { imageUrl, base64Image, variantId, recipient });
    throw new Error('Missing required fields: imageUrl/base64Image, variantId, recipient');
  }

  // 1) Upload FRONT
  console.log('📤 Uploading FRONT image to Printify:', imageUrl || '[base64Image]');
  let uploadedFront;
  try {
    uploadedFront = imageUrl
      ? await uploadImageFromUrl(imageUrl)
      : await uploadImageFromBase64(base64Image);
    console.log('✅ Front image uploaded to Printify:', uploadedFront);
  } catch (uploadErr) {
    console.error('❌ Failed to upload FRONT image to Printify:', uploadErr.message);
    throw uploadErr;
  }

  // 2) If provided, upload BACK (clues)
  let uploadedBack = null;
  if (backImageUrl) {
    try {
      console.log('📤 Uploading BACK image to Printify:', backImageUrl);
      uploadedBack = await uploadImageFromUrl(backImageUrl);
      console.log('✅ Back image uploaded to Printify:', uploadedBack);
    } catch (e) {
      console.warn('⚠️ Back image upload failed; continuing without back:', e.message);
    }
  }

  // 3) Resolve product / provider / blueprint for this variant
  console.log('🔍 Resolving (blueprint, provider) for variant via paged + filtered products…');
  let product, printProviderId, blueprintId;
  try {
    const { product: matchedProduct, blueprintId: bp, printProviderId: pp } =
      await resolveBpPpForVariant(variantId);

    product = matchedProduct;
    blueprintId = bp;
    printProviderId = pp;

    console.log(`✅ Matched variant ${variantId} to product:`, {
      title: product?.title,
      blueprintId,
      printProviderId
    });
  } catch (e) {
    console.error('❌ Unable to resolve (bp,pp) for variant', variantId, e.message);
    throw e;
  }

  // 4) Contain-fit scale for FRONT (avoid clipping), using your contain helper
  let finalScale = position?.scale ?? 0.9;
  try {
    const ph = await getVariantPlaceholder(blueprintId, printProviderId, parseInt(variantId));
    finalScale = clampContainScale({
      Aw: ph?.width, Ah: ph?.height,
      Iw: uploadedFront?.width, Ih: uploadedFront?.height,
      requested: finalScale
    });
    console.log('🧮 Scale containment (front)', {
      Aw: ph?.width, Ah: ph?.height,
      Iw: uploadedFront?.width, Ih: uploadedFront?.height,
      requested: position?.scale ?? 1,
      finalScale
    });
  } catch (e) {
    console.warn('⚠️ Contain-scale calc failed (front):', e.message);
  }

// 5) Build print_areas map for ORDERS endpoint (expects src + coords)
const frontSrc =
  uploadedFront?.file_url ||
  uploadedFront?.preview_url ||
  uploadedFront?.url ||
  uploadedFront; // fallback string

let requiredPlaceholders = ['front'];
try {
  requiredPlaceholders = await getVariantPlaceholderNames(blueprintId, printProviderId, parseInt(variantId));
  if (!Array.isArray(requiredPlaceholders) || requiredPlaceholders.length === 0) {
    requiredPlaceholders = ['front'];
  }
} catch {
  requiredPlaceholders = ['front'];
}

// FRONT area (always)
const printAreas = {
  front: [{
    src: frontSrc,
    x: position?.x ?? 0.5,
    y: position?.y ?? 0.5,
    scale: finalScale,
    angle: position?.angle ?? 0,
  }],
};

// FRONT-COVER clone if needed
if (requiredPlaceholders.includes('front_cover')) {
  printAreas.front_cover = [{
    src: frontSrc,
    x: position?.x ?? 0.5,
    y: position?.y ?? 0.5,
    scale: finalScale,
    angle: position?.angle ?? 0,
  }];
}

// BACK area (only if provided)
if (uploadedBack) {
  const backSrc =
    uploadedBack?.file_url ||
    uploadedBack?.preview_url ||
    uploadedBack?.url ||
    uploadedBack;

  const nonFront = requiredPlaceholders.filter(n => n !== 'front' && n !== 'front_cover');
  const backKey = requiredPlaceholders.includes('back') ? 'back' : (nonFront[0] || 'back');

  const BACK_SCALE_MULT = Number(process.env.BACK_SCALE_MULT || 1.0);
  const bx = backPosition?.x ?? 0.5;
  const by = backPosition?.y ?? 0.5;
  const ba = backPosition?.angle ?? 0;
  const requestedBack =
    (typeof backPosition?.scale === 'number' ? backPosition.scale : (position?.scale ?? 1)) * BACK_SCALE_MULT;

  let finalBackScale = requestedBack;
  try {
    const ph = await getVariantPlaceholderByPos(blueprintId, printProviderId, parseInt(variantId), backKey);
    finalBackScale = clampContainScale({
      Aw: ph?.width,
      Ah: ph?.height,
      Iw: uploadedBack?.width,
      Ih: uploadedBack?.height,
      requested: requestedBack,
    });
    console.log('🧮 Back scale', { backKey, requestedBack, finalBackScale });
  } catch (e) {
    console.warn('⚠️ Contain-scale calc failed (back):', e.message);
  }

  printAreas[backKey] = [{
    src: backSrc,
    x: bx,
    y: by,
    scale: finalBackScale,
    angle: ba,
  }];
}


  // 6) Final order payload (print_areas as array with one object that has placeholders)
  const payload = {
    external_id: `order-${Date.now()}`,
    label: 'Crossword Custom Order',
    line_items: [{
      variant_id: parseInt(variantId),
      quantity: Math.max(1, Number(quantity) || 1),
      print_provider_id: printProviderId,
      blueprint_id: blueprintId,
      print_areas: printAreas
    }],
    shipping_method: 1,
    send_shipping_notification: true,
    address_to: {
      first_name: recipient.name?.split(' ')[0] || '-',
      last_name: recipient.name?.split(' ').slice(1).join(' ') || '-',
      email: recipient.email,
      address1: recipient.address1,
      city: recipient.city,
      country: recipient.country,
      zip: recipient.zip,
      phone: recipient.phone || ''
    }
  };

  console.log('📦 Final Printify order payload:', JSON.stringify(payload, null, 2));

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/orders.json`;
  const orderRes = await safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  console.log('✅ Printify order successfully created:', orderRes?.id || '[no id]');
  return orderRes;
}

/* -------------------------- Product preview updaters --------------------------- */

export async function applyImageToProduct(productId, variantId, uploadedImageId, placement, imageMeta) {
  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;
  const product = await safeFetch(url, { headers: authHeaders() });

  const allVariantIds = product.variants.map(v => v.id);

  const updatedPrintAreas = product.print_areas.map(area => ({
    ...area,
    variant_ids: allVariantIds,
    placeholders: [
      {
        position: "front",
        images: [
          {
            id: uploadedImageId,
            x: placement?.x ?? 0.5,
            y: placement?.y ?? 0.5,
            scale: placement?.scale ?? 1,
            angle: placement?.angle ?? 0
          }
        ]
      }
    ]
  }));

  const payload = {
    title: product.title,
    description: product.description,
    blueprint_id: product.blueprint_id,
    print_provider_id: product.print_provider_id,
    variants: product.variants,
    print_areas: updatedPrintAreas
  };

  const updateUrl = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;
  return safeFetch(updateUrl, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}

// Apply front + back images to a product (used for previews)
export async function applyImagesToProductDual(
  productId,
  variantId,
  frontImageId,
  backImageId,
  frontPlacement,
  backPlacement = null
) {
  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;
  const product = await safeFetch(url, { headers: authHeaders() });

  const allVariantIds = product.variants.map(v => v.id);

  const finalBackPlacement = backPlacement || {
    x: frontPlacement?.x ?? 0.5,
    y: frontPlacement?.y ?? 0.5,
    scale: frontPlacement?.scale ?? 1,
    angle: frontPlacement?.angle ?? 0,
  };

  const updatedPrintAreas = product.print_areas.map(area => ({
    ...area,
    variant_ids: allVariantIds,
    placeholders: [
      {
        position: "front",
        images: [{
          id: frontImageId,
          x: frontPlacement?.x ?? 0.5,
          y: frontPlacement?.y ?? 0.5,
          scale: frontPlacement?.scale ?? 0.9,
          angle: frontPlacement?.angle ?? 0
        }]
      },
      {
        position: "back",
        images: [{
          id: backImageId,
          x: finalBackPlacement.x ?? 0.5,
          y: finalBackPlacement.y ?? 0.5,
          scale: finalBackPlacement.scale ?? 1,
          angle: finalBackPlacement.angle ?? 0
        }]
      }
    ]
  }));

  const payload = {
    title: product.title,
    description: product.description,
    blueprint_id: product.blueprint_id,
    print_provider_id: product.print_provider_id,
    variants: product.variants,
    print_areas: updatedPrintAreas
  };

  const updateUrl = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;
  return safeFetch(updateUrl, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}

export async function fetchProduct(productId) {
  if (!productId) {
    throw new Error("Missing productId");
  }
  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;
  return safeFetch(url, {
    method: 'GET',
    headers: authHeaders(),
  });
}
