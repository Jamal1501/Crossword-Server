// server.js
import fs from 'fs/promises';
import express from 'express';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import cors from 'cors';
import fetch from 'node-fetch';
import { v2 as cloudinary } from 'cloudinary';
import * as printifyService from './services/printifyService.js';
import { resolveBpPpForVariant, getVariantPlaceholderByPos } from './services/printifyService.js';
import { safeFetch } from './services/printifyService.js';
import dotenv from 'dotenv';
import { generateMap } from './scripts/generateVariantMap.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
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
app.get('/apps/crossword/config', (req, res) => {
  const postcardVariantId = process.env.POSTCARD_SHOPIFY_VARIANT_ID || '';
  const pdfVariantId = process.env.PDF_ONLY_SHOPIFY_VARIANT_ID 
                    || process.env.CLUES_PDF_SHOPIFY_VARIANT_ID 
                    || ''; // backward compat if you had an older name

  if (!postcardVariantId) console.warn('⚠️ POSTCARD_SHOPIFY_VARIANT_ID not configured in environment');
  if (!pdfVariantId)      console.warn('⚠️ PDF_ONLY_SHOPIFY_VARIANT_ID not configured in environment');

  res.json({ ok: true, postcardVariantId, pdfVariantId });
});


// Resolve Shopify variant ID → Printify variant ID
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

// Debug route: confirm the server actually loaded your file
app.get('/print-areas', (req, res) => {
  res.json({
    path: PRINT_AREAS_PATH,
    count: Object.keys(printAreas).length,
    sampleKeys: Object.keys(printAreas).slice(0, 20)
  });
});

