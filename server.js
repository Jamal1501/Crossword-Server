// server.js (cleaned)
import fs from 'fs/promises';
import express from 'express';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import cors from 'cors';
import fetch from 'node-fetch';
import { v2 as cloudinary } from 'cloudinary';
import * as printifyService from './services/printifyService.js';
import { safeFetch } from './services/printifyService.js';
import dotenv from 'dotenv';
import { generateMap } from './scripts/generateVariantMap.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb } from 'pdf-lib';
import axios from 'axios';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRINT_AREAS_PATH = path.join(__dirname, 'print-areas.json');

const whitelist = [
  /^https:\/\/[^.]+\.myshopify\.com$/,          // your preview/admin storefront
  /^https:\/\/[a-z0-9-]+\.shopifypreview\.com$/, // theme previews
  /^https:\/\/loveframes\.shop$/                 // production
];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || origin === 'null') return callback(null, true);
    const ok = whitelist.some((re) => re.test(origin));
    return ok ? callback(null, true) : callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Shopify-Topic',
    'X-Shopify-Order-Id',
    'X-Shopify-Hmac-Sha256',
    'X-Shopify-Webhook-Id'
  ],
  credentials: true,
};

const { createOrder } = printifyService;
const app = express();

// --- CORS & parsers (run BEFORE routes) ---
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });

// Shopify webhook needs raw body (must be before any JSON parser)
app.use('/webhooks/orders/create', bodyParser.raw({ type: 'application/json', limit: '2mb' }));

// Normal JSON parsers for everything else
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Idempotency for Shopify webhooks (process each order only once per server lifetime)
const processedShopifyOrders = new Set();

// --- load variant map (existing) ---
let variantMap = {};
try {
  const json = await fs.readFile('./variant-map.json', 'utf-8');
  variantMap = JSON.parse(json);
  console.log('✅ Loaded variant-map.json with', Object.keys(variantMap).length, 'entries');
} catch (err) {
  console.error('❌ Failed to load variant-map.json:', err.message);
}

// --- load print areas ---
let printAreas = {};
try {
  const json = await fs.readFile(PRINT_AREAS_PATH, 'utf-8');
  printAreas = JSON.parse(json);
  console.log('✅ Loaded print-areas.json from', PRINT_AREAS_PATH, 'with', Object.keys(printAreas).length, 'entries');
} catch (err) {
  console.warn('ℹ️ No print-areas.json at', PRINT_AREAS_PATH, '→ fallback:', err.message);
}

// Debug route: confirm the server actually loaded your file
app.get('/print-areas', (req, res) => {
  res.json({
    path: PRINT_AREAS_PATH,
    count: Object.keys(printAreas).length,
    sampleKeys: Object.keys(printAreas).slice(0, 20)
  });
});

// Dynamic area route used by the theme
app.get('/print-area/:variantId', (req, res) => {
  const id = String(req.params.variantId);
  const area = printAreas[id];
  if (!area) {
    return res.status(404).json({ ok: false, error: 'No print area for variant', variantId: id });
  }
  return res.json({ ok: true, area });
});

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const PDF_TOKEN_SECRET = process.env.PDF_TOKEN_SECRET || 'dev_change_me';
const SHOPIFY_APP_PROXY_SECRET = process.env.SHOPIFY_APP_PROXY_SECRET || '';
const PaidPuzzles = new Map(); // puzzleId -> { orderId, email, crosswordImage, cluesImage, when }

function issuePdfToken(puzzleId, orderId) {
  return crypto.createHmac('sha256', PDF_TOKEN_SECRET)
    .update(`${puzzleId}|${orderId}`)
    .digest('hex');
}

function verifyPdfToken(puzzleId, orderId, token) {
  return token && token === issuePdfToken(puzzleId, orderId);
}

// Verify Shopify App Proxy signature on /apps/crossword/* endpoints
function verifyAppProxy(req) {
  const sig = req.query.signature;
  if (!sig || !SHOPIFY_APP_PROXY_SECRET) return false;
  const qp = { ...req.query };
  delete qp.signature;
  const query = Object.keys(qp).sort().map(k => `${k}=${qp[k]}`).join('&');
  const pathOnly = req.originalUrl.split('?')[0];
  const message = query ? `${pathOnly}?${query}` : pathOnly;
  const digest = crypto.createHmac('sha256', SHOPIFY_APP_PROXY_SECRET).update(message).digest('hex');
  return digest === sig;
}

