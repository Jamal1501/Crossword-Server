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

// --- NEW: fetch required placements (front/back/etc.) for a blueprint+provider ---
export async function fetchRequiredPlacements(blueprintId, printProviderId) {
  const url = `${BASE_URL}/catalog/blueprints/${Number(blueprintId)}/print_providers/${Number(printProviderId)}.json`;
  let required = ['front'];
  try {
    const spec = await safeFetch(url, { headers: authHeaders() });
    // spec.print_areas[].placeholders: ["front","back",...]
    const areas = Array.isArray(spec?.print_areas) ? spec.print_areas : [];
    const set = new Set();
    for (const a of areas) {
      const phs = Array.isArray(a?.placeholders) ? a.placeholders : [];
      for (const p of phs) set.add(String(p).toLowerCase());
      if (a?.position) set.add(String(a.position).toLowerCase());
      if (a?.name) set.add(String(a.name).toLowerCase());
    }
    required = Array.from(set);
    if (!required.length) required = ['front'];
  } catch (e) {
    console.warn('⚠️ fetchRequiredPlacements failed; defaulting to ["front"]:', e?.message || e);
  }
  // normalize common aliases
  required = required.map(s => (s === 'rear' || s === 'reverse') ? 'back' : s);
  return required;
}

// --- NEW: 1x1 transparent PNG (base64) uploader for missing placements ---
export function tinyTransparentPngBase64() {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
}

// --- NEW: normalize outgoing files/print_areas to EXACT provider-required set ---
export async function normalizeItemToProvider({ item, provided, blueprintId, printProviderId }) {
  // required = order matters as provider expects
  const required = await fetchRequiredPlacements(blueprintId, printProviderId);
  console.log('🧩 Provider requires placements:', required, 'for bp:', blueprintId, 'pp:', printProviderId);

  // Ensure we have a dict like { front: {...}, back: {...} } with id/x/y/scale/angle,width,height
  const map = { ...provided };

  // Attach transparent shim for any missing required placeholder
  for (const ph of required) {
    if (!map[ph]) {
      console.log(`🫥 Missing required placement "${ph}" — attaching transparent shim`);
      const upload = await uploadImageFromBase64(tinyTransparentPngBase64());
      map[ph] = {
        id: upload?.id,
        src: null,
        name: 'transparent.png',
        type: 'image/png',
        height: 1, width: 1,
        x: 0.5, y: 0.5, scale: 1, angle: 0
      };
    }
  }

  // Rebuild item.files and item.print_areas strictly following `required` order
  const files = [];
  const print_areas = {};
  for (const ph of required) {
    const v = map[ph];
    files.push({
      placement: ph,
      ...(v?.id ? { image_id: v.id } : {}),
      position: { x: v?.x ?? 0.5, y: v?.y ?? 0.5, scale: v?.scale ?? 1, angle: v?.angle ?? 0 }
    });
    print_areas[ph] = [v];
  }

  item.files = files;
  item.print_areas = print_areas;
  return item;
}

/* --------------------------
   Shop product listing (filtered)
--------------------------- */
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

/**
 * Resolve a valid (blueprint_id, print_provider_id) for a given catalog variant id.
 * 1) Try the filtered shop product that actually contains this variant.
 * 2) If that product is junk, scan other (bp,pp) combos from filtered products and pick the first that offers it.
 */