app.get('/apps/crossword/postcard-variant-id', async (req, res) => {
  const id = process.env.POSTCARD_SHOPIFY_VARIANT_ID; // optional legacy
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

// ---- Email + PDF helpers (updated + new) ----
async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

// Optional brand assets loader (logo + font)
async function prepareBrandAssets(pdf) {
  const out = { logoImg: null, font: undefined };
  try {
    const logoUrl = process.env.PDF_LOGO_URL || '';
    if (logoUrl) {
      const buf = await fetchBuf(logoUrl);
      out.logoImg = (buf[0] === 0x89 && buf[1] === 0x50) ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
    }
  } catch (e) {
    console.warn('PDF logo load failed:', e.message);
  }
  try {
    const fontUrl = process.env.PDF_FONT_URL || '';
    if (fontUrl) {
      const fbuf = await fetchBuf(fontUrl);
      out.font = await pdf.embedFont(fbuf);
    }
  } catch (e) {
    console.warn('PDF custom font load failed:', e.message);
  }
  return out;
}


// Styled 1–2 page GRID + CLUES PDF (download/email) — unified & text-capable
async function buildGridAndCluesPdf({ gridBuf, cluesBuf, cluesText = '', puzzleId = '', opts = {} } = {}) {
  const a4w = 595.28, a4h = 841.89;
  const margin = 36;
  const headerH = 38;
  const footerH = 26;
  const innerTop = margin + headerH + 10;
  const innerBottom = margin + footerH + 10;
  const maxW = a4w - margin * 2;
  const maxH = a4h - innerTop - innerBottom;

  const pdf = await PDFDocument.create();
  const { logoImg, font } = await prepareBrandAssets(pdf);
  const bgUrl = process.env.PDF_BRAND_BG_URL || '';
  const approxWidth = (s, size, fnt) => (fnt ? fnt.widthOfTextAtSize(s, size) : s.length * size * 0.55);
  const useFont = font || await pdf.embedFont(StandardFonts.Helvetica);

  // small text-wrapping helper using pdf-lib font metrics
  function wrapTextToLines(text, fnt, size, maxWidth) {
    const words = text.replace(/\r/g,'').split(/\s+/);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const test = cur ? (cur + ' ' + w) : w;
      const width = fnt.widthOfTextAtSize(test, size);
      if (width > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // common page header/footer painter
  const paintHeaderFooter = (page, titleText, pageIndex) => {
    // background (already drawn at page-level where needed)
    // header logo
    if (logoImg) {
      const lh = headerH - 10;
      const lw = (logoImg.width / logoImg.height) * lh;
      page.drawImage(logoImg, { x: margin + 10, y: a4h - margin - headerH + 5, width: lw, height: lh });
    }
    const titleX = margin + (logoImg ? 10 + (logoImg.width / logoImg.height) * (headerH - 10) + 10 : 14);
    page.drawText(titleText, {
      x: titleX,
      y: a4h - margin - headerH + 11,
      size: 16,
      color: rgb(0.12,0.12,0.12),
      font: useFont
    });

    const footerLeft = 'LoveFrames • loveframes.shop';
    const footerRight = puzzleId ? `Puzzle ${String(puzzleId).slice(0,8)} — Page ${pageIndex}` : `Page ${pageIndex}`;
    page.drawText(footerLeft, { x: margin + 10, y: margin + 8, size: 10, color: rgb(0.25,0.25,0.25), font: useFont });
    const rw = approxWidth(footerRight, 10, useFont);
    page.drawText(footerRight, { x: a4w - margin - 10 - rw, y: margin + 8, size: 10, color: rgb(0.25,0.25,0.25), font: useFont });
  };

  // Helper to add a page with an embedded image (centered, scaled to maxW/maxH)
  const addImagePage = async (imageBuf, title, pageIndex) => {
    const page = pdf.addPage([a4w, a4h]);

    // background image (brand) if present
    if (bgUrl) {
      try {
        const bgBuf = await fetchBuf(bgUrl);
        const bgImg = (bgBuf[0] === 0x89 && bgBuf[1] === 0x50) ? await pdf.embedPng(bgBuf) : await pdf.embedJpg(bgBuf);
        page.drawImage(bgImg, { x: 0, y: 0, width: a4w, height: a4h });
      } catch (e) {
        console.warn('PDF bg load failed:', e.message);
      }
    }

    paintHeaderFooter(page, title, pageIndex);

    if (imageBuf) {
      const isPng = imageBuf[0] === 0x89 && imageBuf[1] === 0x50;
      const img = isPng ? await pdf.embedPng(imageBuf) : await pdf.embedJpg(imageBuf);
      const { width, height } = img.size();
      const scale = Math.min(maxW / width, maxH / height, 1);
      const w = width * scale, h = height * scale;
      const x = (a4w - w) / 2;
      const y = (a4h - h) / 2 - ((headerH - footerH) / 2);
      page.drawImage(img, { x, y, width: w, height: h });
    }
  };

  // Helper to add a page with clues text (or image fallback)
  const addCluesPage = async ({ cluesBuf, cluesText, pageIndex, scale = 1 }) => {
    const page = pdf.addPage([a4w, a4h]);

    // background image (brand)
    if (bgUrl) {
      try {
        const bgBuf = await fetchBuf(bgUrl);
        const bgImg = (bgBuf[0] === 0x89 && bgBuf[1] === 0x50) ? await pdf.embedPng(bgBuf) : await pdf.embedJpg(bgBuf);
        page.drawImage(bgImg, { x: 0, y: 0, width: a4w, height: a4h });
      } catch (e) {
        console.warn('PDF bg load failed:', e.message);
      }
    }

    paintHeaderFooter(page, 'Crossword Clues', pageIndex);

    // If cluesText provided -> typeset; otherwise fall back to image embedding if cluesBuf present
    if (cluesText && cluesText.trim().length) {
      // compute font size from scale param (clamped)
      const baseSize = Number(process.env.PDF_CLUES_BASE_SIZE || 11.5);
      const fontSize = Math.max(8, Math.min(34, baseSize * (Number(scale) || 1)));
      const leading = fontSize * 1.35;
      const contentMaxW = maxW;
      const contentMaxH = maxH;

      // Preserve manual newlines/paragraphs: sanitize and split paragraphs
      const normalized = cluesText.replace(/\r/g, '');
      const paragraphs = normalized.split('\n\n'); // paragraphs separated by blank line

      // Build lines while preserving single-line breaks inside paragraphs as explicit lines
      let lines = [];
      for (const p of paragraphs) {
        const rawLines = p.split('\n').map(s => s.trim()).filter(Boolean);
        for (const rl of rawLines) {
          const wrapped = wrapTextToLines(rl, useFont, fontSize, contentMaxW);
          lines.push(...wrapped);
        }
        // paragraph gap (a blank line)
        lines.push('');
      }

      // Compute vertical offset to center the block within the area available
      const contentHeight = lines.length * leading;
      let startY = (a4h - margin - headerH) - ((headerH - footerH) / 2) - (contentHeight / 2);
      const topLimit = a4h - margin - headerH - 10;
      const bottomLimit = margin + footerH + 10;
      if (startY > topLimit) startY = topLimit;
      if (startY - contentHeight < bottomLimit) startY = Math.max(bottomLimit + contentHeight, startY);

      // draw lines
      let y = startY;
      for (const line of lines) {
        // allow tiny horizontal padding
        page.drawText(line, { x: margin, y: y, size: fontSize, font: useFont, color: rgb(0.08,0.08,0.08) });
        y -= leading;
        // stop if we overflow bottom (safety)
        if (y < bottomLimit) break;
      }
    } else if (cluesBuf) {
      // fallback to image embedding (maintain previous behavior)
      const isPng = cluesBuf[0] === 0x89 && cluesBuf[1] === 0x50;
      const img = isPng ? await pdf.embedPng(cluesBuf) : await pdf.embedJpg(cluesBuf);
      const { width, height } = img.size();
      const scaleImg = Math.min(maxW / width, maxH / height, 1.9);
      const w = width * scaleImg, h = height * scaleImg;
      const x = (a4w - w) / 2;
      const y = (a4h - h) / 2 - ((headerH - footerH) / 2);
      page.drawImage(img, { x, y, width: w, height: h });
    } else {
      // nothing to render — show empty placeholder text
      page.drawText('No clues available', { x: margin, y: a4h - margin - headerH - 10, size: 12, font: useFont, color: rgb(0.5,0.5,0.5) });
    }
  };

  // Page index counter
  let pageIndex = 1;

  // GRID page (if provided)
  if (gridBuf) {
    await addImagePage(gridBuf, 'Crossword Grid', pageIndex);
    pageIndex++;
  }

  // CLUES page (text preferred, else image)
  await addCluesPage({ cluesBuf, cluesText, pageIndex, scale: opts.scale || 1 });

  return Buffer.from(await pdf.save());
}


// Generic email sender for any PDF attachment (Resend)
async function sendEmailWithAttachment({ to, subject, html, filename, pdfBuffer }) {
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
      subject,
      html,
      attachments: [{
        filename,
        content: pdfBuffer.toString('base64')
      }]
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`Resend failed: ${res.status} ${t}`);
  }
}

// (Kept for compatibility—unused now unless you call it elsewhere)
async function sendCluesEmail({ to, puzzleId, pdfBuffer }) {
  return sendEmailWithAttachment({
    to,
    subject: 'Your crossword clues (PDF)',
    html: `<p>Thanks for your purchase!</p>
           <p>Your clues PDF for puzzle <strong>${String(puzzleId).slice(0,8)}</strong> is attached.</p>`,
    filename: `clues-${String(puzzleId).slice(0,8)}.pdf`,
    pdfBuffer
  });
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
      title: li.title,
      variant_title: li.variant_title || '',
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

// 🔄 Use live placeholder from Printify catalog for this mapped Printify variant
let phFront = null;
try {
  const { blueprintId, printProviderId } = await resolveBpPpForVariant(printifyVariantId);
  phFront = await getVariantPlaceholderByPos(
    blueprintId,
    printProviderId,
    Number(printifyVariantId),
    'front'
  );
} catch {}

// Derive scale from design_specs.size relative to real area width
let scale = 1.0;
const sizeVal = item.design_specs?.size;
if (typeof sizeVal === 'string') {
  const s = sizeVal.trim();
  if (s.endsWith('%')) {
    const pct = parseFloat(s);
    if (!Number.isNaN(pct)) scale = Math.max(0.1, Math.min(2, pct / 100));
  } else if (s.endsWith('px') && phFront?.width) {
    const px = parseFloat(s);
    if (!Number.isNaN(px)) scale = Math.max(0.1, Math.min(2, px / phFront.width));
  }
}

// Normalize x/y using real area dims
const topPx  = parseFloat(item.design_specs?.top || '0');
const leftPx = parseFloat(item.design_specs?.left || '0');

let x = 0.5, y = 0.5;
if (phFront?.width && phFront?.height) {
  const imgW = phFront.width  * scale;
  const imgH = phFront.height * scale;
  x = Math.min(1, Math.max(0, (leftPx + imgW / 2) / phFront.width));
  y = Math.min(1, Math.max(0, (topPx  + imgH / 2) / phFront.height));
}
const position = { x, y, scale, angle: 0 };

// Back scale remains your multiplier-based request (clamped later in createOrder)
const BACK_SCALE_MULT = Number(process.env.BACK_SCALE_MULT || 1);
const backScale = Math.max(0.1, Math.min(2, scale * BACK_SCALE_MULT));
const backPosition = { x: 0.5, y: 0.5, scale: backScale, angle: 0 };

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
    backImageUrl,                     // optional back
    variantId: printifyVariantId,
    quantity: item.quantity,
    position,
    backPosition,
    recipient,
    // printArea: undefined, // not needed anymore
    meta: { shopifyVid, title: item.title }
  });
  console.log('✅ Printify order created:', response?.id || '[no id]', { shopifyVid, printifyVariantId, scale });
} catch (err) {
  console.error('❌ Failed to create Printify order:', { shopifyVid, printifyVariantId, scale, err: err?.message || err });
}

