import fetch from 'node-fetch';

const BASE_URL = 'https://api.printify.com/v1';
const { PRINTIFY_API_KEY, PRINTIFY_SHOP_ID } = process.env;

if (!PRINTIFY_API_KEY || !PRINTIFY_SHOP_ID) {
  throw new Error('Missing PRINTIFY_API_KEY or PRINTIFY_SHOP_ID env vars');
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${PRINTIFY_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Crossword-Automation/1.0',
    ...extra,
  };
}

/**
 * Wrapper around fetch that ALWAYS throws when the response is not ok and
 * prints the response body in the error so you can actually debug.
 */
async function safeFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${options.method || 'GET'} ${url} → ${res.status}\n${txt}`);
  }
  return res.status === 204 ? null : await res.json();
}

/* ─── Catalog helpers ────────────────────────────────────────────────────── */

export async function listBlueprints() {
  const url = `${BASE_URL}/catalog/blueprints.json`;
  return safeFetch(url, { headers: authHeaders() });
}

export async function findBlueprintId(keyword = 'mug') {
  const blueprints = await listBlueprints();
  const found = blueprints.find(b =>
    b.title.toLowerCase().includes(keyword.toLowerCase())
  );
  if (!found) throw new Error(`No blueprint matching "${keyword}"`);
  return found.id;
}

export async function listPrintProviders(blueprintId) {
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers.json`;
  return safeFetch(url, { headers: authHeaders() });
}

export async function listVariants(blueprintId, printProviderId) {
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`;
  return safeFetch(url, { headers: authHeaders() });
}

/* ─── Shop helpers ───────────────────────────────────────────────────────── */

export async function getShopId() {
  const url = `${BASE_URL}/shops.json`;
  const data = await safeFetch(url, { headers: authHeaders() });
  return data?.[0]?.id ?? null;
}

/* ─── Upload artwork ─────────────────────────────────────────────────────── */

export async function uploadImage(fileUrl) {
  const url = `${BASE_URL}/uploads/images.json`;
  const body = { file_url: fileUrl };
  return safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

/* ─── Product creation ───────────────────────────────────────────────────── */

export async function createProduct({
  imageUrl,
  title = 'Crossword Mug',
  description = 'Auto-generated crossword design',
  tags = ['Crossword', 'Mug'],
  blueprintKeyword = 'Ceramic Mug', // more robust than hard‑coding ID
  blueprintId,
  printProviderId,
  variantId,
  x = 0.5,
  y = 0.5,
  scale = 1.0,
  background = '#ffffff',
  priceCents = 1500,
}) {
  /* — 1. Resolve blueprint first — */
  if (!blueprintId) {
    blueprintId = await findBlueprintId(blueprintKeyword);
  }

  /* — 2. Resolve provider / variant — */
  if (!printProviderId) {
    const providers = await listPrintProviders(blueprintId);
    if (!providers?.length) throw new Error(`No providers for blueprint ${blueprintId}`);
    printProviderId = providers[0].id;
  }

  if (!variantId) {
    const variants = await listVariants(blueprintId, printProviderId);
    const enabled = variants.find(v => v.is_enabled) || variants[0];
    if (!enabled) throw new Error(`No variants for provider ${printProviderId}`);
    variantId = enabled.id;
  }

  /* — 3. Upload artwork — */
  const uploaded = await uploadImage(imageUrl);

  /* — 4. Prepare product payload — */
  const payload = {
    title,
    description,
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    tags,
    variants: [
      {
        id: variantId,
        price: priceCents,
        is_enabled: true,
      },
    ],
    print_areas: [
      {
        variant_ids: [variantId],
        placeholders: [
          {
            position: 'front',
            images: [
              {
                id: uploaded.id,
                x,
                y,
                scale,
              },
            ],
          },
        ],
        background,
      },
    ],
    is_visible: true,
  };

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products.json`;
  return safeFetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
}

/* ─── Convenience test endpoint — lets your route stay simple ───────────── */
export async function createTestProduct() {
  return createProduct({
    imageUrl: 'https://images.printify.com/mockup/5eab35e671d9b10001ec9f82.png',
  });
}
