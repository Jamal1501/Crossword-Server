import { TTLCache } from '../lib/cache.js';

const PRODUCTS_CACHE_TTL_MS = Number(process.env.LF_PRODUCTS_CACHE_TTL_MS || 60_000);
const PRODUCT_SPECS_CACHE_TTL_MS = Number(process.env.LF_PRODUCT_SPECS_CACHE_TTL_MS || 300_000);

export function registerCatalogRoutes(app, deps) {
  const {
    variantMap,
    printAreas,
    PRINT_AREAS_PATH,
    SAFE_SELECTOR_PLACEHOLDER,
    pickThemeKey,
    getAllowedShopifyVariantIdsForTheme,
    getSelectorImageForProduct,
    fetchAllProductsPagedFiltered,
    verifyCatalogPair,
    getVariantPlaceholderNames,
    safeFetch,
    getVariantPlaceholderByPos,
    PRINTIFY_BASE,
    SHOP_ID,
    PIFY_HEADERS
  } = deps;

  const productsCache = new TTLCache({ ttlMs: PRODUCTS_CACHE_TTL_MS, max: 32 });
  const productSpecsCache = new TTLCache({ ttlMs: PRODUCT_SPECS_CACHE_TTL_MS, max: 512 });
  const inflightProducts = new Map();
  const inflightSpecs = new Map();

  async function getProductsResponseCached(themeKey, buildFn) {
    const key = String(themeKey || 'default');
    const hit = productsCache.get(key);
    if (hit) return hit;
    if (inflightProducts.has(key)) return inflightProducts.get(key);

    const p = (async () => {
      try {
        const data = await buildFn();
        productsCache.set(key, data);
        return data;
      } finally {
        inflightProducts.delete(key);
      }
    })();

    inflightProducts.set(key, p);
    return p;
  }

  async function getProductSpecsCached(variantId, buildFn) {
    const key = String(variantId);
    const hit = productSpecsCache.get(key);
    if (hit) return hit;
    if (inflightSpecs.has(key)) return inflightSpecs.get(key);

    const p = (async () => {
      try {
        const data = await buildFn();
        productSpecsCache.set(key, data);
        return data;
      } finally {
        inflightSpecs.delete(key);
      }
    })();

    inflightSpecs.set(key, p);
    return p;
  }

  async function buildProductSpecsPayload(variantId) {
    console.log(`[product-specs] Looking up variant ${variantId}`);

    const products = await fetchAllProductsPagedFiltered();
    const product = products.find(p => p?.variants?.some(v => Number(v.id) === variantId));

    if (!product) {
      console.warn(`⚠️ Variant ${variantId} not found among ${products.length} visible products`);
      return {
        status: 404,
        body: {
          ok: false,
          error: `Variant ${variantId} not found`,
          has_back: false,
          scanned_products: products.length
        }
      };
    }

    const bp = Number(product.blueprint_id);
    const pp = Number(product.print_provider_id);

    if (!bp || String(bp).length < 3 || bp === 1111 || bp === 11111) {
      console.warn(`⚠️ Invalid blueprint ${bp} for product "${product.title}"`);
      return {
        status: 200,
        body: {
          ok: true,
          variant_id: variantId,
          product_id: product.id,
          title: product.title,
          has_back: false,
          hasBack: false,
          error: 'Invalid blueprint'
        }
      };
    }

    let catalogPair = null;
    try {
      catalogPair = await verifyCatalogPair(bp, pp, variantId);
    } catch (e) {
      console.warn(`⚠️ Catalog verification failed for variant ${variantId}:`, e.message);
      return {
        status: 200,
        body: {
          ok: true,
          variant_id: variantId,
          product_id: product.id,
          title: product.title,
          has_back: false,
          hasBack: false,
          error: 'Not in catalog'
        }
      };
    }

    let placeholders = ['front'];
    try {
      placeholders = await getVariantPlaceholderNames(bp, pp);
    } catch (_) {}

    try {
      const detail = await safeFetch(`${PRINTIFY_BASE}/shops/${SHOP_ID}/products/${product.id}.json`, { headers: PIFY_HEADERS });
      const fromProduct = (detail?.print_areas || [])
        .flatMap(a => (a?.placeholders || []).map(ph =>
          (ph?.position || ph?.name || '').toString().trim().toLowerCase()
        ))
        .filter(Boolean);
      placeholders = Array.from(new Set([...placeholders, ...fromProduct]));
    } catch (_) {}

    let placeholder_dims = { front: null, back: null };
    try {
      const vMeta = catalogPair?.variant || null;
      const phs = Array.isArray(vMeta?.placeholders) ? vMeta.placeholders : [];

      const pick = (positions) => {
        for (const pos of positions) {
          const want = String(pos || '').toLowerCase();
          const ph = phs.find(p => String(p?.position || '').toLowerCase() === want);
          if (ph && ph.width && ph.height) return { width: ph.width, height: ph.height, position: want };
        }
        return null;
      };

      placeholder_dims.front = pick(['front', 'default']) || await getVariantPlaceholderByPos(bp, pp, variantId, 'front');
      placeholder_dims.back = pick(['back', 'rear', 'reverse', 'backside', 'secondary'])
        || await getVariantPlaceholderByPos(bp, pp, variantId, 'back');
    } catch (_) {}

    const hasBack = placeholders.some(n => /back|rear|reverse|backside|secondary|alt/i.test(n));
    console.log(`✅ Variant ${variantId} specs: has_back=${hasBack}, placeholders=${placeholders.join(',')}`);

    return {
      status: 200,
      body: {
        ok: true,
        variant_id: variantId,
        product_id: product.id,
        title: product.title,
        visible: product.visible,
        is_locked: product.is_locked,
        blueprint_id: bp,
        print_provider_id: pp,
        placeholders,
        placeholder_dims,
        has_back: hasBack,
        hasBack
      }
    };
  }

  app.get('/apps/crossword/resolve-printify-variant/:shopifyVariantId', async (req, res) => {
    try {
      const shopifyVid = String(req.params.shopifyVariantId);
      if (!shopifyVid) {
        return res.status(400).json({ ok: false, error: 'Missing shopifyVariantId' });
      }
      const printifyVid = variantMap[shopifyVid];
      if (printifyVid) {
        return res.json({ ok: true, shopify_variant_id: shopifyVid, printify_variant_id: printifyVid });
      }
      console.warn(`⚠️ No Printify mapping for Shopify variant ${shopifyVid}`);
      return res.status(404).json({ ok: false, error: 'No Printify mapping found', shopify_variant_id: shopifyVid });
    } catch (err) {
      console.error('❌ resolve-printify-variant error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/print-areas', (req, res) => {
    res.json({
      path: PRINT_AREAS_PATH,
      count: Object.keys(printAreas).length,
      sampleKeys: Object.keys(printAreas).slice(0, 20)
    });
  });

  app.get('/print-areas.json', (req, res) => {
    res.json(printAreas);
  });

  app.get('/apps/crossword/products', async (req, res) => {
    try {
      const DEFAULT_AREA = { width: 800, height: 500, top: 50, left: 50 };
      const themeKey = pickThemeKey(req);

      const payload = await getProductsResponseCached(themeKey, async () => {
        const allowedShopifyVariantIds = await getAllowedShopifyVariantIdsForTheme(themeKey);

        const rev = {};
        for (const [shopVid, pifyVid] of Object.entries(variantMap || {})) {
          const k = String(pifyVid);
          if (!rev[k]) rev[k] = [];
          rev[k].push(String(shopVid));
        }

        const pifyProducts = await fetchAllProductsPagedFiltered();
        const out = [];

        for (const p of pifyProducts) {
          const selector = getSelectorImageForProduct(themeKey, p.id);
          const img = (selector && selector.primary) ? selector.primary : SAFE_SELECTOR_PLACEHOLDER;
          const gallery = (selector && selector.gallery) ? selector.gallery : [];

          let mappedVariants = (p.variants || []).filter(v => rev[String(v.id)] && rev[String(v.id)][0]);

          if (allowedShopifyVariantIds) {
            mappedVariants = mappedVariants.filter(v => {
              const shopVid = rev[String(v.id)]?.[0];
              return shopVid && allowedShopifyVariantIds.has(String(shopVid));
            });
          }

          if (!mappedVariants.length) continue;

          const pref = mappedVariants[0];
          const firstShopifyVid = rev[String(pref.id)][0];

          const variantList = mappedVariants.map(v => {
            const shopVid = rev[String(v.id)][0];
            return {
              title: v.title || '',
              shopifyVariantId: shopVid,
              printifyVariantId: v.id,
              price: parseFloat(v.price) || 0,
              options: { option1: null, option2: null, option3: null },
              printArea: printAreas[shopVid] || DEFAULT_AREA
            };
          });

          const allVariantList = (p.variants || []).map(v => {
            const shopVid = (rev[String(v.id)] || [null])[0];
            return {
              title: v.title || '',
              shopifyVariantId: shopVid ? String(shopVid) : '',
              printifyVariantId: v.id || null,
              price: parseFloat(v.price) || 0,
              options: { option1: null, option2: null, option3: null },
              printArea: shopVid ? (printAreas[String(shopVid)] || DEFAULT_AREA) : DEFAULT_AREA,
              image: img
            };
          });

          out.push({
            id: p.id,
            printifyVariantId: pref.id,
            variants: variantList,
            title: p.title,
            optionNames: [],
            handle: '',
            image: img,
            gallery,
            shopifyVariantId: String(firstShopifyVid || ''),
            printifyProductId: p.id,
            variantId: firstShopifyVid ? Number(firstShopifyVid) : null,
            price: parseFloat(pref.price) || 0,
            printArea: printAreas[String(firstShopifyVid)] || DEFAULT_AREA,
            allVariants: allVariantList
          });
        }

        return { products: out };
      });

      res.json(payload);
    } catch (err) {
      console.error('❌ /apps/crossword/products failed:', err);
      res.status(500).json({ error: 'Failed to load products', details: err.message });
    }
  });

  app.get('/apps/crossword/product-specs/:variantId', async (req, res) => {
    try {
      const variantId = Number(req.params.variantId);

      if (!variantId || isNaN(variantId)) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid variantId',
          received: req.params.variantId
        });
      }

      const payload = await getProductSpecsCached(variantId, async () => buildProductSpecsPayload(variantId));
      return res.status(payload.status).json(payload.body);
    } catch (err) {
      console.error('❌ product-specs error:', err);
      return res.status(500).json({ ok: false, error: err.message, has_back: false });
    }
  });

  app.get('/apps/crossword/debug/variant/:variantId/live', async (req, res) => {
    try {
      const variantId = Number(req.params.variantId);
      const products = await fetchAllProductsPagedFiltered();
      const matched = products.find(p => p?.variants?.some(v => Number(v.id) === variantId));
      if (!matched) {
        return res.status(404).json({
          ok: false,
          message: `Variant ${variantId} not found among visible products`,
          total: products.length
        });
      }
      res.json({
        ok: true,
        variant_id: variantId,
        product_id: matched.id,
        title: matched.title,
        visible: matched.visible,
        is_locked: matched.is_locked,
        blueprint_id: matched.blueprint_id,
        print_provider_id: matched.print_provider_id
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