app.post('/webhooks/orders/create', async (req, res) => {
  // req.body is a Buffer because of bodyParser.raw() mounted earlier for this path
  const rawBody = req.body;
  const hmacHeader = req.headers['x-shopify-hmac-sha256'] || '';

  // Constant-time HMAC verification
  try {
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
  } catch (e) {
    console.warn('⚠️ Webhook HMAC verification error:', e);
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

  // Index paid puzzleIds once (unchanged)
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

  // NEW: parse text from design_specs / _clues_text
  const design_specs_raw = getProp('_design_specs') || '';
  let design_specs = null;
  try {
    design_specs = design_specs_raw ? JSON.parse(design_specs_raw) : null;
  } catch {}
  const explicitCluesText = getProp('_clues_text') || '';
  const cluesText = (design_specs && String(design_specs.clues_text || '').trim())
    || String(explicitCluesText || '').trim()
    || '';

  PaidPuzzles.set(pid, {
    orderId: String(order.id),
    email: (order.email || order?.customer?.email || '') + '',
    crosswordImage,
    cluesImage,
    cluesText,  // stored for text-typeset PDFs
    when: new Date().toISOString(),
  });

  seen.push(pid);
}


    if (seen.length) console.log('🔐 Stored paid puzzleIds:', seen);
  } catch (e) {
    console.error('❌ Failed to index paid puzzleIds', e);
  }

  // Place the Printify order(s)
  try {
    await handlePrintifyOrder(order);
  } catch (e) {
    console.error('❌ handlePrintifyOrder failed:', e);
    // continue — we still want to attempt sending PDFs/emails
  }

  // === Email: always send FULL PDF (grid + clues) to buyer, once per puzzle ===
  try {
    const to =
      [order.email, order.contact_email, order?.customer?.email, process.env.EMAIL_FALLBACK_TO]
        .map(e => (e || '').trim())
        .find(e => e && e.includes('@')) || '';

    if (!to) {
      console.warn('No buyer email on order; skipping PDF email.');
      return res.status(200).send('Webhook received (no email)');
    }

    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    const sent = new Set();

    for (const li of lineItems) {
      const props = Array.isArray(li.properties) ? li.properties : [];
      const getProp = (name) => {
        const p = props.find(x => x && x.name === name);
        return p ? String(p.value || '') : '';
      };

      // debug log to inspect incoming props (remove/level-down later)
      console.log('Order line properties:', props);

      const pid = getProp('_puzzle_id');
      if (!pid || sent.has(pid)) continue;

      const gridUrl  = getProp('_custom_image');
      const cluesUrl = getProp('_clues_image_url');
      const shopVid  = String(li.variant_id || '');

      // parse design_specs (if present) to get clues text + size metadata
      const designSpecsRaw = getProp('_design_specs') || '';
      let design_specs = null;
      try { design_specs = designSpecsRaw ? JSON.parse(designSpecsRaw) : null; } catch (err) {
        console.warn('Failed to parse _design_specs JSON for line item', err.message);
        design_specs = null;
      }

      // explicit fallback property
      const explicitCluesText = getProp('_clues_text') || '';

      // prefer design_specs.clues_text, else explicit _clues_text, else empty string
      const cluesText = (design_specs && String(design_specs.clues_text || '').trim())
        || String(explicitCluesText || '').trim() || '';

      // fetch image buffers (if present)
      const [gridBuf, cluesBuf] = await Promise.all([
        gridUrl ? fetchBuf(gridUrl) : Promise.resolve(null),
        cluesUrl ? fetchBuf(cluesUrl) : Promise.resolve(null)
      ]);

      // compute a simple scale hint from design_specs.size (mirrors handlePrintifyOrder logic)
      let computedScale = 1;
      try {
        const area = printAreas?.[shopVid] || null;
        let scale = 1.0;
        const sizeVal = design_specs?.size;
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
        computedScale = scale;
      } catch (e) {
        // keep default 1
      }

      // Build unified PDF (grid + clues). If cluesText is present, typeset it; otherwise it falls back to embedding cluesBuf.
      let pdfBuffer;
      try {
        pdfBuffer = await buildGridAndCluesPdf({
          gridBuf: gridBuf || undefined,
          cluesBuf: cluesBuf || undefined,
          cluesText,
          puzzleId: pid,
          opts: { scale: computedScale }
        });
      } catch (e) {
        console.error(`❌ buildGridAndCluesPdf failed for puzzle ${pid}:`, e);
        // attempt fallback: build PDF with images only if text rendering failed
        try {
          const fallbackPdf = await buildGridAndCluesPdf({
            gridBuf: gridBuf || undefined,
            cluesBuf: cluesBuf || undefined,
            cluesText: '',
            puzzleId: pid,
            opts: { scale: computedScale }
          });
          pdfBuffer = fallbackPdf;
        } catch (ee) {
          console.error('❌ Fallback PDF generation also failed:', ee);
          continue; // skip emailing this puzzle
        }
      }

      // send email
      try {
        await sendEmailWithAttachment({
          to,
          subject: 'Your printable crossword (PDF)',
          html: `<p>Thanks for your purchase!</p>
                 <p>Your full PDF for puzzle <strong>${String(pid).slice(0,8)}</strong> is attached. It includes both the grid and clues.</p>`,
          filename: `crossword-${String(pid).slice(0,8)}.pdf`,
          pdfBuffer
        });
        console.log(`📧 Sent PDF email for puzzle ${pid} to ${to}`);
      } catch (e) {
        console.error(`❌ sendEmailWithAttachment failed for puzzle ${pid}:`, e);
      }

      sent.add(pid);
    }
  } catch (e) {
    console.error('❌ smart-pdf-email failed:', e);
  }

  return res.status(200).send('Webhook received');
});

