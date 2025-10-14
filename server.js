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
  console.log('📋 Sample mappings:', Object.entries(variantMap).slice(0, 3));
} catch (err) {
  console.error('❌ Failed to load variant-map.json:', err.message);
  console.error('⚠️  All variant resolution will fail without this file!');
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

// ======================= CLIENT CONFIG ROUTE =========================
// Tells the editor which Shopify variant to use for the postcard bundle item.
// ======================= CLIENT CONFIG ROUTE =========================
app.get('/apps/crossword/config', (req, res) => {
  const postcardVariantId = process.env.POSTCARD_SHOPIFY_VARIANT_ID || '';
  
  if (!postcardVariantId) {
    console.warn('⚠️ POSTCARD_SHOPIFY_VARIANT_ID not configured in environment');
  }

  res.json({
    ok: true,
    postcardVariantId: postcardVariantId
  });
});


// Resolve Shopify variant ID → Printify variant ID
app.get('/apps/crossword/resolve-printify-variant/:shopifyVariantId', async (req, res) => {
  try {
    const shopifyVid = String(req.params.shopifyVariantId);
    
    if (!shopifyVid) {
      return res.status(400).json({ ok: false, error: 'Missing shopifyVariantId' });
    }

    // Check in-memory variant map first
    const printifyVid = variantMap[shopifyVid];
    
    if (printifyVid) {
      return res.json({ 
        ok: true, 
        shopify_variant_id: shopifyVid,
        printify_variant_id: printifyVid 
      });
    }

    // Not found in map
    console.warn(`⚠️ No Printify mapping for Shopify variant ${shopifyVid}`);
    return res.status(404).json({ 
      ok: false, 
      error: 'No Printify mapping found',
      shopify_variant_id: shopifyVid
    });

  } catch (err) {
    console.error('❌ resolve-printify-variant error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Debug route: confirm the server actually loaded your file
app.get('/print-areas', (req, res) => {
  res.json({
    path: PRINT_AREAS_PATH,
    count: Object.keys(printAreas).length,
    sampleKeys: Object.keys(printAreas).slice(0, 20)
  });
});

app.get('/apps/crossword/postcard-variant-id', async (req, res) => {
  const id = process.env.POSTCARD_SHOPIFY_VARIANT_ID; // <-- your existing env var
  if (!id) return res.status(404).json({ ok: false, error: 'Missing POSTCARD_SHOPIFY_VARIANT_ID' });
  return res.json({ ok: true, variant_id: String(id) });
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


// ---- Email + PDF helpers (clues-only) ----
async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

async function buildCluesPdfOnly(cluesUrl) {
  const a4w = 595.28, a4h = 841.89;
  const margin = 36;
  const maxW = a4w - margin * 2;
  const maxH = a4h - margin * 2;

  const pdf = await PDFDocument.create();

  // Optional branded background
  const bgUrl = process.env.PDF_CLUES_BG_URL || process.env.PDF_BRAND_BG_URL || '';
  const page = pdf.addPage([a4w, a4h]);
  if (bgUrl) {
    try {
      const bgBuf = await fetchBuf(bgUrl);
      const bgImg = (bgBuf[0] === 0x89 && bgBuf[1] === 0x50) ? await pdf.embedPng(bgBuf) : await pdf.embedJpg(bgBuf);
      page.drawImage(bgImg, { x: 0, y: 0, width: a4w, height: a4h });
    } catch (e) {
      console.warn('PDF bg load failed:', e.message);
    }
  }

  // Draw clues image centered on page
  const buf = await fetchBuf(cluesUrl);
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const img = isPng ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
  const { width, height } = img.size();
  const scale = Math.min(maxW / width, maxH / height, 1);
  const w = width * scale, h = height * scale;
  const x = (a4w - w) / 2, y = (a4h - h) / 2;

  // soft panel for contrast
  page.drawRectangle({ x: x - 8, y: y - 8, width: w + 16, height: h + 16, color: rgb(1,1,1), opacity: 0.9 });
  page.drawImage(img, { x, y, width: w, height: h });

  return Buffer.from(await pdf.save());
}

async function sendCluesEmail({ to, puzzleId, pdfBuffer }) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error('Missing RESEND_API_KEY or EMAIL_FROM');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject: 'Your crossword clues (PDF)',
      html: `<p>Thanks for your purchase!</p>
             <p>Your clues PDF for puzzle <strong>${String(puzzleId).slice(0,8)}</strong> is attached.</p>`,
      attachments: [{
        filename: `clues-${String(puzzleId).slice(0,8)}.pdf`,
        content: pdfBuffer.toString('base64')
      }]
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`Resend failed: ${res.status} ${t}`);
  }
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
  const items = order.line_items.map((li) => {
    const props = Array.isArray(li.properties) ? li.properties : [];
    const getProp = (name) => {
      const p = props.find(x => x && x.name === name);
      return p ? String(p.value || '') : '';
    };

    const custom_image      = getProp('_custom_image');
    const clues_image_url   = getProp('_clues_image_url');   // clues image (if generated)
    const clue_output_mode  = getProp('_clue_output');       // 'back' | 'postcard' | 'none'
    const design_specs_raw  = getProp('_design_specs');
    const design_specs = design_specs_raw ? (() => { try { return JSON.parse(design_specs_raw); } catch { return null; } })() : null;

    return {
      title: li.title,                           // Shopify line item title
      variant_title: li.variant_title || '',     // <-- add this so logs/lookup are correct
      variant_id: li.variant_id,                 // Shopify variant ID
      quantity: li.quantity || 1,
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

    // ✅ FIX: define shopifyVid and consolidate runtime lookup block
    const shopifyVid = String(item.variant_id);
    let printifyVariantId = variantMap[shopifyVid];

    if (!printifyVariantId) {
      console.warn(`⛔ No Printify mapping for Shopify variant ${shopifyVid}. Attempting runtime lookup...`,
                   { product: item.title, variant_title: item.variant_title });

      const lookedUp = await lookupPrintifyVariantIdByTitles(item.title, item.variant_title);
      if (lookedUp) {
        printifyVariantId = lookedUp;
        variantMap[shopifyVid] = lookedUp; // cache for this process
        console.log('✅ Runtime variant lookup succeeded:', { shopifyVid, printifyVariantId: lookedUp });
        try {
          await fs.writeFile('./variant-map.json', JSON.stringify(variantMap, null, 2));
          console.log('📝 Persisted runtime variant map update to variant-map.json');
        } catch (e) {
          console.warn('⚠️ Failed to persist variant-map.json:', e.message);
        }
      } else {
        console.warn('⛔ Still no mapping after runtime lookup. Skipping this line item.', { shopifyVid });
        continue;
      }
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
  // req.body is a Buffer because of bodyParser.raw() mounted earlier for this path
  const rawBody = req.body;
  const hmacHeader = req.headers['x-shopify-hmac-sha256'] || '';

  // Constant-time HMAC verification
  const computed = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)     // pass Buffer, no encoding
    .digest();           // Buffer

  const received = Buffer.from(hmacHeader, 'base64');
  const valid = received.length === computed.length && crypto.timingSafeEqual(received, computed);

  if (!valid) {
    console.warn('⚠️ Webhook HMAC verification failed.');
    return res.status(401).send('HMAC validation failed');
  }

  const order = JSON.parse(rawBody.toString());
  console.log('✅ Verified webhook for order:', order.id);

  // De-dupe
  if (processedShopifyOrders.has(order.id)) {
    console.log('🛑 Duplicate webhook skipped for order', order.id);
    return res.status(200).send('ok (duplicate ignored)');
  }
  processedShopifyOrders.add(order.id);

  // Index paid puzzleIds once
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

      const crosswordImage = getProp('_custom_image');
      const cluesImage     = getProp('_clues_image_url');

      PaidPuzzles.set(pid, {
        orderId: String(order.id),
        email: (order.email || order?.customer?.email || '') + '',
        crosswordImage,
        cluesImage,
        when: new Date().toISOString(),
      });
      seen.push(pid);
    }

    if (seen.length) console.log('🔐 Stored paid puzzleIds:', seen);
  } catch (e) {
    console.error('❌ Failed to index paid puzzleIds', e);
  }

  await handlePrintifyOrder(order);
  // After placing the Printify order, email clues PDF for "postcard" mode
  try {
    const to = [order.email, order.contact_email, order?.customer?.email]
      .map(e => (e || '').trim())
      .find(e => e.includes('@')) || '';
    if (to) {
      const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
      const sent = new Set();

      for (const li of lineItems) {
        const props = Array.isArray(li.properties) ? li.properties : [];
        const getProp = (name) => {
          const p = props.find(x => x && x.name === name);
          return p ? String(p.value || '') : '';
        };

        const mode   = getProp('_clue_output');     // 'back' | 'postcard' | 'none'
        const flag   = getProp('_postcard_pdf');    // '1' when we forced digital postcard
        const pid    = getProp('_puzzle_id');
        const clues  = getProp('_clues_image_url');

        // Only send for the clues-only case
        if (!pid || sent.has(pid)) continue;
        if (!((mode === 'postcard') || flag === '1')) continue;
        if (!clues) continue; // nothing to render

        const pdf = await buildCluesPdfOnly(clues);
        await sendCluesEmail({ to, puzzleId: pid, pdfBuffer: pdf });
        sent.add(pid);
        console.log('📧 Sent clues PDF email for puzzle', pid, 'to', to);
      }
    } else {
      console.warn('No buyer email on order; skipping clues email.');
    }
  } catch (e) {
    console.error('❌ clues-email failed:', e);
  }

  return res.status(200).send('Webhook received');

});

// ── Cloudinary config (standalone, not wrapped in extra parens) ────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
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

    // server-side guard against unsupported back printing
    let backUrl = backImageUrl;
    try {
      const supportsBack = await serverHasBack(variantId, req); // variantId here must be Printify variant id
      if (!supportsBack) {
        if (backUrl) console.warn(`Dropping backImage for variant ${variantId} — no back support.`);
        backUrl = undefined;
      }
    } catch { backUrl = undefined; }

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
      hasBackImage: !!backUrl,
      variantId,
      recipient: recipient.name
    });

    const order = await createOrder({
      imageUrl,
      backImageUrl: backUrl,    // ✅ use filtered value
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

    let backUrl = backImageUrl;
    try {
      const supportsBack = await serverHasBack(variantId, req); // variantId must be Printify variant id
      if (!supportsBack) {
        if (backUrl) console.warn(`Dropping backImage for variant ${variantId} — no back support.`);
        backUrl = undefined;
      }
    } catch { backUrl = undefined; }

    console.log('Creating order directly from Cloudinary URL:', {
      cloudinaryUrl,
      hasBackImage: !!backUrl
    });

    const order = await createOrder({
      imageUrl: cloudinaryUrl,
      backImageUrl: backUrl,
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

// Printify-only product feed (no Shopify Admin; uses variantMap to link back)
app.get('/apps/crossword/products', async (req, res) => {
  try {
    const DEFAULT_AREA = { width: 800, height: 500, top: 50, left: 50 };

    // 0) Reverse variantMap: printifyVid -> [shopifyVid...]
    const rev = {};
    for (const [shopVid, pifyVid] of Object.entries(variantMap || {})) {
      const k = String(pifyVid);
      if (!rev[k]) rev[k] = [];
      rev[k].push(String(shopVid));
    }

    // 1) Pull visible Printify products
    const pifyProducts = await fetchAllProductsPagedFiltered();

    const out = [];
    for (const p of pifyProducts) {
      const img = (p.images && p.images[0]?.src) || '';
      const mappedVariants = (p.variants || []).filter(v => rev[String(v.id)] && rev[String(v.id)][0]);
      if (!mappedVariants.length) continue; // skip products we can’t sell (no Shopify mapping)

      // pick a preferred mapped variant
      const pref = mappedVariants[0];
      const firstShopifyVid = rev[String(pref.id)][0];

      // build UI variants (only mapped)
      const variantList = mappedVariants.map(v => {
        const shopVid = rev[String(v.id)][0]; // take the first mapping
        return {
          title: v.title || '',
          shopifyVariantId: shopVid,
          printifyVariantId: v.id,
          price: parseFloat(v.price) || 0,
          options: { option1: null, option2: null, option3: null },
          printArea: printAreas[shopVid] || DEFAULT_AREA
        };
      });

      // full list for disabling unmapped combos in UI
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
        id: p.id,                          // Printify product id
        printifyVariantId: pref.id,        // default Printify variant
        variants: variantList,             // mapped only
        title: p.title,
        optionNames: [],                   // we don’t have Shopify option names here
        handle: '',
        image: img,
        shopifyVariantId: String(firstShopifyVid || ''),          // preferred Shopify variant
        printifyProductId: p.id,
        variantId: firstShopifyVid ? Number(firstShopifyVid) : null,
        price: parseFloat(pref.price) || 0,
        printArea: printAreas[String(firstShopifyVid)] || DEFAULT_AREA,
        allVariants: allVariantList
      });
    }

    res.json({ products: out });
  } catch (err) {
    console.error('❌ products(Printify-only) failed:', err);
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
      await applyImagesToProductDual(productId, parseInt(variantId), uploaded.id, uploadedBack.id, position, backPosition);
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

// ✅ FIX: Replace /preview route to use shop product endpoint (valid) and pick enabled variant
app.get('/preview', async (req, res) => {
  try {
    const { productId, image, x = 0, y = 0, width = 300, height = 300 } = req.query;
    if (!productId || !image) {
      return res.status(400).json({ error: 'Missing productId or image' });
    }

    const shopId = process.env.PRINTIFY_SHOP_ID;
    const prodRes = await fetch(
      `https://api.printify.com/v1/shops/${shopId}/products/${productId}.json`,
      { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` } }
    );
    if (!prodRes.ok) {
      const t = await prodRes.text().catch(() => '');
      return res.status(prodRes.status).json({ error: 'Printify product fetch failed', details: t });
    }
    const prod = await prodRes.json();
    const firstEnabled = (prod.variants || []).find(v => v.is_enabled !== false) || (prod.variants || [])[0];
    if (!firstEnabled) {
      return res.status(404).json({ error: 'No enabled variants found for product' });
    }

    const payload = {
      product_id: parseInt(productId),
      variant_ids: [Number(firstEnabled.id)],
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

// --- Filtering knobs (env-tunable) ---
const ONLY_VISIBLE = process.env.PRINTIFY_ONLY_VISIBLE !== '0'; // default: true
const EXCLUDE_TITLE_RE = new RegExp(
  process.env.PRINTIFY_EXCLUDE_TITLES_REGEX || '(test|desktop|api)',
  'i'
);

// Local constants for Printify REST calls (avoid BASE_URL/authHeaders())
const PRINTIFY_BASE = 'https://api.printify.com/v1';
const SHOP_ID = process.env.PRINTIFY_SHOP_ID;
const PIFY_HEADERS = {
  Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
  'Content-Type': 'application/json',
};

// --- Shared helpers -------------------------------------------------

// Check if a Printify variant supports a back print by looking up placeholders
async function serverHasBack(printifyVariantId, req) {
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const r = await fetch(`${base}/apps/crossword/product-specs/${printifyVariantId}`);
    if (!r.ok) return false;
    const data = await r.json();
    return !!data.has_back;
  } catch {
    return false;
  }
}

// Emergency fallback: try to find a Printify variant by product + variant titles
async function lookupPrintifyVariantIdByTitles(shopTitle, variantTitle) {
  try {
    const shopId = process.env.PRINTIFY_SHOP_ID;
    let page = 1, all = [];
    for (; page <= 10; page++) {
      const url = `https://api.printify.com/v1/shops/${shopId}/products.json?page=${page}&limit=50`;
      const data = await safeFetch(url, { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` }});
      const arr = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      if (!arr.length) break;
      all = all.concat(arr);
      if (arr.length < 50) break;
    }

    const norm = s => String(s||'').trim().toLowerCase();
    const t  = norm(shopTitle);
    const vt = norm(variantTitle || '');

    const p = all.find(p => norm(p.title) === t) || all.find(p => norm(p.title).includes(t)) || null;
    if (!p) return null;

    const pv = (p.variants || []);
    let v = pv.find(x => norm(x.title) === vt);
    if (!v && pv.length === 1) v = pv[0];
    if (!v && vt) v = pv.find(x => norm(x.title).includes(vt));
    return v ? v.id : null;
  } catch (e) {
    console.warn('lookupPrintifyVariantIdByTitles failed:', e.message);
    return null;
  }
}


// --- Paged, filtered shop product fetch ---
async function fetchAllProductsPagedFiltered() {
  const all = [];
  let page = 1;
  for (;;) {
    const url = `${PRINTIFY_BASE}/shops/${SHOP_ID}/products.json?page=${page}`;
    const resp = await safeFetch(url, { headers: PIFY_HEADERS });

    // Printify sometimes returns { data:[...] } or just [...]
    const data = Array.isArray(resp?.data) ? resp.data : (Array.isArray(resp) ? resp : []);
    if (!data.length) break;

    const cleaned = data.filter(p => {
      if (ONLY_VISIBLE && p?.visible !== true) return false;      // skip unpublished/drafts
      if (p?.is_locked === true) return false;                    // skip locked/in-progress
      if (EXCLUDE_TITLE_RE.test(p?.title || '')) return false;    // skip obvious test items
      return true;
    });

    all.push(...cleaned);
    if (!resp?.next_page_url) break;
    page++;
  }
  return all;
}

// --- Verify (blueprint, provider, variant) exists in Catalog ---
async function verifyCatalogPair(blueprintId, printProviderId, variantId) {
  const url = `${PRINTIFY_BASE}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`;
  const data = await safeFetch(url, { headers: PIFY_HEADERS });
  const ok = !!data?.variants?.some(v => Number(v.id) === Number(variantId));
  if (!ok) {
    throw new Error(`Variant ${variantId} not offered by bp ${blueprintId} / pp ${printProviderId}`);
  }
}

// --- Try to read placeholder names (front/back/etc.) ---
// Make this VARIANT-AWARE (prefer the specific variant, then fall back to print_areas)
async function getVariantPlaceholderNames(blueprintId, printProviderId, variantId) {
  // 1) Prefer variant-level placeholders (accurate per-variant)
  try {
    const url = `${PRINTIFY_BASE}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`;
    const data = await safeFetch(url, { headers: PIFY_HEADERS });

    const v = Array.isArray(data?.variants)
      ? data.variants.find(x => Number(x.id) === Number(variantId))
      : null;

    if (v && Array.isArray(v.placeholders) && v.placeholders.length) {
      const names = new Set();
      for (const ph of v.placeholders) {
        const val = (ph?.position || ph?.name || '').toString().trim().toLowerCase();
        if (val) names.add(val);
      }
      if (names.size > 0) return Array.from(names);
    }
  } catch (e) {
    console.warn('getVariantPlaceholderNames (variant) failed:', e.message);
  }

  // 2) Fallback: catalog print_areas (provider-wide)
  try {
    const url = `${PRINTIFY_BASE}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/print_areas.json`;
    const data = await safeFetch(url, { headers: PIFY_HEADERS });

    const names = new Set();
    const areas = Array.isArray(data?.print_areas) ? data.print_areas
                : Array.isArray(data)             ? data
                : [];

    for (const area of areas) {
      // area-level name/position (rare but be permissive)
      const areaName = (area?.name || area?.position || '').toString().trim().toLowerCase();
      if (areaName) names.add(areaName);

      const placeholders = area?.placeholders || area?.placeholders_json || area?.placeholdersList || [];
      for (const ph of placeholders) {
        const val = (ph?.position || ph?.name || '').toString().trim().toLowerCase();
        if (val) names.add(val);
      }
    }

    if (names.size > 0) return Array.from(names);
  } catch (e) {
    console.warn('getVariantPlaceholderNames (print_areas) failed:', e.message);
  }

  // Safe default
  return ['front'];
}



// ======================= PRODUCT SPECS ROUTE =========================
// GET /apps/crossword/product-specs/:variantId
// Used by the editor to decide if a "back" side exists, and expose IDs.
// ======================= PRODUCT SPECS ROUTE =========================
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

    console.log(`[product-specs] Looking up variant ${variantId}`);

    // Fetch all products (with filtering)
    const products = await fetchAllProductsPagedFiltered();
    
    // Find product containing this variant
    const product = products.find(p => 
      p?.variants?.some(v => Number(v.id) === variantId)
    );

    if (!product) {
      console.warn(`⚠️ Variant ${variantId} not found among ${products.length} visible products`);
      return res.status(404).json({
        ok: false,
        error: `Variant ${variantId} not found`,
        has_back: false,
        scanned_products: products.length
      });
    }

    const bp = Number(product.blueprint_id);
    const pp = Number(product.print_provider_id);

    // Guard against invalid blueprints
    if (!bp || String(bp).length < 3 || bp === 1111 || bp === 11111) {
      console.warn(`⚠️ Invalid blueprint ${bp} for product "${product.title}"`);
      return res.json({
        ok: true,
        variant_id: variantId,
        product_id: product.id,
        title: product.title,
        has_back: false,
        hasBack: false,
        error: 'Invalid blueprint'
      });
    }

    // Verify variant exists in Printify catalog
    try {
      await verifyCatalogPair(bp, pp, variantId);
    } catch (e) {
      console.warn(`⚠️ Catalog verification failed for variant ${variantId}:`, e.message);
      return res.json({
        ok: true,
        variant_id: variantId,
        product_id: product.id,
        title: product.title,
        has_back: false,
        hasBack: false,
        error: 'Not in catalog'
      });
    }

    // Get placeholder names (front, back, etc.)
    let placeholders = ['front'];
    try {
      placeholders = await getVariantPlaceholderNames(bp, pp, variantId);
    } catch (e) {
      console.warn(`⚠️ Could not fetch placeholders for ${variantId}, using fallback`);
    }

    const hasBack = placeholders.some(n => 
      /back|rear|reverse|backside|secondary|alt/i.test(n)
    );

    console.log(`✅ Variant ${variantId} specs: has_back=${hasBack}, placeholders=${placeholders.join(',')}`);

    return res.json({
      ok: true,
      variant_id: variantId,
      product_id: product.id,
      title: product.title,
      visible: product.visible,
      is_locked: product.is_locked,
      blueprint_id: bp,
      print_provider_id: pp,
      placeholders,
      has_back: hasBack,
      hasBack: hasBack  // Both formats for compatibility
    });

  } catch (err) {
    console.error('❌ product-specs error:', err);
    return res.status(500).json({ 
      ok: false, 
      error: err.message,
      has_back: false
    });
  }
});

// ======================= DEBUG: VARIANT LIVE =========================
// e.g. GET /apps/crossword/debug/variant/105129/live
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

// [ADD] List Shopify variants that are missing from variantMap
app.get('/admin/variant-map/gaps', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Pull Shopify products (minimal fields)
    const store = process.env.SHOPIFY_STORE;
    const pwd   = process.env.SHOPIFY_PASSWORD;
    const shopUrl = `https://${store}.myshopify.com/admin/api/2024-01/products.json?limit=250&fields=id,title,variants`;

    const resp = await fetch(shopUrl, { headers: { 'X-Shopify-Access-Token': pwd }});
    const data = await resp.json();
    const products = Array.isArray(data?.products) ? data.products : [];

    const missing = [];
    for (const p of products) {
      for (const v of (p.variants || [])) {
        const key = String(v.id);
        if (!variantMap[key]) {
          missing.push({
            product_title: p.title,
            shopify_variant_id: key,
            shopify_variant_title: v.title
          });
        }
      }
    }
    res.json({ missing_count: missing.length, missing });
  } catch (err) {
    console.error('❌ variant-map gaps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/print-areas/sync-defaults', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const DEFAULT = { width: 1200, height: 1200, top: 0, left: 0 }; // adjust if needed
    let added = 0;

    for (const key of Object.keys(variantMap)) {
      if (!printAreas[key]) {
        printAreas[key] = DEFAULT;
        added++;
      }
    }

    await fs.writeFile(PRINT_AREAS_PATH, JSON.stringify(printAreas, null, 2));
    res.json({ added, message: 'Synced defaults for missing print areas.' });
  } catch (err) {
    console.error('❌ sync-defaults error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================== OTHER DEBUG ROUTES =========================
app.get('/__echo', (req, res) => {
  res.json({ ok: true, path: req.path, query: req.query });
});

app.get('/debug/paid-puzzles', (req, res) => {
  const puzzles = Array.from(PaidPuzzles.entries()).map(([id, data]) => ({
    puzzleId: id,
    ...data
  }));
  res.json({ count: puzzles.length, puzzles });
});

export default app;