async function handlePrintifyOrder(order) {
  // Flatten useful fields from Shopify line items
  const items = order.line_items.map((item) => {
    const props = Array.isArray(item.properties) ? item.properties : [];

    const getProp = (name) => {
      const p = props.find(x => x && x.name === name);
      return p ? String(p.value || '') : '';
    };

    const custom_image      = getProp('_custom_image');
    const clues_image_url   = getProp('_clues_image_url');   // 🔹 clues image (if generated)
    const clue_output_mode  = getProp('_clue_output');       // 🔹 'back' | 'postcard' | 'none'

    const design_specs_raw  = getProp('_design_specs');
    const design_specs = design_specs_raw ? (() => { try { return JSON.parse(design_specs_raw); } catch { return null; } })() : null;

    return {
      title: item.title,
      variant_id: item.variant_id,              // Shopify variant ID
      quantity: item.quantity || 1,
      custom_image,
      clues_image_url,
      clue_output_mode,
      design_specs
    };
  });

  for (const item of items) {
    if (!item.custom_image || !item.variant_id) {
      console.warn('⚠️ Skipping item (missing image or variant):', {
        title: item.title, variant: item.variant_id, hasImage: !!item.custom_image
      });
      continue;
    }

    const shopifyVid = String(item.variant_id);
    const printifyVariantId = variantMap[shopifyVid];
    if (!printifyVariantId) {
      console.warn(`⛔ No Printify mapping for Shopify variant ${shopifyVid}. Known keys sample:`,
        Object.keys(variantMap).slice(0, 10));
      continue;
    }

    // Optional: per-variant print area (width/height/top/left)
    const area = printAreas?.[shopifyVid] || null;

    // Derive scale from design_specs.size (prefer percentages); fallback 1.0
    let scale = 1.0;
    const sizeVal = item.design_specs?.size;
    if (typeof sizeVal === 'string') {
      const s = sizeVal.trim();
      if (s.endsWith('%')) {
        const pct = parseFloat(s);
        if (!Number.isNaN(pct)) scale = Math.max(0.1, Math.min(2, pct / 100));
      } else if (s.endsWith('px') && area?.width) {
        const px = parseFloat(s);
        if (!Number.isNaN(px)) scale = Math.max(0.1, Math.min(2, px / area.width));
      }
    }

    // Compute normalized center from editor offsets (top/left were pixels in the print area)
    const topPx  = parseFloat(item.design_specs?.top || '0');
    const leftPx = parseFloat(item.design_specs?.left || '0');
    let x = 0.5, y = 0.5;
    if (area && Number.isFinite(area.width) && Number.isFinite(area.height)) {
      const imgW = area.width  * scale;
      const imgH = area.height * scale;
      x = Math.min(1, Math.max(0, (leftPx + imgW / 2) / area.width));
      y = Math.min(1, Math.max(0, (topPx  + imgH / 2) / area.height));
    }
    const position = { x, y, scale, angle: 0 };

    const recipient = {
      name: `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim(),
      email: order.email,
      phone: order.phone || '',
      address1: order.shipping_address?.address1 || '',
      city: order.shipping_address?.city || '',
      zip: order.shipping_address?.zip || '',
      country: order.shipping_address?.country_code || ''
    };

    // 🔹 Only send back image to Printify if user chose to print clues on back
    const backImageUrl =
      item.clue_output_mode === 'back' && item.clues_image_url ? item.clues_image_url : undefined;

    try {
      const response = await createOrder({
        imageUrl: item.custom_image,
        backImageUrl,                     // ✅ NEW: pass back image for printing on back (when selected)
        variantId: printifyVariantId,
        quantity: item.quantity,
        position,
        recipient,
        printArea: area || undefined,
        meta: { shopifyVid, title: item.title }
      });
      console.log('✅ Printify order created:', response?.id || '[no id]', { shopifyVid, printifyVariantId, scale });
    } catch (err) {
      console.error('❌ Failed to create Printify order:', { shopifyVid, printifyVariantId, scale, err: err?.message || err });
    }
  }
}

app.post('/webhooks/orders/create', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const rawBody = req.body;

  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  if (digest !== hmac) {
    console.warn('⚠️ Webhook HMAC verification failed.');
    return res.status(401).send('HMAC validation failed');
  }

  const order = JSON.parse(rawBody.toString());
  console.log('✅ Verified webhook for order:', order.id);

    // [ADD] Record paid puzzleIds and their assets for PDF
  try {
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const seen = [];

    for (const li of lineItems) {
      const props = Array.isArray(li.properties) ? li.properties : [];
      const getProp = (name) => {
        const p = props.find(x => x && x.name === name);
        return p ? String(p.value || '') : '';
      };

      const pid = getProp('_puzzle_id');
      if (!pid) continue;

      const crosswordImage = getProp('_custom_image');      // from addToCart
      const cluesImage     = getProp('_clues_image_url');   // always added in 1C

      PaidPuzzles.set(pid, {
        orderId: String(order.id),
        email: (order.email || order?.customer?.email || '') + '',
        crosswordImage,
        cluesImage,
        when: new Date().toISOString(),
      });
      seen.push(pid);
    }

    if (seen.length) {
      console.log('🔐 Stored paid puzzleIds:', seen);
    }
  } catch (e) {
    console.error('❌ Failed to index paid puzzleIds', e);
  }

  // 🚫 prevent duplicate processing across redeploys / retries
  if (processedShopifyOrders.has(order.id)) {
    console.log('🛑 Duplicate webhook skipped for order', order.id);
    return res.status(200).send('ok (duplicate ignored)');
  }
  processedShopifyOrders.add(order.id);
    // [ADD] Record paid puzzleIds and their assets for PDF
  try {
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const seen = [];

    for (const li of lineItems) {
      const props = Array.isArray(li.properties) ? li.properties : [];
      const getProp = (name) => {
        const p = props.find(x => x && x.name === name);
        return p ? String(p.value || '') : '';
      };

      const pid = getProp('_puzzle_id');
      if (!pid) continue;

      const crosswordImage = getProp('_custom_image');      // from addToCart
      const cluesImage     = getProp('_clues_image_url');   // we added in A.3

      PaidPuzzles.set(pid, {
        orderId: String(order.id),
        email: (order.email || order?.customer?.email || '') + '',
        crosswordImage,
        cluesImage,
        when: new Date().toISOString(),
      });
      seen.push(pid);
    }

    if (seen.length) {
      console.log('🔐 Stored paid puzzleIds:', seen);
    }
  } catch (e) {
    console.error('❌ Failed to index paid puzzleIds', e);
  }

  await handlePrintifyOrder(order);
  res.status(200).send('Webhook received');
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.post('/admin/generate-variant-map', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const map = await generateMap();
    res.json({ success: true, generated: map });
  } catch (err) {
    console.error('❌ Variant map generation failed:', err);
    res.status(500).json({ error: 'Failed to generate variant map', details: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/printify/test', async (req, res) => {
  try {
    const shopId = await printifyService.getShopId();
    res.json({ success: true, shopId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Printify API failed', details: err.message });
  }
});

app.get('/api/printify/test-variant', async (req, res) => {
  try {
    const blueprintId = await printifyService.findBlueprintId('mug');
    const providers = await printifyService.listPrintProviders(blueprintId);
    const variants = await printifyService.listVariants(blueprintId, providers[0].id);
    const variant = variants.find(v => v.is_enabled !== false) || variants[0];

    res.json({ variantId: variant.id, title: variant.title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch variant', details: err.message });
  }
});

app.get('/admin/regenerate-variant-map', async (req, res) => {
  try {
    variantMap = await generateMap();
    res.send('✅ Variant map regenerated and saved.');
  } catch (err) {
    console.error('❌ Error generating variant map:', err.message, err.stack);
    res.status(500).send(`Failed to regenerate variant map: ${err.message}`);
  }
});

const submittedOrders = new Set();  // memory-only cache

app.post('/api/printify/order', async (req, res) => {
  try {
    const {
      imageUrl,
      backImageUrl,          // ✅ NEW
      base64Image,
      variantId,
      position,
      recipient,
      quantity
    } = req.body;

    const { orderId } = req.body;
    console.log('Received orderId:', orderId);

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId', success: false });
    }

    if (submittedOrders.has(orderId)) {
      console.log('Duplicate order blocked:', orderId);
      return res.status(200).json({ success: true, duplicate: true });
    }
    submittedOrders.add(orderId);

    if (!imageUrl && !base64Image) {
      return res.status(400).json({ error: 'Either imageUrl or base64Image is required', success: false });
    }
    if (!variantId || !recipient) {
      return res.status(400).json({ error: 'Missing required fields: variantId, recipient', success: false });
    }

    console.log('Creating order with:', {
      hasImageUrl: !!imageUrl,
      hasBase64: !!base64Image,
      hasBackImage: !!backImageUrl,
      variantId,
      recipient: recipient.name
    });

    const order = await createOrder({
      imageUrl,
      backImageUrl,          // ✅ pass through
      base64Image,
      variantId,
      quantity,
      position,
      recipient
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error('Order creation failed:', err);
    res.status(500).json({ error: 'Order creation failed', details: err.message });
  }
});


// Explicit preflight + CORS for this route (belt & suspenders)
app.options('/save-crossword', cors(corsOptions));
app.post('/save-crossword', cors(corsOptions), async (req, res) => {
  try {
    const { image } = req.body;

    if (!image || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid or missing image', success: false });
    }

    const result = await cloudinary.uploader.upload(image, {
      folder: 'crosswords',
      timeout: 60000,
    });

    res.json({ url: result.secure_url, success: true, public_id: result.public_id });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to save image', details: error.message, success: false });
  }
});

app.post('/api/printify/order-from-url', async (req, res) => {
  try {
    const { cloudinaryUrl, backImageUrl, variantId, position, recipient, quantity } = req.body;

    if (!cloudinaryUrl || !variantId || !recipient) {
      return res.status(400).json({ error: 'Missing required fields: cloudinaryUrl, variantId, recipient', success: false });
    }

    console.log('Creating order directly from Cloudinary URL:', {
      cloudinaryUrl,
      hasBackImage: !!backImageUrl
    });

    const order = await createOrder({
      imageUrl: cloudinaryUrl,
      backImageUrl,          // ✅ pass through
      variantId,
      quantity,
      position,
      recipient
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error('Order creation failed:', err);
    res.status(500).json({ error: 'Order creation failed', details: err.message });
  }
});


app.get('/products', async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/products.json`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
        },
      }
    );

    const allProducts = Array.isArray(response.data) ? response.data : response.data.data;

    const products = allProducts.map((product) => {
      const firstImage = product.images?.[0];
      const firstVariant = product.variants?.[0];

      return {
        title: product.title,
        image: firstImage?.src || '',
        variantId: firstVariant?.id || '',
        price: parseFloat(firstVariant?.price) || 15,
        printArea: { width: 300, height: 300, top: 50, left: 50 }
      };
    });
    res.json({ products });
  } catch (error) {
    console.error('❌ Printify fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch products from Printify' });
  }
});