// ── Cloudinary config ───────────────────────────────────────────────
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
      backImageUrl,          // optional back
      base64Image,
      variantId,
      position,
      backPosition,
      recipient,
      quantity,
      orderId
    } = req.body;

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

    // server-side guard against unsupported back printing
    let backUrl = backImageUrl;
    try {
      const supportsBack = await serverHasBack(variantId, req); // variantId here must be Printify variant id
      if (!supportsBack) {
        if (backUrl) console.warn(`Dropping backImage for variant ${variantId} — no back support.`);
        backUrl = undefined;
      }
    } catch { backUrl = undefined; }

    console.log('Creating order with:', {
      hasImageUrl: !!imageUrl,
      hasBase64: !!base64Image,
      hasBackImage: !!backUrl,
      variantId,
      recipient: recipient.name
    });

    const order = await createOrder({
      imageUrl,
      backImageUrl: backUrl,
      base64Image,
      variantId,
      quantity,
      position,
      backPosition,
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
    const { cloudinaryUrl, backImageUrl, variantId, position, backPosition, recipient, quantity } = req.body;

    if (!cloudinaryUrl || !variantId || !recipient) {
      return res.status(400).json({ error: 'Missing required fields: cloudinaryUrl, variantId, recipient', success: false });
    }

    // guard unsupported back
    let backUrl = backImageUrl;
    try {
      const supportsBack = await serverHasBack(variantId, req);
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
      backPosition,
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
      { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` } }
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
        optionNames: [],
        handle: '',
        image: img,
        shopifyVariantId: String(firstShopifyVid || ''),
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
    const { imageUrl, productId, variantId, backImageUrl } = req.query; // backImageUrl optional

    // 1. Upload crossword image to Printify
    const uploadedImage = await uploadImageFromUrl(imageUrl);

    // 2. Apply image to product (updates mockups in Printify)
    const updatedProduct = await applyImageToProduct(productId, variantId, uploadedImage.id);

    // 3. Extract preview mockup URLs
    const previewImages = updatedProduct.images.map(img => img.src);

    // 4. Return them to frontend
    res.json({ success: true, previewImages });
  } catch (err) {
    console.error("❌ Preview product error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/apps/crossword/preview-product', async (req, res) => {
  try {
    const { imageUrl, productId, variantId } = req.query;
    const backImageUrl = req.query.backImageUrl;

    const position = {
      x: req.query.x ? parseFloat(req.query.x) : 0.5,
      y: req.query.y ? parseFloat(req.query.y) : 0.5,
      scale: req.query.scale ? parseFloat(req.query.scale) : 1,
      angle: req.query.angle ? parseFloat(req.query.angle) : 0,
    };
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
    let uploadedBack = null;
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
        'User-Agent': 'Crossword-Preview/1.0'
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
      const area = variant?.placeholders?.find(pp => pp.position === 'front');
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
        printArea: { width: 300, height: 300, top: 50, left: 50 }
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
      { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` } }
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
      { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` } }
    );
    const productsJson = await productsRes.json();
    const products = productsJson.data || [];

    const results = {};
    for (const prod of products) {
      const detailRes = await fetch(
        `https://api.printify.com/v1/shops/${shopId}/products/${prod.id}.json`,
        { headers: { Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}` } }
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
    const { puzzleId, orderId, crosswordImage, cluesImage, cluesText } = req.body;

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

    // Generate styled PDF immediately (1–2 pages)
    const fetchMaybe = async (url) => (url ? fetchBuf(url) : null);
    const [puzzleBuf, cluesBuf] = await Promise.all([
      fetchMaybe(crosswordImage),
      fetchMaybe(cluesImage)
    ]);

    const pdfBytes = await buildGridAndCluesPdf({
      gridBuf: puzzleBuf || undefined,
      cluesBuf: cluesBuf || undefined,
  cluesText: cluesText || '',         
  puzzleId
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="crossword-${puzzleId.slice(0,8)}.pdf"`);
    return res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error('Direct PDF generation failed:', error);
    return res.status(500).json({ error: 'PDF generation failed' });
  }
});

