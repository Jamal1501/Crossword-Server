/* scripts/build-printify-master.js
   Generates a master mapping file:
   - Printify product -> variants -> Shopify variant ids -> mockup URLs grouped by camera_label
   - Adds placeholderSizeByPosition ONCE per product (using canonical variant + your backend endpoint)
*/

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

// Adjust if your files live elsewhere
const VARIANT_MAP_PATH = path.join(ROOT, "variant-map.json");
const VARIANT_MAP_NOTES_PATH = path.join(ROOT, "variant-map.notes.json");

// Your backend already serves this JSON
const BASE_URL =
  process.env.LF_BASE_URL || "https://crossword-server-aey0.onrender.com";
const PRODUCTS_URL = `${BASE_URL.replace(/\/$/, "")}/api/printify/products/`;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function getCameraLabel(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("camera_label") || "unknown";
  } catch {
    // fallback: if URL parsing fails
    const m = String(url).match(/camera_label=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "unknown";
  }
}

// Reverse map: PrintifyVariantId -> [ShopifyVariantId...]
function buildReverseVariantMap(shopifyToPrintify) {
  const out = {};
  for (const [shopifyVid, printifyVid] of Object.entries(shopifyToPrintify)) {
    const p = String(printifyVid);
    if (!out[p]) out[p] = [];
    out[p].push(String(shopifyVid));
  }
  return out;
}

async function fetchPlaceholderSize({ baseUrl, variantId, position }) {
  const url =
    `${baseUrl.replace(/\/$/, "")}` +
    `/apps/crossword/placeholder-size?variantId=${encodeURIComponent(
      variantId
    )}&position=${encodeURIComponent(position)}`;

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    throw new Error(`placeholder-size ${r.status} for ${variantId} ${position}`);
  }
  return await r.json(); // { width, height }
}

async function main() {
  if (!fs.existsSync(VARIANT_MAP_PATH)) {
    throw new Error(`Missing ${VARIANT_MAP_PATH}`);
  }

  const shopifyToPrintify = readJson(VARIANT_MAP_PATH);
  const reverse = buildReverseVariantMap(shopifyToPrintify);

  let notes = null;
  if (fs.existsSync(VARIANT_MAP_NOTES_PATH)) {
    try {
      notes = readJson(VARIANT_MAP_NOTES_PATH);
    } catch {
      notes = null;
    }
  }

  const res = await fetch(PRODUCTS_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${PRODUCTS_URL} -> ${res.status}`);
  const payload = await res.json();

  const products = Array.isArray(payload?.data) ? payload.data : [];

  const master = {
    generatedAt: new Date().toISOString(),
    source: PRODUCTS_URL,
    counts: { products: products.length },
    products: [],
  };

  for (const p of products) {
    const productId = String(p.id || "");
    const title = String(p.title || "");

    // options summarized
    const options = (p.options || []).map((o) => ({
      name: o.name,
      type: o.type,
      values: (o.values || []).map((v) => ({ id: v.id, title: v.title })),
    }));

    // variants with reverse map to shopify variant ids
    const variants = (p.variants || []).map((v) => ({
      printifyVariantId: String(v.id),
      title: v.title,
      options: Array.isArray(v.options) ? v.options : [],
      shopifyVariantIds: reverse[String(v.id)] || [],
    }));

    // mockups grouped by camera_label
    const mockupsByCameraLabel = {};
    for (const img of p.images || []) {
      const src = img?.src;
      if (!src) continue;
      const label = getCameraLabel(src);
      if (!mockupsByCameraLabel[label]) mockupsByCameraLabel[label] = [];
      mockupsByCameraLabel[label].push({
        url: src,
        variantIds: (img.variant_ids || []).map(String),
        isDefault: !!img.is_default,
      });
    }

    // print areas (what you already have in the endpoint)
    const printAreas = (p.print_areas || []).map((pa) => ({
      variantIds: (pa.variant_ids || []).map(String),
      placeholders: (pa.placeholders || []).map((ph) => ({
        position: ph.position,
        decorationMethod: ph.decoration_method,
        background: pa.background || null,
        images: (ph.images || []).map((i) => ({
          src: i.src,
          width: i.width,
          height: i.height,
          x: i.x,
          y: i.y,
          scale: i.scale,
          angle: i.angle,
        })),
      })),
    }));

    // --- Canonical placeholder sizes (ONCE per product) ---
    const printAreasRaw = Array.isArray(p.print_areas) ? p.print_areas : [];
    const canonicalPrintifyVariantId =
      (printAreasRaw[0]?.variant_ids &&
        String(printAreasRaw[0].variant_ids[0] ?? "")) ||
      (p.variants?.[0]?.id ? String(p.variants[0].id) : "");

    // Gather unique placeholder positions mentioned in print_areas (front/back/etc)
    const positionsSet = new Set();
    for (const pa of printAreasRaw) {
      for (const ph of pa.placeholders || []) {
        if (ph?.position) positionsSet.add(String(ph.position));
      }
    }
    if (positionsSet.size === 0) positionsSet.add("front");

    const placeholderSizeByPosition = {};
    if (canonicalPrintifyVariantId) {
      for (const pos of positionsSet) {
        try {
          const size = await fetchPlaceholderSize({
            baseUrl: BASE_URL,
            variantId: canonicalPrintifyVariantId,
            position: pos,
          });
          placeholderSizeByPosition[pos] = {
            width: Number(size?.width) || null,
            height: Number(size?.height) || null,
          };
        } catch (e) {
          placeholderSizeByPosition[pos] = {
            width: null,
            height: null,
            error: String(e?.message || e),
          };
        }
      }
    }

    // optional: link to notes info if available
    const noteMatches = Array.isArray(notes)
      ? notes.filter((n) => String(n.printifyProductId || "") === productId)
      : [];

    master.products.push({
      printifyProductId: productId,
      title,
      blueprintId: p.blueprint_id ?? null,
      printProviderId: p.print_provider_id ?? null,

      // NEW
      canonicalPrintifyVariantId,
      placeholderSizeByPosition,

      options,
      variants,
      mockupsByCameraLabel,
      printAreas,
      notes: noteMatches,
    });
  }

  const outDir = path.join(ROOT, "generated");
  ensureDir(outDir);

  const outPath = path.join(outDir, "printify-master.json");
  fs.writeFileSync(outPath, JSON.stringify(master, null, 2), "utf8");

  console.log(`✅ Wrote: ${outPath}`);
  console.log(`Products: ${master.products.length}`);
}

main().catch((err) => {
  console.error("❌ build-printify-master failed:");
  console.error(err);
  process.exit(1);
});