app.get('/apps/crossword/products', async (req, res) => {
  try {
    const DEFAULT_AREA = { width: 800, height: 500, top: 50, left: 50 };

    const shopifyRes = await fetch(
      `https://${process.env.SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json`,
      { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_PASSWORD, 'Content-Type': 'application/json' } }
    );
    if (!shopifyRes.ok) throw new Error(`Shopify API error: ${shopifyRes.status}`);

    const { products: shopifyProducts } = await shopifyRes.json();

    // Map Printify variantId -> productId for later use
    const printifyListUrl = `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/products.json`;
    const printifyList = await safeFetch(printifyListUrl, {
      headers: {
        Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    // Ensure we have an array of products
    const pifyArray = Array.isArray(printifyList?.data)
      ? printifyList.data
      : (Array.isArray(printifyList) ? printifyList : []);

    const pifyVariantToProduct = new Map();
    for (const prod of pifyArray) {
      for (const v of (prod.variants || [])) {
        pifyVariantToProduct.set(v.id, prod.id);
      }
    }

    const out = [];
    for (const p of shopifyProducts) {
      if (!['active','draft'].includes(p.status)) continue;

      // prefer a variant we have a mapping for; otherwise take the first variant
      const mappedIds = new Set(Object.keys(variantMap));
      const preferred = p.variants.find(v => mappedIds.has(String(v.id))) || p.variants[0];
      if (!preferred) continue;

      const shopifyId = String(preferred.id);
      const printifyVariantId = variantMap[shopifyId] || null;
      const img = p.image?.src || p.images?.[0]?.src || '';
      const imageById = new Map();
(p.images || []).forEach(im => imageById.set(im.id, im.src));
      
      // Build per-variant list for size/color selection
      const variantList = (Array.isArray(p.variants) ? p.variants : [])
        .filter(v => mappedIds.has(String(v.id)))
        .map(v => ({
          title: v.title || [v.option1, v.option2, v.option3].filter(Boolean).join(' / '),
          shopifyVariantId: String(v.id),
          printifyVariantId: variantMap[String(v.id)] || null,
          price: parseFloat(v.price) || 0,
          options: { option1: v.option1, option2: v.option2, option3: v.option3 },
          printArea: printAreas[String(v.id)] || DEFAULT_AREA
        }));

      const allVariantList = (Array.isArray(p.variants) ? p.variants : [])
  .map(v => ({
    title: v.title || [v.option1, v.option2, v.option3].filter(Boolean).join(' / '),
    shopifyVariantId: String(v.id),
    // Still include (possibly null) mapping so UI can disable unorderable combos
    printifyVariantId: variantMap[String(v.id)] || null,
    price: parseFloat(v.price) || 0,
    options: { option1: v.option1, option2: v.option2, option3: v.option3 },
    printArea: printAreas[String(v.id)] || DEFAULT_AREA,
    // ADD: per-variant image
    image: imageById.get(v.image_id) || img
  }));
      
      const printifyProductId = printifyVariantId ? (pifyVariantToProduct.get(printifyVariantId) || null) : null;
// Fetch live placeholder for this Printify variant (front) — resilient
let liveArea = null;
if (printifyProductId && printifyVariantId) {
  const prodMeta = pifyArray.find(pr => pr.id === printifyProductId);
  const bp = Number(prodMeta?.blueprint_id);
  const pp = Number(prodMeta?.print_provider_id);

  if (prodMeta && Number.isFinite(bp) && Number.isFinite(pp)) {
    try {
      const variantsRes = await safeFetch(
        `https://api.printify.com/v1/catalog/blueprints/${bp}/print_providers/${pp}/variants.json`,
        {
          headers: {
            Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const vMeta = variantsRes?.variants?.find(v => v.id === parseInt(printifyVariantId));
      const ph = vMeta?.placeholders?.find(ph => ph.position === 'front');

      if (ph?.width && ph?.height) {
        liveArea = {
          width: ph.width,
          height: ph.height,
          top: ph.top || 0,
          left: ph.left || 0
        };
      }
    } catch (e) {
      console.warn(
        `⚠️ Skipping live placeholder fetch for product ${prodMeta?.title || prodMeta?.id} (blueprint ${bp}, provider ${pp}): ${e.message}`
      );
      // fall back to print-areas.json or DEFAULT_AREA below
    }
  } else {
    console.warn(
      `⚠️ Invalid blueprint/provider on product ${prodMeta?.title || prodMeta?.id}:`,
      { blueprint_id: prodMeta?.blueprint_id, print_provider_id: prodMeta?.print_provider_id }
    );
  }
}


      if (printifyProductId && printifyVariantId) {
  const prodMeta = pifyArray.find(pr => pr.id === printifyProductId);

  // Guard: ignore products missing sane blueprint/provider
  const bp = Number(prodMeta?.blueprint_id);
  const pp = Number(prodMeta?.print_provider_id);
  if (prodMeta && Number.isFinite(bp) && Number.isFinite(pp)) {
    try {
      const variantsRes = await safeFetch(
        `https://api.printify.com/v1/catalog/blueprints/${bp}/print_providers/${pp}/variants.json`,
        {
          headers: {
            Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      const vMeta = variantsRes?.variants?.find(v => v.id === printifyVariantId);
      const ph = vMeta?.placeholders?.find(ph => ph.position === 'front');
      if (ph?.width && ph?.height) {
        liveArea = { width: ph.width, height: ph.height, top: ph.top || 0, left: ph.left || 0 };
      }
    } catch (e) {
      console.warn(
        `⚠️ Skipping live placeholder fetch for product ${prodMeta?.title || prodMeta?.id} (blueprint ${bp}, provider ${pp}): ${e.message}`
      );
      // fall through → keep liveArea as null and use stored/default print area
    }
  }
}

          const optionNames = Array.isArray(p.options)
  ? p.options.map(o => (o.name || '').toLowerCase())
  : [];
      out.push({
        // new fields for editor preview
        id: p.id,      // Printify product ID
        printifyVariantId,          // Printify variant ID
        variants: variantList,
        title: p.title,
        optionNames,
        handle: p.handle || '',
        image: img || '',
        shopifyVariantId: String(preferred?.id || ''),
        printifyProductId,
        variantId: preferred?.id || null,
        price: parseFloat(preferred?.price) || 0,
        printArea: liveArea || printAreas[String(preferred?.id)] || DEFAULT_AREA,
         allVariants: allVariantList
      });
    }

    res.json({ products: out });
  } catch (err) {
    console.error('❌ Failed to load dynamic products:', err);
    res.status(500).json({ error: 'Failed to load products', details: err.message });
  }
});

import { uploadImageFromUrl, applyImageToProduct, applyImagesToProductDual, fetchProduct } from './services/printifyService.js';

app.get('/apps/crossword/preview-product/legacy', async (req, res) => {
  try {
    const { imageUrl, productId, variantId, backImageUrl } = req.query; // [ADD backImageUrl]

    // 1. Upload crossword image to Printify
    const uploadedImage = await uploadImageFromUrl(imageUrl);

    // 2. Apply image to product (updates mockups in Printify)
    const updatedProduct = await applyImageToProduct(productId, variantId, uploadedImage.id);

    // 3. Extract preview mockup URLs
    const previewImages = updatedProduct.images.map(img => img.src);

    // 4. Return them to frontend
    res.json({
      success: true,
      previewImages
    });
  } catch (err) {
    console.error("❌ Preview product error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/apps/crossword/preview-product', async (req, res) => {
  try {
    const { imageUrl, productId, variantId } = req.query;

    const backImageUrl = req.query.backImageUrl; // [ADD]
        const position = {
      x: req.query.x ? parseFloat(req.query.x) : 0.5,
      y: req.query.y ? parseFloat(req.query.y) : 0.5,
      scale: req.query.scale ? parseFloat(req.query.scale) : 1,
      angle: req.query.angle ? parseFloat(req.query.angle) : 0,
    }
          const backPosition = {
      x: req.query.x ? parseFloat(req.query.x) : 0.5,
      y: req.query.y ? parseFloat(req.query.y) : 0.5,
      scale: req.query.scale ? parseFloat(req.query.scale) : 1,
      angle: req.query.angle ? parseFloat(req.query.angle) : 0,
    };

    
    if (!imageUrl || !productId || !variantId) {
      return res.status(400).json({ error: "Missing required params: imageUrl, productId, variantId" });
    }

    // 1. Upload the crossword image
    const uploaded = await uploadImageFromUrl(imageUrl);
  let uploadedBack = null; // [ADD]
if (backImageUrl) {
  uploadedBack = await uploadImageFromUrl(backImageUrl);
}

if (uploadedBack?.id) {
  await applyImagesToProductDual(productId, parseInt(variantId), uploaded.id, uploadedBack.id, position,backPosition);
} else {
  await applyImageToProduct(productId, parseInt(variantId), uploaded.id, position);
}

   // 3. Poll for mockups (Printify needs a few seconds)
let product;
for (let attempt = 1; attempt <= 10; attempt++) {
  product = await fetchProduct(productId);
  const ready = Array.isArray(product?.images) && product.images.some(i => i?.src);
  if (ready) break;
  await new Promise(r => setTimeout(r, 1200)); // ~12s max
}

res.json({ success: true, uploadedImage: uploaded, product });

  } catch (err) {
    console.error("❌ Preview generation failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/printify/products', async (req, res) => {
  try {
    const url = `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/products.json`;
    const products = await safeFetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    res.json(products);
  } catch (err) {
    console.error('Error fetching products:', err.message);
    res.status(500).json({ error: 'Failed to fetch products', details: err.message });
  }
});

// GET a single Printify product (raw JSON, includes mockup image URLs when available)
app.get('/api/printify/products/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const url = `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/products/${productId}.json`;
    const data = await safeFetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Crossword-Preview/1.0'
      },
    });
    res.json(data);
  } catch (err) {
    console.error('❌ Failed to fetch product:', err.message);
    res.status(500).json({ error: 'Failed to fetch product', details: err.message });
  }
});

async function fetchPrintifyProducts() {
  const response = await fetch(
    `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/products.json`,
    { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` } },
  );
  if (!response.ok) throw new Error(`Printify API error: ${response.status}`);
  return response.json();
}

async function fetchShopifyProducts() {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json`,
    { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_PASSWORD } },
  );
  if (!response.ok) throw new Error(`Shopify API error: ${response.status}`);
  return response.json();
}

async function transformProducts(printifyData, shopifyData) {
  const products = await Promise.all(printifyData.data.map(async p => {
    const match = shopifyData.products.find(s =>
      s.title.toLowerCase().includes(p.title.toLowerCase()) ||
      p.title.toLowerCase().includes(s.title.toLowerCase())
    );

    let printArea = null;

    try {
      const variantRes = await safeFetch(`https://api.printify.com/v1/catalog/blueprints/${p.blueprint_id}/print_providers/${p.print_provider_id}/variants.json`, {
        headers: {
          Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const variant = variantRes?.variants?.find(v => v.id === p.variants[0]?.id);
      console.log('Variant object for', p.title, JSON.stringify(variant, null, 2));
      const area = variant?.placeholders?.find(p => p.position === 'front');
      console.log('Fetched print area for:', p.title, area);

      if (area) {
        printArea = {
          width: area.width,
          height: area.height,
          top: area.top || 0,
          left: area.left || 0
        };
      }
    } catch (err) {
      console.error(`Failed to fetch print area for ${p.title}:`, err.message);
    }

    return {
      id: p.id,
      title: p.title,
      image: p.images[0]?.src || 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
      price: parseFloat(p.variants[0]?.price) || 0,
      variantId: match?.variants[0]?.id?.toString() || '',
      shopifyProductId: match?.id || '',
      printArea
    };
  }));

  return {
    products: products.filter(prod => prod.variantId)
  };
}

const port = process.env.PORT || 8888;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${port}`);
  console.log(`Health check → http://localhost:${port}/health`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received: closing HTTP server');
  server.close(() => console.log('HTTP server closed'));
});

const PRINTIFY_API_KEY = process.env.PRINTIFY_API_KEY;

app.get('/preview', async (req, res) => {
  console.log('Received /preview request:', req.query); // Log the request

  const { productId, image, x = 0, y = 0, width = 300, height = 300 } = req.query;

  if (!productId || !image) {
    return res.status(400).json({ error: 'Missing productId or image' });
  }

  try {
    console.log('PRINTIFY_API_KEY:', process.env.PRINTIFY_API_KEY); // Log the API key

    // Fetch the first enabled variant for this product
    const variantsRes = await fetch(`https://api.printify.com/v1/catalog/products/${productId}/variants.json`, {
      headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` }
    });
    const variants = await variantsRes.json();
    const firstEnabled = variants.variants?.find(v => v.is_enabled) || variants.variants?.[0];

    const payload = {
      product_id: parseInt(productId),
      variant_ids: [firstEnabled?.id || 1],
      files: [
        {
          placement: 'front',
          image_url: image,
          position: { x: parseInt(x), y: parseInt(y), width: parseInt(width), height: parseInt(height) }
        }
      ]
    };

    const previewRes = await axios.post(
      'https://api.printify.com/v1/previews',
      payload,
      { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` } }
    );

    console.log('Printify API response:', previewRes.data); // Log the Printify API response

    res.json({ previewUrl: previewRes.data.preview_url });
  } catch (err) {
    console.error('Error in Printify API request:', err.response?.data || err.message);
    res.status(500).json({ error: 'Preview failed' });
  }
});

app.get('/admin/shopify-products', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const store = process.env.SHOPIFY_STORE;
    const apiKey = process.env.SHOPIFY_API_KEY;
    const password = process.env.SHOPIFY_PASSWORD;

    const authString = Buffer.from(`${apiKey}:${password}`).toString('base64');
    const response = await fetch(`https://${store}.myshopify.com/admin/api/2024-01/products.json`, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status}`);
    }

    const data = await response.json();

    const clean = data.products.flatMap(product =>
      product.variants.map(variant => ({
        productTitle: product.title,
        variantTitle: variant.title,
        shopifyVariantId: variant.id,
        sku: variant.sku,
      }))
    );

    res.json({ success: true, variants: clean });
  } catch (err) {
    console.error('❌ Shopify Admin API error:', err);
    res.status(500).json({ error: 'Shopify API error', details: err.message });
  }
});

app.get('/variant-map.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'variant-map.json'));
});

app.get('/debug/printify-variants', async (req, res) => {
  try {
    const shopId = process.env.PRINTIFY_SHOP_ID;
    const apiKey = process.env.PRINTIFY_API_KEY;

    const response = await fetch(`https://api.printify.com/v1/shops/${shopId}/products.json`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    const text = await response.text();
    console.log('🪵 Raw response from Printify:', text);

    const parsed = JSON.parse(text);

    if (!parsed || !Array.isArray(parsed.data)) {
      console.error('❌ Unexpected response format:', parsed);
      return res.status(500).send('Printify did not return a product list');
    }

    const result = parsed.data.map(p => ({
      productTitle: p.title,
      productId: p.id,
      variants: p.variants.map(v => ({
        title: v.title,
        variantId: v.id,
        sku: v.sku
      }))
    }));

    console.log('✅ Variant Dump:', JSON.stringify(result, null, 2));
    res.status(200).json(result);
  } catch (err) {
    console.error('❌ Error during variant fetch:', err);
    res.status(500).send('Internal error');
  }
});

app.get('/apps/crossword/mockup-products', (req, res) => {
  res.json({
    products: [
      {
        title: "Custom Crossword Mug",
        image: "https://cdn.shopify.com/s/files/1/0911/1951/8025/files/4235187304372348206_2048.jpg?v=1751919279",
        variantId: "52614764036425",
        price: 12.99,
        printArea: {
          width: 300,
          height: 300,
          top: 50,
          left: 50
        }
      }
    ]
  });
});

// =============================
// Get print areas for one product
// =============================
app.get("/apps/crossword/product-print-areas", async (req, res) => {
  try {
    const { productId } = req.query;
    if (!productId) {
      return res.status(400).json({ error: "Missing productId" });
    }

    // call Printify API
    const shopRes = await fetch("https://api.printify.com/v1/shops.json", {
      headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` },
    });
    const shops = await shopRes.json();
    const shopId = shops[0].id; // assuming you only use one shop

    const productRes = await fetch(
      `https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
      {
        headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` },
      }
    );
    const product = await productRes.json();

    return res.json({
      productId,
      title: product.title,
      print_areas: product.print_areas || [],
    });
  } catch (err) {
    console.error("Error fetching product print areas:", err);
    res.status(500).json({ error: "Failed to fetch product print areas" });
  }
});

// =============================
// Get print areas for all products
// =============================
app.get("/apps/crossword/all-print-areas", async (req, res) => {
  try {
    const shopRes = await fetch("https://api.printify.com/v1/shops.json", {
      headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` },
    });
    const shops = await shopRes.json();
    const shopId = shops[0].id;

    // get all products
    const productsRes = await fetch(
      `https://api.printify.com/v1/shops/${shopId}/products.json`,
      {
        headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` },
      }
    );
    const productsJson = await productsRes.json();
    const products = productsJson.data || []; // ✅ FIX

    const results = {};
    for (const prod of products) {
      const detailRes = await fetch(
        `https://api.printify.com/v1/shops/${shopId}/products/${prod.id}.json`,
        {
          headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` },
        }
      );
      const detail = await detailRes.json();
      results[prod.id] = {
        title: detail.title,
        print_areas: detail.print_areas || [],
      };
    }

    return res.json(results);
  } catch (err) {
    console.error("Error fetching all product print areas:", err);
    res.status(500).json({ error: "Failed to fetch all product print areas" });
  }
});

// Clean server code without App Proxy dependencies

// Direct purchase registration and PDF download (no App Proxy)
app.post('/register-purchase-and-download', async (req, res) => {
  try {
    const { puzzleId, orderId, crosswordImage, cluesImage } = req.body;
    
    console.log('Direct PDF request:', { puzzleId, orderId, hasImage: !!crosswordImage });
    
    if (!puzzleId || !orderId || !crosswordImage) {
      return res.status(400).json({ error: 'Missing required data' });
    }
    
    // Register the purchase (same as webhook would do)
    const purchaseRecord = {
      orderId: String(orderId),
      puzzleId: puzzleId,
      crosswordImage: crosswordImage,
      cluesImage: cluesImage || '',
      purchasedAt: new Date().toISOString(),
      method: 'direct'
    };
    
    PaidPuzzles.set(puzzleId, purchaseRecord);
    console.log(`Registered direct purchase: ${puzzleId}`);
    
    // Generate PDF immediately
    const a4w = 595.28, a4h = 841.89;
    const margin = 36;
    const maxW = a4w - margin * 2;
    const maxH = a4h - margin * 2;
    
    const fetchBuf = async (url) => {
      if (!url) return null;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Image fetch failed: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };
    
    const [puzzleBuf, cluesBuf] = await Promise.all([
      fetchBuf(crosswordImage),
      cluesImage ? fetchBuf(cluesImage) : Promise.resolve(null)
    ]);
    
    if (!puzzleBuf) {
      return res.status(422).json({ error: 'Could not fetch crossword image' });
    }
    
    const pdf = await PDFDocument.create();
    
    const addImagePage = async (buf) => {
      if (!buf) return;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const img = isPng ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
      const { width, height } = img.size();
      
      const scale = Math.min(maxW / width, maxH / height, 1);
      const w = width * scale, h = height * scale;
      const x = (a4w - w) / 2, y = (a4h - h) / 2;
      
      const page = pdf.addPage([a4w, a4h]);
      page.drawImage(img, { x, y, width: w, height: h });
    };
    
    await addImagePage(puzzleBuf);
    await addImagePage(cluesBuf);
    
    const pdfBytes = await pdf.save();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="crossword-${puzzleId.slice(0,8)}.pdf"`);
    return res.send(Buffer.from(pdfBytes));
    
  } catch (error) {
    console.error('Direct PDF generation failed:', error);
    return res.status(500).json({ error: 'PDF generation failed' });
  }
});

// Preview PDF with watermark (no authentication required)
app.get('/preview-pdf', async (req, res) => {
  try {
    const imageUrl = String(req.query.imageUrl || '');
    const cluesUrl = String(req.query.cluesUrl || '');
    
    if (!imageUrl) return res.status(400).send('Missing imageUrl');
    
    const a4w = 595.28, a4h = 841.89;
    const margin = 36;
    const maxW = a4w - margin * 2;
    const maxH = a4h - margin * 2;
    
    const fetchBuf = async (url) => {
      if (!url) return null;
      const r = await fetch(url);
      if (!r.ok) throw new Error('Image fetch failed ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    };
    
    const [puzzleBuf, cluesBuf] = await Promise.all([
      fetchBuf(imageUrl),
      cluesUrl ? fetchBuf(cluesUrl) : Promise.resolve(null)
    ]);
    
    const pdf = await PDFDocument.create();
    
    const addImagePage = async (buf, withWatermark = true) => {
      const page = pdf.addPage([a4w, a4h]);
      if (buf) {
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        const img = isPng ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
        const { width, height } = img.size();
        const scale = Math.min(maxW / width, maxH / height, 1);
        const w = width * scale, h = height * scale;
        const x = (a4w - w) / 2, y = (a4h - h) / 2;
        page.drawImage(img, { x, y, width: w, height: h });
      }
      if (withWatermark) {
        page.drawText('PREVIEW', {
          x: a4w * 0.18,
          y: a4h * 0.45,
          size: 64,
          color: rgb(0.8, 0.1, 0.1),
          rotate: { type: 'degrees', angle: 35 },
          opacity: 0.25
        });
      }
    };
    
    await addImagePage(puzzleBuf, true);
    await addImagePage(cluesBuf, true);
    
    const pdfBytes = await pdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="crossword-preview.pdf"');
    return res.send(Buffer.from(pdfBytes));
    
  } catch (err) {
    console.error('Preview PDF failed:', err);
    return res.status(500).send('Preview failed');
  }
});

// === PDF claim & download (App Proxy style) ===
// GET /apps/crossword/claim-pdf?puzzleId=...
app.get('/apps/crossword/claim-pdf', (req, res) => {
  try {
    const { puzzleId } = req.query;
    if (!puzzleId) return res.status(400).json({ ok: false, error: 'Missing puzzleId' });

    const rec = PaidPuzzles.get(puzzleId);
    if (!rec) return res.status(404).json({ ok: false, error: 'No purchase found for this puzzleId' });

    const token = issuePdfToken(puzzleId, rec.orderId);
    return res.json({ ok: true, token });
  } catch (e) {
    console.error('claim-pdf failed:', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// GET /apps/crossword/download-pdf?puzzleId=...&token=...
app.get('/apps/crossword/download-pdf', async (req, res) => {
  try {
    const { puzzleId, token } = req.query;
    if (!puzzleId || !token) return res.status(400).json({ error: 'Missing puzzleId or token' });

    const rec = PaidPuzzles.get(puzzleId);
    if (!rec) return res.status(404).json({ error: 'No purchase found' });

    if (!verifyPdfToken(puzzleId, rec.orderId, token)) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    // Generate same PDF as /register-purchase-and-download
    const a4w = 595.28, a4h = 841.89;
    const margin = 36;
    const maxW = a4w - margin * 2;
    const maxH = a4h - margin * 2;

    const fetchBuf = async (url) => {
      if (!url) return null;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Image fetch failed: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };

    const pdf = await PDFDocument.create();

    const addImagePage = async (buf) => {
      if (!buf) return;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const img = isPng ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
      const { width, height } = img.size();
      const scale = Math.min(maxW / width, maxH / height, 1);
      const w = width * scale, h = height * scale;
      const x = (a4w - w) / 2, y = (a4h - h) / 2;
      const page = pdf.addPage([a4w, a4h]);
      page.drawImage(img, { x, y, width: w, height: h });
    };

    const puzzleBuf = await fetchBuf(rec.crosswordImage);
    const cluesBuf  = await fetchBuf(rec.cluesImage);

    await addImagePage(puzzleBuf);
    await addImagePage(cluesBuf);

    const pdfBytes = await pdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="crossword-${String(puzzleId).slice(0,8)}.pdf"`);
    return res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('download-pdf failed:', err);
    return res.status(500).json({ error: 'PDF generation failed' });
  }
});

// Debug endpoint
app.get('/__echo', (req, res) => {
  res.json({ ok: true, path: req.path, query: req.query });
});

// Debug endpoint to check registered purchases
app.get('/debug/paid-puzzles', (req, res) => {
  const puzzles = Array.from(PaidPuzzles.entries()).map(([id, data]) => ({
    puzzleId: id,
    ...data
  }));
  res.json({ count: puzzles.length, puzzles });
});

export default app;