// Preview PDF (branded, same builder) — supports POST (preferred) and GET
app.all('/preview-pdf', async (req, res) => {
  try {
    const payload = req.method === 'POST' ? req.body : req.query;
    const imageUrl   = String(payload.imageUrl || '');
    const cluesUrl   = String(payload.cluesUrl || '');
    const cluesText  = String(payload.cluesText || '').trim();
    const scale      = Number(payload.scale || 1) || 1;
    const watermark  = String(payload.watermark ?? '1') !== '0'; // default: show PREVIEW

    if (!imageUrl) return res.status(400).send('Missing imageUrl');

    const fetchMaybe = async (url) => (url ? fetchBuf(url) : null);
    const [gridBuf, cluesBuf] = await Promise.all([
      fetchMaybe(imageUrl),
      fetchMaybe(cluesUrl)
    ]);

    // Build with the SAME function used for real PDFs (adds brand header/footer/bg/fonts)
    let pdfBytes = await buildGridAndCluesPdf({
      gridBuf: gridBuf || undefined,
      cluesBuf: cluesBuf || undefined,
      cluesText,                 // prefer text typesetting for preview too
      puzzleId: 'PREVIEW',
      opts: { scale }
    });

    // Optional: overlay watermark without affecting layout
    if (watermark) {
      const doc = await PDFDocument.load(pdfBytes);
      const pages = doc.getPages();
      for (const page of pages) {
        const { width: a4w, height: a4h } = page.getSize();
        page.drawText('PREVIEW', {
          x: a4w * 0.18,
          y: a4h * 0.45,
          size: 64,
          color: rgb(0.8, 0.1, 0.1),
          rotate: { type: 'degrees', angle: 35 },
          opacity: 0.2
        });
      }
      pdfBytes = await doc.save();
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="crossword-preview.pdf"');
    return res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('Preview PDF failed:', err);
    return res.status(500).send('Preview failed');
  }
});



// === PDF claim & download (App Proxy style) ===
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

    const fetchMaybe = async (url) => (url ? fetchBuf(url) : null);

    const puzzleBuf = await fetchMaybe(rec.crosswordImage);
    const cluesBuf  = await fetchMaybe(rec.cluesImage);

    const pdfBytes = await buildGridAndCluesPdf({
      gridBuf: puzzleBuf || undefined,
      cluesBuf: cluesBuf || undefined,
  cluesText: (rec.cluesText || ''),  
  puzzleId
    });

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

// Local constants for Printify REST calls
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
async function getVariantPlaceholderNames(blueprintId, printProviderId) {
  const url = `${PRINTIFY_BASE}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/print_areas.json`;
  const data = await safeFetch(url, { headers: PIFY_HEADERS });

  const names = new Set();
  const areas = Array.isArray(data?.print_areas) ? data.print_areas
              : Array.isArray(data) ? data
              : [];

  for (const area of areas) {
const placeholders = area?.placeholders || area?.placeholders_json || area?.placeholdersList || [];
for (const ph of placeholders) {
  const pos = (ph?.position || ph?.name || ph)?.toString().trim().toLowerCase();
  if (pos) names.add(pos);
}
// keep name, but also capture area.position if present
if (area?.position) names.add(String(area.position).trim().toLowerCase());
if (area?.name)     names.add(String(area.name).trim().toLowerCase());

  }

  if (names.size === 0) names.add('front'); // safe fallback
  return Array.from(names);
}

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
  placeholders = await getVariantPlaceholderNames(bp, pp);
} catch (e) {
  // keep fallback
}

// 🔧 ADD: merge variant-specific placements from the actual shop product
try {
  const detail = await safeFetch(`${PRINTIFY_BASE}/shops/${SHOP_ID}/products/${product.id}.json`, { headers: PIFY_HEADERS });
  const fromProduct = (detail?.print_areas || [])
    .flatMap(a => (a?.placeholders || []).map(ph =>
      (ph?.position || ph?.name || '').toString().trim().toLowerCase()
    ))
    .filter(Boolean);
  placeholders = Array.from(new Set([...placeholders, ...fromProduct]));
} catch (_) {
  // ignore and rely on catalog-only data
}

const hasBack = placeholders.some(n => /back|rear|reverse|backside|secondary|alt/i.test(n));


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
      hasBack: hasBack
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

// [ADMIN] List Shopify variants that are missing from variantMap
app.get('/admin/variant-map/gaps', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

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
app.get('/debug/pdf-brand', (req, res) => {
  res.json({
    PDF_LOGO_URL: !!process.env.PDF_LOGO_URL,
    PDF_BRAND_BG_URL: !!process.env.PDF_BRAND_BG_URL,
    PDF_FONT_URL: !!process.env.PDF_FONT_URL
  });
});

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