export async function resolveBpPpForVariant(variantId) {
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

/* --------------------------
   Placeholder helpers (catalog)
--------------------------- */
export async function getVariantPlaceholderByPos(blueprintId, printProviderId, variantId, pos = 'front') {
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`;
  const data = await safeFetch(url, { headers: authHeaders() });
  const v = data?.variants?.find(v => v.id === parseInt(variantId));
  const ph = v?.placeholders?.find(p => p.position === pos);
  return ph ? { width: ph.width, height: ph.height } : null;
}

async function getVariantPlaceholder(blueprintId, printProviderId, variantId) {
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`;
  const data = await safeFetch(url, { headers: authHeaders() });
  const v = data?.variants?.find(v => v.id === parseInt(variantId));
  const ph = v?.placeholders?.find(p => p.position === 'front');
  return ph ? { width: ph.width, height: ph.height } : null;
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
   Contain scale helper
--------------------------- */
// Allow enlarging to fully contain within the placeholder box
// (Printify expects 0..1; clamp the final!)
function clampContainScale({ Aw, Ah, Iw, Ih, requested = 1 }) {
  if (!Aw || !Ah || !Iw || !Ih) return Math.max(0, Math.min(1, requested ?? 1));
  const sMax = Math.min(1, (Ah / Aw) * (Iw / Ih)); // fraction of area width for contain
  const out  = (requested ?? 1) * sMax;
  return Math.max(0, Math.min(1, out));
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
   Product preview updaters (unchanged)
--------------------------- */
function normalizePlaceholders(placeholders) {
  const list = Array.isArray(placeholders) ? placeholders : [];
  return list.map(p => ({
    position: p?.position || 'front',
    images: Array.isArray(p?.images) ? p.images : []
  }));
}

function withPlaceholders(area) {
  return {
    ...area,
    placeholders: normalizePlaceholders(area?.placeholders)
  };
}

function normalizeAreas(print_areas, allVariantIds = []) {
  const arr = Array.isArray(print_areas) ? print_areas : [];
  if (!arr.length) {
    return [{
      variant_ids: allVariantIds.length ? allVariantIds : [],
      placeholders: []
    }];
  }
  return arr.map(withPlaceholders);
}

function upsertPlaceholder(placeholders, position, images) {
  const list = Array.isArray(placeholders) ? placeholders : [];
  const rest = list.filter(p => p && p.position !== position);
  return normalizePlaceholders([...rest, { position, images }]);
}

export async function applyImageToProduct(productId, variantId, uploadedImageId, placement) {
  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;
  const product = await safeFetch(url, { headers: authHeaders() });

  const vId = Number(variantId);
  const allVariantIds = (product?.variants || []).map(v => Number(v.id));
  const areas = normalizeAreas(product.print_areas, allVariantIds);

  const newAreas = [];
  let handled = false;

  for (const area0 of areas) {
    const area = withPlaceholders(area0);
    const ids = (area.variant_ids || []).map(Number);

    if (ids.includes(vId)) {
      const remaining = ids.filter(id => id !== vId);

      const selectedArea = {
        ...area,
        variant_ids: [vId],
        placeholders: upsertPlaceholder(area.placeholders, "front", [{
          id: uploadedImageId,
          x: placement?.x ?? 0.5,
          y: placement?.y ?? 0.5,
          scale: placement?.scale ?? 1,
          angle: placement?.angle ?? 0
        }])
      };
      newAreas.push(withPlaceholders(selectedArea));

      if (remaining.length) {
        newAreas.push(withPlaceholders({ ...area, variant_ids: remaining }));
      }
      handled = true;
    } else {
      newAreas.push(withPlaceholders(area));
    }
  }

  if (!handled) {
    newAreas.push({
      variant_ids: [vId],
      placeholders: normalizePlaceholders([{
        position: "front",
        images: [{
          id: uploadedImageId,
          x: placement?.x ?? 0.5,
          y: placement?.y ?? 0.5,
          scale: placement?.scale ?? 1,
          angle: placement?.angle ?? 0
        }]
      }])
    });
  }

  const payload = {
    title: product.title,
    description: product.description,
    blueprint_id: product.blueprint_id,
    print_provider_id: product.print_provider_id,
    variants: product.variants,
    print_areas: normalizeAreas(newAreas, allVariantIds)
  };

  const updateUrl = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;
  return safeFetch(updateUrl, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}

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

  const vId = Number(variantId);
  const allVariantIds = (product?.variants || []).map(v => Number(v.id));
  const areas = normalizeAreas(product.print_areas, allVariantIds);

  const finalBackPlacement = backPlacement || {
    x: frontPlacement?.x ?? 0.5,
    y: frontPlacement?.y ?? 0.5,
    scale: frontPlacement?.scale ?? 1,
    angle: frontPlacement?.angle ?? 0,
  };

  const newAreas = [];
  let handled = false;

  for (const area0 of areas) {
    const area = withPlaceholders(area0);
    const ids = (area.variant_ids || []).map(Number);

    if (ids.includes(vId)) {
      const remaining = ids.filter(id => id !== vId);

      let placeholders = normalizePlaceholders(area.placeholders || []);
      placeholders = upsertPlaceholder(placeholders, "front", [{
        id: frontImageId,
        x: frontPlacement?.x ?? 0.5,
        y: frontPlacement?.y ?? 0.5,
        scale: frontPlacement?.scale ?? 0.9,
        angle: frontPlacement?.angle ?? 0
      }]);
      placeholders = upsertPlaceholder(placeholders, "back", [{
        id: backImageId,
        x: finalBackPlacement.x ?? 0.5,
        y: finalBackPlacement.y ?? 0.5,
        scale: finalBackPlacement.scale ?? 1,
        angle: finalBackPlacement.angle ?? 0
      }]);

      const selectedArea = { ...area, variant_ids: [vId], placeholders };
      newAreas.push(withPlaceholders(selectedArea));

      if (remaining.length) {
        newAreas.push(withPlaceholders({ ...area, variant_ids: remaining }));
      }
      handled = true;
    } else {
      newAreas.push(withPlaceholders(area));
    }
  }

  if (!handled) {
    newAreas.push({
      variant_ids: [vId],
      placeholders: normalizePlaceholders([
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
      ])
    });
  }

  const payload = {
    title: product.title,
    description: product.description,
    blueprint_id: product.blueprint_id,
    print_provider_id: product.print_provider_id,
    variants: product.variants,
    print_areas: normalizeAreas(newAreas, allVariantIds)
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

/* --------------------------
   Order creation (front/back) — include BOTH files[] and print_areas for compatibility
--------------------------- */
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

  // 4) Contain-fit scale for FRONT (avoid clipping)
  const FRONT_SCALE_MULT = Number(process.env.FRONT_SCALE_MULT || 1.0);
  let requestedFrontScale = (position?.scale ?? 1) * FRONT_SCALE_MULT;
  let finalScale = requestedFrontScale;
  try {
    const ph = await getVariantPlaceholder(blueprintId, printProviderId, parseInt(variantId));
    finalScale = clampContainScale({
      Aw: ph?.width, Ah: ph?.height,
      Iw: uploadedFront?.width, Ih: uploadedFront?.height,
      requested: requestedFrontScale
    });
    finalScale = Math.max(0, Math.min(1, finalScale)); // hard clamp
    console.log('🧮 Scale containment (front)', {
      Aw: ph?.width, Ah: ph?.height,
      Iw: uploadedFront?.width, Ih: uploadedFront?.height,
      requested: requestedFrontScale,
      finalScale
    });
  } catch (e) {
    console.warn('⚠️ Contain-scale calc failed (front):', e.message);
  }

  // 5) Decide positions
  const px = (v, d=0) => (typeof v === 'number' && isFinite(v) ? v : d);
  const fX = px(position?.x, 0.5);
  const fY = px(position?.y, 0.5);
  const fA = px(position?.angle, 0);

  // 6) Build files[] (Orders API modern)
  const files = [{
    placement: 'front',
    ...(uploadedFront?.id ? { image_id: uploadedFront.id } : { image_url: imageUrl }),
    position: { x: fX, y: fY, scale: finalScale, angle: fA }
  }];

  // Legacy mirror: print_areas{} for validators that still require it
  const print_areas = {
    front: [{
      id: uploadedFront?.id || undefined,
      src: uploadedFront?.file_url || uploadedFront?.url || imageUrl,
      name: uploadedFront?.file_name || 'front.png',
      type: 'image/png',
      height: uploadedFront?.height || 0,
      width:  uploadedFront?.width || 0,
      x: fX, y: fY, scale: finalScale, angle: fA
    }]
  };

  if (uploadedBack || backImageUrl) {
    const bX = px(backPosition?.x, 0.5);
    const bY = px(backPosition?.y, 0.5);
    const bA = px(backPosition?.angle, 0);
    const bS = Math.max(0, Math.min(1, px(backPosition?.scale, position?.scale ?? 1)));

    files.push({
      placement: 'back',
      ...(uploadedBack?.id ? { image_id: uploadedBack.id } : { image_url: backImageUrl }),
      position: { x: bX, y: bY, scale: bS, angle: bA }
    });

    print_areas.back = [{
      id: uploadedBack?.id || undefined,
      src: uploadedBack?.file_url || uploadedBack?.url || backImageUrl,
      name: uploadedBack?.file_name || 'back.png',
      type: 'image/png',
      height: uploadedBack?.height || 0,
      width:  uploadedBack?.width || 0,
      x: bX, y: bY, scale: bS, angle: bA
    }];
  }

  // --- NEW: normalize outgoing placements to provider spec (single-order) ---
try {
  const meta = await resolveBpPpForVariant(parseInt(variantId));
  const provided = {};
  if (print_areas?.front?.[0]) provided.front = print_areas.front[0];
  if (print_areas?.back?.[0])  provided.back  = print_areas.back[0];
  const tmpItem = {
    blueprint_id: Number(meta.blueprintId),
    print_provider_id: Number(meta.printProviderId),
    files, print_areas
  };
  await normalizeItemToProvider({
    item: tmpItem,
    provided,
    blueprintId: meta.blueprintId,
    printProviderId: meta.printProviderId
  });
  // replace local vars with normalized result
  files = tmpItem.files;
  print_areas = tmpItem.print_areas;
} catch (e) {
  console.warn('⚠️ Placement normalization (single) failed; proceeding as-is:', e?.message || e);
}

  // 7) Compose order payload (includes both shapes)
  const payload = {
    external_id: `order-${Date.now()}`,
    label: 'Crossword Custom Order',
    line_items: [{
      variant_id: parseInt(variantId),
      quantity: Math.max(1, Number(quantity) || 1),
      print_provider_id: Number(printProviderId),
      blueprint_id: Number(blueprintId),
      // 👇 include both for compatibility
      files,
      print_areas
    }],
    shipping_method: 1,
    send_shipping_notification: true,
    address_to: {
      first_name: (recipient.name || '').split(' ')[0] || '-',
      last_name: (recipient.name || '').split(' ').slice(1).join(' ') || '-',
      email: (recipient.email || '').trim() || undefined,
      phone: (recipient.phone || '').trim() || undefined,
      country: recipient.country || '',
      region: recipient.region || '',
      address1: recipient.address1 || '',
      address2: recipient.address2 || '',
      city: recipient.city || '',
      zip: recipient.zip || ''
    }
  };

  console.log('📦 Final Printify order payload:', JSON.stringify(payload, null, 2));

  // 8) Create the order at Printify and return response
  const orderUrl = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/orders.json`;
  const orderResp = await safeFetch(orderUrl, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  return orderResp;
}

/* --------------------------
   BATCH ORDER CREATION — include BOTH files[] and print_areas
--------------------------- */
export async function createOrderBatch({
  items = [],          // array of { imageUrl, backImageUrl?, base64Image?, variantId, quantity, position, backPosition }
  recipient,           // same shape as in createOrder
  externalId,          // optional
  label = 'Crossword Custom Order',
  shipping_method = 1, // 1 = standard
  send_shipping_notification = true
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('createOrderBatch: items[] is required and cannot be empty');
  }
  if (!recipient) {
    throw new Error('createOrderBatch: recipient is required');
  }

  const line_items = [];

  for (const it of items) {
    const { imageUrl, backImageUrl, base64Image, variantId, quantity = 1, position, backPosition } = it;
    if ((!imageUrl && !base64Image) || !variantId) {
      throw new Error('createOrderBatch: each item needs imageUrl/base64Image and variantId');
    }

    // Resolve bp/pp for this variant
    const { blueprintId, printProviderId } = await resolveBpPpForVariant(variantId);

    // Upload images (front + optional back)
    const uploadedFront = imageUrl
      ? await uploadImageFromUrl(imageUrl)
      : await uploadImageFromBase64(base64Image);

    let uploadedBack = null;
    if (backImageUrl) {
      uploadedBack = await uploadImageFromUrl(backImageUrl);
    }

    // Positions & scales
    const px = (v, d=0) => (typeof v === 'number' && isFinite(v) ? v : d);
    const fX = px(position?.x, 0.5);
    const fY = px(position?.y, 0.5);
    const fA = px(position?.angle, 0);
// Recompute scale to fit the actual Printify placeholder (contain-fit)
const FRONT_SCALE_MULT = Number(process.env.FRONT_SCALE_MULT || 1.0);
let fS = px(position?.scale, 1);
let phFront; // define in outer scope so we can log safely
try {
  phFront = await getVariantPlaceholder(blueprintId, printProviderId, parseInt(variantId));
  const containFront = clampContainScale({
    Aw: phFront?.width, Ah: phFront?.height,
    Iw: uploadedFront?.width, Ih: uploadedFront?.height,
    requested: fS
  });
  fS = Math.max(0, Math.min(1, containFront * FRONT_SCALE_MULT));
} catch (e) {
  // fallback to provided scale if placeholder lookup fails
  fS = Math.max(0, Math.min(1, fS * FRONT_SCALE_MULT));
}
// Debug: front scale decision (guard for undefined)
console.log(
  '[BATCH] front placeholder',
  phFront?.width, 'x', phFront?.height,
  'uploaded', uploadedFront?.width, 'x', uploadedFront?.height,
  'requested', px(position?.scale, 1), '→ final', fS
);


    const files = [{
      placement: 'front',
      ...(uploadedFront?.id ? { image_id: uploadedFront.id } : { image_url: imageUrl }),
      position: { x: fX, y: fY, scale: fS, angle: fA }
    }];

    const print_areas = {
      front: [{
        id: uploadedFront?.id || undefined,
        src: uploadedFront?.file_url || uploadedFront?.url || imageUrl,
        name: uploadedFront?.file_name || 'front.png',
        type: 'image/png',
        height: uploadedFront?.height || 0,
        width:  uploadedFront?.width || 0,
        x: fX, y: fY, scale: fS, angle: fA
      }]
    };

    if (uploadedBack || backImageUrl) {
      const bX = px(backPosition?.x, 0.5);
      const bY = px(backPosition?.y, 0.5);
      const bA = px(backPosition?.angle, 0);
      // Recompute back scale (if back image present)
const BACK_SCALE_MULT = Number(process.env.BACK_SCALE_MULT || 1.0);
let bS = px(backPosition?.scale, 1);
let phBack; // define in outer scope so we can log safely
try {
  // Prefer explicit back placeholder if available; fall back to generic
  phBack = (await getVariantPlaceholderByPos?.(blueprintId, printProviderId, parseInt(variantId), 'back'))
        || (await getVariantPlaceholder(blueprintId, printProviderId, parseInt(variantId)));
  const containBack = clampContainScale({
    Aw: phBack?.width, Ah: phBack?.height,
    Iw: uploadedBack?.width, Ih: uploadedBack?.height,
    requested: bS
  });
  bS = Math.max(0, Math.min(1, containBack * BACK_SCALE_MULT));
} catch (e) {
  bS = Math.max(0, Math.min(1, bS * BACK_SCALE_MULT));
}
// Debug: back scale decision (guard for undefined)
console.log(
  '[BATCH] back placeholder',
  phBack?.width, 'x', phBack?.height,
  'uploaded', uploadedBack?.width, 'x', uploadedBack?.height,
  'requested', px(backPosition?.scale, 1), '→ final', bS
);



      files.push({
        placement: 'back',
        ...(uploadedBack?.id ? { image_id: uploadedBack.id } : { image_url: backImageUrl }),
        position: { x: bX, y: bY, scale: bS, angle: bA }
      });

      print_areas.back = [{
        id: uploadedBack?.id || undefined,
        src: uploadedBack?.file_url || uploadedBack?.url || backImageUrl,
        name: uploadedBack?.file_name || 'back.png',
        type: 'image/png',
        height: uploadedBack?.height || 0,
        width:  uploadedBack?.width || 0,
        x: bX, y: bY, scale: bS, angle: bA
      }];
    }

    // --- NEW: normalize outgoing placements to provider spec (batch item) ---
    try {
      const provided = {};
      if (print_areas?.front?.[0]) provided.front = print_areas.front[0];
      if (print_areas?.back?.[0])  provided.back  = print_areas.back[0];

      const tmpItem = {
        blueprint_id: Number(blueprintId),
        print_provider_id: Number(printProviderId),
        files, print_areas
      };

      await normalizeItemToProvider({
        item: tmpItem,
        provided,
        blueprintId,
        printProviderId
      });

      files = tmpItem.files;
      print_areas = tmpItem.print_areas;
    } catch (e) {
      console.warn('⚠️ Placement normalization (batch) failed; proceeding as-is:', e?.message || e);
    }

    line_items.push({
      variant_id: parseInt(variantId),
      quantity: Math.max(1, Number(quantity) || 1),
      print_provider_id: Number(printProviderId),
      blueprint_id: Number(blueprintId),
      files,
      print_areas
    });

  }

  const payload = {
    external_id: externalId || `batch-${Date.now()}`,
    label,
    line_items,
    shipping_method,
    send_shipping_notification,
    address_to: {
      first_name: (recipient.name || '').split(' ')[0] || '-',
      last_name:  (recipient.name || '').split(' ').slice(1).join(' ') || '-',
      email:      (recipient.email || '').trim() || undefined,
      phone:      (recipient.phone || '').trim() || undefined,
      country:    recipient.country || '',
      region:     recipient.region || '',
      address1:   recipient.address1 || '',
      address2:   recipient.address2 || '',
      city:       recipient.city || '',
      zip:        recipient.zip || ''
    }
  };

  console.log('📦 Final Printify BATCH payload:', JSON.stringify(payload, null, 2));

  const orderUrl = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/orders.json`;
  const orderResp = await safeFetch(orderUrl, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  return orderResp;
}
