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
    ...extra,
  };
}

/**
 * Generic helper that fails loudly and prints the full response body
 * so debugging never becomes a guessing game.
 */
async function safeFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${options.method || 'GET'} ${url} → ${res.status}\n${txt}`);
  }
  // Printify sometimes returns empty bodies (204). Guard for that.
  return res.status === 204 ? null : await res.json();
}

/* ─── Catalog helpers ────────────────────────────────────────────────────── */

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
  const res = await safeFetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  return res; // { id, file_url, ... }
}

/* ─── Product creation ───────────────────────────────────────────────────── */

export async function createProduct({
  imageUrl,
  title = 'Crossword Mug',
  description = 'Auto‑generated crossword design',
  tags = ['Crossword', 'Mug'],
  blueprintId = 30,      // 11oz ceramic mug
  printProviderId,       // optional → auto‑select first provider that supports blueprint
  variantId,             // optional → auto‑select first enabled variant
  x = 0.5,
  y = 0.5,
  scale = 1.0,
  background = '#ffffff',
  priceCents = 1500,
}) {
  /* — 1. Resolve catalog choices if caller didn’t provide them — */
  if (!printProviderId) {
    const providers = await listPrintProviders(blueprintId);
    if (!providers?.length) throw new Error(`No providers found for blueprint ${blueprintId}`);
    printProviderId = providers[0].id;
  }

  if (!variantId) {
    const variants = await listVariants(blueprintId, printProviderId);
    const enabled = variants?.find(v => v.is_enabled) || variants?.[0];
    if (!enabled) throw new Error(`No variants found for provider ${printProviderId} & blueprint ${blueprintId}`);
    variantId = enabled.id;
  }

  /* — 2. Upload artwork — */
  const uploaded = await uploadImage(imageUrl);

  /* — 3. Build product payload — */
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

  /* — 4. Fire away — */
  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products.json`;
  return safeFetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
}

/* ─── Convenience endpoint for your Express route ───────────────────────── */

export async function createTestProduct() {
  return createProduct({
    imageUrl: 'https://images.printify.com/mockup/5eab35e671d9b10001ec9f82.png',
  });
}
