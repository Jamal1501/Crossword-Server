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
import { uploadImageFromUrl, applyImageToProduct, applyImagesToProductDual, fetchProduct, clampContainScale } from './services/printifyService.js';
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
const { createOrderBatch } = printifyService;
const app = express();

// --- CORS & parsers (run BEFORE routes) ---
app.set('trust proxy', 1);
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

app.get('/print-areas.json', (req, res) => {
  res.json(printAreas);
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
  if (!token || !puzzleId || !orderId) return false;

  const expected = issuePdfToken(String(puzzleId), String(orderId));

  try {
    const a = Buffer.from(String(token), 'hex');
    const b = Buffer.from(String(expected), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}


// ===== PDF Background per Theme =====
// Fallback: PDF_BRAND_BG_URL
// Optional mapping: PDF_BG_BY_THEME_JSON='{"default":"https://...","birthday":"https://..."}'
function getPdfBgUrlForTheme(themeKey) {
  const fallback = process.env.PDF_BRAND_BG_URL || '';
  const key = String(themeKey || 'default').trim().toLowerCase() || 'default';

  try {
    const raw = process.env.PDF_BG_BY_THEME_JSON || '';
    if (!raw) return fallback;

    const map = JSON.parse(raw);
    if (map && typeof map === 'object') {
      return String(map[key] || map.default || fallback || '');
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// Build a public base URL that works behind proxies (Render/Cloudflare/etc.)
function getPublicBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
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
async function buildGridAndCluesPdf({ gridBuf, cluesBuf, backgroundBuf, cluesText = '', puzzleId = '', opts = {} } = {}) {
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
  const bgUrl = (opts && opts.bgUrl)
    ? String(opts.bgUrl)
    : getPdfBgUrlForTheme(opts?.themeKey);
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

  // Helper to add a page with crossword grid (user background fills page, crossword properly sized)
  const addImagePage = async (crosswordBuf, userBackgroundBuf, title, pageIndex) => {
    const page = pdf.addPage([a4w, a4h]);

    // Layer 1: User's background (if provided) - FULL BLEED
    if (userBackgroundBuf) {
      try {
        const isPng = userBackgroundBuf[0] === 0x89 && userBackgroundBuf[1] === 0x50;
        const bgImg = isPng ? await pdf.embedPng(userBackgroundBuf) : await pdf.embedJpg(userBackgroundBuf);
        
        // Scale background to COVER entire page
        const bgAspect = bgImg.width / bgImg.height;
        const pageAspect = a4w / a4h;
        
        let bgW, bgH, bgX, bgY;
        if (bgAspect > pageAspect) {
          bgH = a4h;
          bgW = bgH * bgAspect;
          bgX = (a4w - bgW) / 2;
          bgY = 0;
        } else {
          bgW = a4w;
          bgH = bgW / bgAspect;
          bgX = 0;
          bgY = (a4h - bgH) / 2;
        }
        
        page.drawImage(bgImg, { x: bgX, y: bgY, width: bgW, height: bgH });
      } catch (e) {
        console.warn('[PDF] User background failed:', e.message);
      }
    } else if (bgUrl) {
      // Fallback: theme background if no user background
      try {
        const bgBuf = await fetchBuf(bgUrl);
        const bgImg = (bgBuf[0] === 0x89 && bgBuf[1] === 0x50) ? await pdf.embedPng(bgBuf) : await pdf.embedJpg(bgBuf);
        
        const bgAspect = bgImg.width / bgImg.height;
        const pageAspect = a4w / a4h;
        
        let bgW, bgH, bgX, bgY;
        if (bgAspect > pageAspect) {
          bgH = a4h;
          bgW = bgH * bgAspect;
          bgX = (a4w - bgW) / 2;
          bgY = 0;
        } else {
          bgW = a4w;
          bgH = bgW / bgAspect;
          bgX = 0;
          bgY = (a4h - bgH) / 2;
        }
        
        page.drawImage(bgImg, { x: bgX, y: bgY, width: bgW, height: bgH });
      } catch (e) {
        console.warn('[PDF] Theme background failed:', e.message);
      }
    }

    // Layer 2: Header/Footer
    paintHeaderFooter(page, title, pageIndex);

    // Layer 3: Crossword (properly sized, centered)
    if (crosswordBuf) {
      const isPng = crosswordBuf[0] === 0x89 && crosswordBuf[1] === 0x50;
      const img = isPng ? await pdf.embedPng(crosswordBuf) : await pdf.embedJpg(crosswordBuf);
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

    // background image (theme brand) - FULL BLEED COVER
    if (bgUrl) {
      try {
        const bgBuf = await fetchBuf(bgUrl);
        const bgImg = (bgBuf[0] === 0x89 && bgBuf[1] === 0x50) ? await pdf.embedPng(bgBuf) : await pdf.embedJpg(bgBuf);
        
        const bgAspect = bgImg.width / bgImg.height;
        const pageAspect = a4w / a4h;
        
        let bgW, bgH, bgX, bgY;
        if (bgAspect > pageAspect) {
          bgH = a4h;
          bgW = bgH * bgAspect;
          bgX = (a4w - bgW) / 2;
          bgY = 0;
        } else {
          bgW = a4w;
          bgH = bgW / bgAspect;
          bgX = 0;
          bgY = (a4h - bgH) / 2;
        }
        
        page.drawImage(bgImg, { x: bgX, y: bgY, width: bgW, height: bgH });
      } catch (e) {
        console.warn('PDF bg load failed:', e.message);
      }
    }

    paintHeaderFooter(page, 'Crossword Clues', pageIndex);

    // If cluesText provided -> typeset; otherwise fall back to image embedding if cluesBuf present
    if (cluesText && cluesText.trim().length) {
      const baseSize = Number(process.env.PDF_CLUES_BASE_SIZE || 11.5);
      const fontSize = Math.max(8, Math.min(34, baseSize * (Number(scale) || 1)));
      const leading = fontSize * 1.35;
      const contentMaxW = maxW;
      const contentMaxH = maxH;

      const normalized = cluesText.replace(/\r/g, '');
      const paragraphs = normalized.split('\n\n');

      let lines = [];
      for (const p of paragraphs) {
        const rawLines = p.split('\n').map(s => s.trim()).filter(Boolean);
        for (const rl of rawLines) {
          const wrapped = wrapTextToLines(rl, useFont, fontSize, contentMaxW);
          lines.push(...wrapped);
        }
        lines.push('');
      }

      const contentHeight = lines.length * leading;
      let startY = (a4h - margin - headerH) - ((headerH - footerH) / 2) - (contentHeight / 2);
      const topLimit = a4h - margin - headerH - 10;
      const bottomLimit = margin + footerH + 10;
      if (startY > topLimit) startY = topLimit;
      if (startY - contentHeight < bottomLimit) startY = Math.max(bottomLimit + contentHeight, startY);

// ✅ Center the whole clues block horizontally + vertically on the page
const cleanLines = lines.filter(l => l && l.trim().length);

// ----- HORIZONTAL block centering -----
const widths = cleanLines.map(l => useFont.widthOfTextAtSize(l, fontSize));
const widest = widths.length ? Math.max(...widths) : 0;

// ideal centered x for the whole block
let blockX = (a4w - widest) / 2;

// keep block inside margins (safety clamp)
const minX = margin;
const maxX = a4w - margin - widest;
blockX = Math.max(minX, Math.min(blockX, maxX));

// ----- VERTICAL block centering -----
const blockHeight = cleanLines.length * leading;

// define usable vertical area (page minus margins)
const topY = a4h - margin;
const bottomY = margin;

// center of the usable area
const centerY = (topY + bottomY) / 2;

// startY should be the top line position such that the whole block is centered
let y = centerY + (blockHeight / 2) - fontSize;

// clamp so it never goes above top margin
if (y > topY - fontSize) y = topY - fontSize;

// draw lines downwards
for (const line of cleanLines) {
  page.drawText(line, {
    x: blockX,
    y,
    size: fontSize,
    font: useFont,
    color: rgb(0.08, 0.08, 0.08),
  });

  y -= leading;
  if (y < bottomY) break;
}

    } else if (cluesBuf) {
      const isPng = cluesBuf[0] === 0x89 && cluesBuf[1] === 0x50;
      const img = isPng ? await pdf.embedPng(cluesBuf) : await pdf.embedJpg(cluesBuf);
      const { width, height } = img.size();
      const scaleImg = Math.min(maxW / width, maxH / height, 1.9);
      const w = width * scaleImg, h = height * scaleImg;
      const x = (a4w - w) / 2;
      const y = (a4h - h) / 2 - ((headerH - footerH) / 2);
      page.drawImage(img, { x, y, width: w, height: h });
    } else {
      page.drawText('No clues available', { x: margin, y: a4h - margin - headerH - 10, size: 12, font: useFont, color: rgb(0.5,0.5,0.5) });
    }
  };

  let pageIndex = 1;

  // GRID page (crossword with user's background behind it)
  if (gridBuf) {
    await addImagePage(gridBuf, backgroundBuf, 'Crossword Grid', pageIndex);
    pageIndex++;
  }

  // CLUES page (text preferred, else image)
  await addCluesPage({ cluesBuf, cluesText, pageIndex, scale: opts.scale || 1 });

  return Buffer.from(await pdf.save());
}


async function sendEmailViaResend({ to, subject, html, attachments = [] }) {
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
      attachments
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Resend failed: ${res.status} ${t}`);
  }
}

async function sendEmailWithAttachment({ to, subject, html, filename, pdfBuffer }) {
  return sendEmailViaResend({
    to,
    subject,
    html,
    attachments: [{
      filename,
      content: pdfBuffer.toString('base64')
    }]
  });
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

// ------------------------------------------------------------------
// BATCH ORDER FIX: One Printify order per Shopify order
// ------------------------------------------------------------------
async function handlePrintifyOrder(order) {
  // Flatten useful fields from Shopify line items
  const items = order.line_items.map((li) => {
    const props = Array.isArray(li.properties) ? li.properties : [];
    const getProp = (name) => {
      const p = props.find(x => x && x.name === name);
      return p ? String(p.value || '') : '';
    };

// ✅ Printify must use MERGED composite
    const custom_image      = getProp('_merged_image_url') || getProp('_custom_image');
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

  // BATCH mode: one Printify order with multiple line_items.
  const BATCH_MODE = true; // keep simple and safe; switch to env flag later if you want
  const batchItems = [];

  // Build one recipient from the order shipping address
  const _ship = order?.shipping_address || {};
  const orderRecipient = {
    name: [_ship.first_name, _ship.last_name].filter(Boolean).join(' ') || _ship.name || 'Customer',
    email: (order?.email || order?.customer?.email || '').trim() || undefined,
    phone: (_ship.phone || order?.phone || '').trim() || undefined,
    address1: _ship.address1 || '',
    address2: _ship.address2 || '',
    city: _ship.city || '',
    region: _ship.province || _ship.province_code || '',
    country: _ship.country_code || _ship.country || '',
    zip: _ship.zip || ''
  };

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

    // --- use live placeholder for this Printify variant (front) ---
    let phFront = null;
    try {
      const { blueprintId, printProviderId } = await resolveBpPpForVariant(printifyVariantId);
      phFront = await getVariantPlaceholderByPos(
        blueprintId, printProviderId, Number(printifyVariantId), 'front'
      );
    } catch { /* keep null fallback */ }

    // --- derive scale from design_specs.size relative to real area width ---
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

    // --- normalize x/y using real area dims ---
    const topPx  = parseFloat(item.design_specs?.top  || '0');
    const leftPx = parseFloat(item.design_specs?.left || '0');
    let x = 0.5, y = 0.5;

    if (phFront?.width && phFront?.height) {
      const imgW = phFront.width  * scale;
      const imgH = phFront.height * scale;
      x = Math.min(1, Math.max(0, (leftPx + imgW / 2) / phFront.width));
      y = Math.min(1, Math.max(0, (topPx  + imgH / 2) / phFront.height));
    }

    const position = { x, y, scale, angle: 0 };

    // --- back placement: keep multiplier approach (clamped) ---
    const BACK_SCALE_MULT = Number(process.env.BACK_SCALE_MULT || 1);
    const backScale = Math.max(0.1, Math.min(2, scale * BACK_SCALE_MULT));
    const backPosition = { x: 0.5, y: 0.5, scale: backScale, angle: 0 };

    // --- make sure 'area' exists before you pass it below ---
    const area = printAreas?.[shopifyVid] || null;

    // --- finally, call createOrder (legacy) OR collect for batch ---
    const backImageUrl =
      item.clue_output_mode === 'back' && item.clues_image_url ? item.clues_image_url : undefined;

    if (!BATCH_MODE) {
      // Legacy per-item order (unchanged)
      const recipient = orderRecipient; // same data, but per-item is fine
      try {
        const response = await createOrder({
          imageUrl: item.custom_image,
          backImageUrl,
          variantId: printifyVariantId,
          quantity: item.quantity,
          position,
          backPosition,
          recipient,
          printArea: area || undefined,
          meta: { shopifyVid, title: item.title }
        });

        console.log('✅ Printify order created:', response?.id || '[no id]', { shopifyVid, printifyVariantId, scale });
      } catch (err) {
        console.error('❌ Failed to create Printify order:', {
          shopifyVid, printifyVariantId, scale, err: err?.message || err
        });
      }
    } else {
      // Collect into batch (one Printify order)
      batchItems.push({
        imageUrl: item.custom_image,
        backImageUrl,
        variantId: printifyVariantId,
        quantity: item.quantity,
        position,
        backPosition
      });
    }
  }

  // After collecting all items, submit as a single Printify order
  if (BATCH_MODE && batchItems.length > 0) {
    try {
      const response = await createOrderBatch({
        items: batchItems,
        recipient: orderRecipient,
        externalId: `shopify-${order?.id || Date.now()}`
      });
      console.log('✅ Printify BATCH order created:', response?.id || '[no id]', { count: batchItems.length });
    } catch (err) {
      console.error('❌ Failed to create Printify BATCH order:', {
        count: batchItems.length, err: err?.message || err
      });
    }
  }
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
      
// ✅ PDF wants UNMERGED crossword, not the merged composite
const crosswordImage =
  getProp('_crossword_image_url') ||
  getProp('_grid_image_url') ||
  getProp('_custom_image');

const cluesImage     = getProp('_clues_image_url');
const backgroundImage = getProp('_background_image');


      // NEW: parse text from design_specs / _clues_text
      const design_specs_raw = getProp('_design_specs') || '';
      let design_specs = null;
      try {
        design_specs = design_specs_raw ? JSON.parse(design_specs_raw) : null;
      } catch {}
      const themeKey =
  (design_specs && (design_specs.themeKey || design_specs.theme || design_specs.theme_key))
  || getProp('_theme')
  || 'default';
      const explicitCluesText = getProp('_clues_text') || '';
      const cluesText = (design_specs && String(design_specs.clues_text || '').trim())
        || String(explicitCluesText || '').trim()
        || '';

PaidPuzzles.set(pid, {
  orderId: String(order.id),
  email: (order.email || order?.customer?.email || '') + '',
  crosswordImage,
  backgroundImage,
  cluesImage,
  cluesText,
  themeKey, // ✅ NEW
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

// === Email: deliver ALL PDFs for this order (ONE email), attachments <=3 else links ===
try {
  const to =
    [order.email, order.contact_email, order?.customer?.email, process.env.EMAIL_FALLBACK_TO]
      .map(e => (e || '').trim())
      .find(e => e && e.includes('@')) || '';

  if (!to) {
    console.warn('No buyer email on order; skipping PDF email.');
    return res.status(200).send('Webhook received (no email)');
  }

  const orderId = String(order?.id || '');
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  // 1) Collect unique puzzleIds in the order they appear (no guessing)
  const deliverables = [];
  const seen = new Set();

  for (const li of lineItems) {
    const props = Array.isArray(li.properties) ? li.properties : [];
    const getProp = (name) => {
      const p = props.find(x => x && x.name === name);
      return p ? String(p.value || '') : '';
    };

    const pid = getProp('_puzzle_id');
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);

    // Prefer server-side record if available (more reliable)
    const rec = (typeof PaidPuzzles !== 'undefined') ? PaidPuzzles.get(pid) : null;

    // Fallback to line item properties if record missing
const gridUrl =
  rec?.crosswordImage ||
  getProp('_crossword_image_url') ||
  getProp('_grid_image_url') ||
  getProp('_custom_image');

const bgUrl =
  rec?.backgroundImage ||
  getProp('_background_image');
    const cluesUrl = rec?.cluesImage || getProp('_clues_image_url');
    const shopVid  = String(li.variant_id || '');
    const themeKey =
      rec?.themeKey
      || (() => {
        const raw = getProp('_design_specs') || '';
        try {
          const ds = raw ? JSON.parse(raw) : null;
          return (ds && (ds.themeKey || ds.theme || ds.theme_key)) || getProp('_theme') || 'default';
        } catch {
          return getProp('_theme') || 'default';
        }
      })();

    // clues text: prefer stored record, then design_specs.clues_text, then explicit _clues_text
    const designSpecsRaw = getProp('_design_specs') || '';
    let design_specs = null;
    try { design_specs = designSpecsRaw ? JSON.parse(designSpecsRaw) : null; } catch { design_specs = null; }

    const explicitCluesText = getProp('_clues_text') || '';
    const cluesText =
      (rec?.cluesText && String(rec.cluesText).trim())
      || (design_specs && String(design_specs.clues_text || '').trim())
      || String(explicitCluesText || '').trim()
      || '';

    // computed scale (keep your existing behavior)
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
    } catch {
      // keep default
    }

deliverables.push({
  pid,
  gridUrl,
  bgUrl,       // ✅ NEW
  cluesUrl,
  cluesText,
  themeKey,
  computedScale,
});
  }

  if (!deliverables.length) {
    console.warn('No _puzzle_id found in order line_items; cannot deliver PDFs.');
    return res.status(200).send('Webhook received (no puzzle ids)');
  }

  // 2) Decide delivery mode (your required cutoff)
  const deliveryMode = (deliverables.length <= 3) ? 'attachments' : 'links';

  const subject = 'Your crosswords are ready';
  const instantVsShippingLine =
    'Your PDFs are ready instantly — your printed products will arrive separately.';

  if (deliveryMode === 'attachments') {
    // Build ALL PDFs (<=3), attach all in ONE email
    const attachments = [];

    for (let i = 0; i < deliverables.length; i++) {
      const d = deliverables[i];

      // fetch image buffers (if present)
const [gridBuf, cluesBuf, backgroundBuf] = await Promise.all([
  d.gridUrl ? fetchBuf(d.gridUrl) : Promise.resolve(null),
  d.cluesUrl ? fetchBuf(d.cluesUrl) : Promise.resolve(null),
  d.bgUrl ? fetchBuf(d.bgUrl) : Promise.resolve(null),
]);


      // Build unified PDF (grid + clues). If cluesText is present, typeset it; otherwise it falls back to embedding cluesBuf.
      let pdfBuffer;
      try {
pdfBuffer = await buildGridAndCluesPdf({
  gridBuf: gridBuf || undefined,
  backgroundBuf: backgroundBuf || undefined, // ✅ NEW
  cluesBuf: cluesBuf || undefined,
  cluesText: d.cluesText || '',
  puzzleId: d.pid,
  opts: { scale: d.computedScale, themeKey: d.themeKey || 'default' }
});
      } catch (e) {
        console.error(`❌ buildGridAndCluesPdf failed for puzzle ${d.pid}:`, e);
        // fallback: images only
        try {
          pdfBuffer = await buildGridAndCluesPdf({
            gridBuf: gridBuf || undefined,
            cluesBuf: cluesBuf || undefined,
            cluesText: '',
            puzzleId: d.pid,
            opts: { scale: d.computedScale, themeKey: d.themeKey || 'default' }
          });
        } catch (ee) {
          console.error('❌ Fallback PDF generation also failed:', ee);
          continue;
        }
      }

      attachments.push({
        filename: `Crossword ${i + 1}.pdf`,
        content: pdfBuffer.toString('base64'),
        contentType: 'application/pdf'
      });
    }

    if (!attachments.length) {
      console.warn('No PDFs could be generated for attachments mode.');
      return res.status(200).send('Webhook received (no pdfs built)');
    }

    await sendEmailViaResend({
      to,
      subject,
      html: `
        <p>${instantVsShippingLine}</p>
        <p>Attached: ${attachments.length} PDF(s)</p>
      `,
      attachments
    });

    console.log(`📧 Sent ONE email with ${attachments.length} PDF attachment(s) to ${to}`);
  } else {
    // Links mode (>3): NO attachments, just tokenized downloads
    const base = getPublicBaseUrl(req);
    const links = [];

    for (let i = 0; i < deliverables.length; i++) {
      const d = deliverables[i];

      // You already have token logic; reuse it (order-bound)
      const token = issuePdfToken(d.pid, orderId);

      const url =
        `${base}/apps/crossword/download-pdf` +
        `?puzzleId=${encodeURIComponent(d.pid)}` +
        `&token=${encodeURIComponent(token)}`;

      links.push({ index: i + 1, url });
    }

    if (!links.length) {
      console.warn('No links could be built for links mode.');
      return res.status(200).send('Webhook received (no links built)');
    }

    await sendEmailViaResend({
      to,
      subject,
      html: `
        <p>${instantVsShippingLine}</p>
        <p>Your crosswords are ready:</p>
        <ul>
          ${links.map(l => `<li>Crossword ${l.index} – <a href="${l.url}">Download</a></li>`).join('')}
        </ul>
      `,
      attachments: [] // explicitly none
    });

    console.log(`📧 Sent ONE links email with ${links.length} download link(s) to ${to}`);
  }
} catch (e) {
    console.error('❌ multi-pdf email delivery failed:', e);
  }

  return res.status(200).send('Webhook received');
});  // This closes app.post('/webhooks/orders/create'

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


// [BG] Upload background image only (separate folder)
app.options('/save-background-image', cors(corsOptions));
app.post('/save-background-image', cors(corsOptions), async (req, res) => {
  try {
    const { image } = req.body;

    if (!image || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid or missing image', success: false });
    }

    const result = await cloudinary.uploader.upload(image, {
      folder: 'crossword_backgrounds',
      timeout: 60000,
    });

    res.json({ url: result.secure_url, success: true, public_id: result.public_id });
  } catch (error) {
    console.error('Background upload error:', error);
    res.status(500).json({ error: 'Failed to save background image', details: error.message, success: false });
  }
});

// [BG] Dedicated endpoint for background-committed composites (separate folder)
app.options('/save-crossword-final', cors(corsOptions));
app.post('/save-crossword-final', cors(corsOptions), async (req, res) => {
  try {
    const { image } = req.body;

    if (!image || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid or missing image', success: false });
    }

    const result = await cloudinary.uploader.upload(image, {
      folder: 'crosswords_final',
      timeout: 60000,
    });

    res.json({ url: result.secure_url, success: true, public_id: result.public_id });
  } catch (error) {
    console.error('Final upload error:', error);
    res.status(500).json({ error: 'Failed to save final image', details: error.message, success: false });
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

// ===== Theme -> Shopify collection handle mapping =====
// Shopify collection handles you create in Admin, e.g. upsell-birthday
const THEME_COLLECTION_HANDLE = (themeKey) => {
  const key = String(themeKey || '').trim().toLowerCase();
  if (!key || key === 'default') return null;
  return `upsell-${key}`;
};

// Cache allowed variant IDs per theme (avoid Shopify API every request)
const _themeVariantCache = new Map(); // themeKey -> { ts, variantIds: Set<string> | null }
const THEME_CACHE_TTL_MS = 5 * 60 * 1000;

// Admin GraphQL helper (basic auth)
async function shopifyGraphQL(query, variables = {}) {
  const store = process.env.SHOPIFY_STORE; // e.g. bad1x2-nm.myshopify.com
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!store) throw new Error('Missing SHOPIFY_STORE env (must be *.myshopify.com)');
  if (!token) throw new Error('Missing SHOPIFY_ADMIN_ACCESS_TOKEN env');

  const url = `https://${store}/admin/api/2024-04/graphql.json`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await r.json();
  if (!r.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

/**
 * Returns:
 * - null => "no filtering" (show all products)
 * - Set<string> => allowed Shopify variant IDs for this theme
 *
 * IMPORTANT: If collection is missing or empty, we return null (show all),
 * because you said you'd rather show all than none.
 */
async function getAllowedShopifyVariantIdsForTheme(themeKey) {
  const handle = THEME_COLLECTION_HANDLE(themeKey);
  if (!handle) return null; // default theme => no filtering

  const cached = _themeVariantCache.get(themeKey);
  if (cached && (Date.now() - cached.ts) < THEME_CACHE_TTL_MS) {
    return cached.variantIds; // may be null
  }

  const query = `
    query($handle: String!) {
      collectionByHandle(handle: $handle) {
        id
        products(first: 250) {
          edges {
            node {
              variants(first: 250) {
                edges { node { legacyResourceId } }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { handle });
  const c = data?.collectionByHandle;

  // Collection missing => fallback to ALL products (no filtering)
  if (!c) {
    console.warn(`ℹ️ Theme collection not found: ${handle} -> showing ALL products (no filtering)`);
    _themeVariantCache.set(themeKey, { ts: Date.now(), variantIds: null });
    return null;
  }

  const set = new Set();
  const pEdges = c?.products?.edges || [];
  for (const pEdge of pEdges) {
    const vEdges = pEdge?.node?.variants?.edges || [];
    for (const vEdge of vEdges) {
      const id = vEdge?.node?.legacyResourceId;
      if (id) set.add(String(id));
    }
  }

  // Empty collection => fallback to ALL products (no filtering)
  if (set.size === 0) {
    console.warn(`ℹ️ Theme collection empty: ${handle} -> showing ALL products (no filtering)`);
    _themeVariantCache.set(themeKey, { ts: Date.now(), variantIds: null });
    return null;
  }

  _themeVariantCache.set(themeKey, { ts: Date.now(), variantIds: set });
  return set;
}

// Printify-only product feed (uses variantMap to link back)
app.get('/apps/crossword/products', async (req, res) => {
  try {
    const DEFAULT_AREA = { width: 800, height: 500, top: 50, left: 50 };

    const themeKey = String(req.query.theme || 'default');
    const allowedShopifyVariantIds = await getAllowedShopifyVariantIdsForTheme(themeKey);

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

      // mapped variants only
      let mappedVariants = (p.variants || []).filter(v => rev[String(v.id)] && rev[String(v.id)][0]);

      // Theme filtering: keep only variants whose Shopify variant ID is in the theme collection
      // If allowedShopifyVariantIds is null => no filtering (show all mapped variants)
      if (allowedShopifyVariantIds) {
        mappedVariants = mappedVariants.filter(v => {
          const shopVid = rev[String(v.id)]?.[0];
          return shopVid && allowedShopifyVariantIds.has(String(shopVid));
        });
      }

      if (!mappedVariants.length) continue; // nothing sellable (or nothing allowed)

      // pick a preferred mapped variant
      const pref = mappedVariants[0];
      const firstShopifyVid = rev[String(pref.id)][0];

      // build UI variants (only mapped / allowed)
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
        id: p.id,
        printifyVariantId: pref.id,
        variants: variantList,
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
    console.error('❌ /apps/crossword/products failed:', err);
    res.status(500).json({ error: 'Failed to load products', details: err.message });
  }
});



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

    if (!imageUrl || !productId || !variantId) {
      return res.status(400).json({ error: "Missing required params: imageUrl, productId, variantId" });
    }

    const num = (v, d) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : d;
    };

    // Front placement (defaults centered)
    const position = {
      x: num(req.query.x, 0.5),
      y: num(req.query.y, 0.5),
      scale: num(req.query.scale, 1),
      angle: num(req.query.angle, 0),
    };

    // Optional back placement overrides (falls back to front if not provided)
    const backPosition = {
      x: num(req.query.backX, position.x),
      y: num(req.query.backY, position.y),
      scale: num(req.query.backScale, position.scale),
      angle: num(req.query.backAngle, position.angle),
    };

    const vId = Number(variantId);

    // 0) Snapshot current product (images + variant list) so we can return only the new mockups
    const before = await fetchProduct(productId);
    const beforeSrcs = new Set((before?.images || []).map(i => i?.src).filter(Boolean));

    // Hard safety: variant must belong to product (prevents wrong mockups / wrong bp+pp)
    const beforeVariants = Array.isArray(before?.variants) ? before.variants : [];
    if (!beforeVariants.some(v => Number(v?.id) === vId)) {
      return res.status(400).json({
        error: 'Variant does not belong to productId',
        productId: String(productId),
        variantId: vId
      });
    }

    const blueprintId = Number(before?.blueprint_id);
    const printProviderId = Number(before?.print_provider_id);

    // 1) Upload FRONT (+ optional BACK) image(s)
    const uploadedFront = await uploadImageFromUrl(imageUrl);
    let uploadedBack = null;
    if (backImageUrl) {
      uploadedBack = await uploadImageFromUrl(backImageUrl);
    }

    // 2) Contain-fit clamp scales using REAL Printify catalog placeholder sizes.
    //    This makes your on-site preview match what Printify will actually render.
    const FRONT_SCALE_MULT = Number(process.env.FRONT_SCALE_MULT || 1.0);

    try {
      const phFront = await getVariantPlaceholderByPos(blueprintId, printProviderId, vId, 'front');
      position.scale = clampContainScale({
        Aw: phFront?.width,
        Ah: phFront?.height,
        Iw: uploadedFront?.width,
        Ih: uploadedFront?.height,
        requested: (position.scale ?? 1) * FRONT_SCALE_MULT
      });
    } catch (e) {
      console.warn('[preview-product] contain-fit clamp failed (front):', e?.message || e);
      position.scale = Math.max(0, Math.min(1, position.scale ?? 1));
    }

    if (uploadedBack?.id) {
      try {
        const phBack = await getVariantPlaceholderByPos(blueprintId, printProviderId, vId, 'back');
        backPosition.scale = clampContainScale({
          Aw: phBack?.width,
          Ah: phBack?.height,
          Iw: uploadedBack?.width,
          Ih: uploadedBack?.height,
          requested: (backPosition.scale ?? 1)
        });
      } catch (e) {
        console.warn('[preview-product] contain-fit clamp failed (back):', e?.message || e);
        backPosition.scale = Math.max(0, Math.min(1, backPosition.scale ?? 1));
      }
    } else {
      backPosition.scale = Math.max(0, Math.min(1, backPosition.scale ?? 1));
    }

    // 3) Apply to product (updates mockups in Printify)
    if (uploadedBack?.id) {
      await applyImagesToProductDual(
        productId,
        parseInt(variantId, 10),
        uploadedFront.id,
        uploadedBack.id,
        position,
        backPosition
      );
    } else {
      await applyImageToProduct(productId, parseInt(variantId, 10), uploadedFront.id, position);
    }

    // 4) Poll for mockups (Printify needs a few seconds)
    let product;
    for (let attempt = 1; attempt <= 10; attempt++) {
      product = await fetchProduct(productId);
      const ready = Array.isArray(product?.images) && product.images.some(i => i?.src);
      if (ready) break;
      await new Promise(r => setTimeout(r, 1200)); // ~12s max
    }

    // 5) Delta: only new images (prefer images tagged with this variant)
    const afterImgs = Array.isArray(product?.images) ? product.images : [];
    const deltas = afterImgs.filter(i => i?.src && !beforeSrcs.has(i.src));
    const tagged = deltas.filter(i => {
      const ids = Array.isArray(i.variant_ids) ? i.variant_ids.map(Number) : null;
      return !ids || ids.includes(vId);
    });

    const imgs = (tagged.length ? tagged : deltas).map(i => i.src).filter(Boolean);
    const imgsNewestFirst = imgs.slice().reverse();

    const heroSrc = before?.images?.[0]?.src || null;

    res.json({
      success: true,
      uploadedImage: uploadedFront,
      uploadedBackImage: uploadedBack,
      product,
      imgs: imgsNewestFirst,
      heroSrc,
      debug: {
        blueprintId,
        printProviderId,
        position,
        backPosition
      }
    });
  } catch (err) {
    console.error("❌ Preview generation failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// [ADD] Return Printify placeholder box (width/height) for a variant and position
// PAYLOAD:
//   Request: GET /apps/crossword/placeholder-size?variantId=<number>&position=<string>
//   Response: { width: number|null, height: number|null }
app.get('/apps/crossword/placeholder-size', async (req, res) => {
  try {
    const { variantId, position = 'front' } = req.query;
    if (!variantId) {
      // do not hard fail — keep preview working even if client sent nothing
      return res.json({ width: null, height: null });
    }

    // NOTE: These functions already exist in your Printify service.
    const { resolveBpPpForVariant, getVariantPlaceholderByPos } = await import('./services/printifyService.js');

    const meta = await resolveBpPpForVariant(parseInt(variantId, 10));
    if (!meta?.blueprintId || !meta?.printProviderId) {
      return res.json({ width: null, height: null });
    }

    const ph = await getVariantPlaceholderByPos(
      meta.blueprintId,
      meta.printProviderId,
      parseInt(variantId, 10),
      String(position || 'front')
    );

    if (ph && Number(ph.width) > 0 && Number(ph.height) > 0) {
      return res.json({ width: Number(ph.width), height: Number(ph.height) });
    }

    return res.json({ width: null, height: null });
  } catch (e) {
    console.warn('[placeholder-size] failed:', e?.message);
    // SOFT FAIL — never 500; client will fallback to old preview logic
    res.json({ width: null, height: null });
  }
});

app.get('/api/printify/products', async (req, res) => {
  try {
    const qs  = new URLSearchParams(req.query).toString();
    const url = `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/products.json${qs ? `?${qs}` : ''}`;
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

// [ADD] List ALL published Printify products (read-only audit)
app.get('/admin/printify/published-products', async (req, res) => {
  try {
    const { listPublishedProducts } = await import('./services/printifyService.js');
    // implement listPublishedProducts to call Printify:
    // GET /v1/shops/:shop_id/products.json?status=published&limit=100
    const out = await listPublishedProducts({ status: 'published', limit: 100 });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
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
    const themeKey =
  String(payload.themeKey || payload.theme || payload.theme_key || 'default')
    .trim()
    .toLowerCase() || 'default';
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
      opts: { scale, themeKey }
    });

    // Optional: overlay tiled/small watermark without affecting layout
    if (watermark) {
      const doc = await PDFDocument.load(pdfBytes);
      const pages = doc.getPages();

      // --- Tweak these if you want ---
      const WM_TEXT   = 'LOVEFRAMES';
      const WM_SIZE   = 14;     // small text size
      const WM_OPAC   = 0.40;   // subtle opacity
      const WM_ANGLE  = 30;     // degrees
      const STEP_X    = 140;    // horizontal spacing between repeats
      const STEP_Y    = 110;    // vertical spacing between repeats
      const X_OFFSET  = 0;      // shift pattern horizontally if needed
      const Y_OFFSET  = 0;      // shift pattern vertically if needed
      // --------------------------------

      for (const page of pages) {
        const { width: a4w, height: a4h } = page.getSize();

        // Tile beyond page bounds so rotation has full coverage
        for (let x = -a4w; x < a4w * 2; x += STEP_X) {
          for (let y = -a4h; y < a4h * 2; y += STEP_Y) {
            page.drawText(WM_TEXT, {
              x: x + X_OFFSET,
              y: y + Y_OFFSET,
              size: WM_SIZE,
              color: rgb(0.8, 0.1, 0.1),
              rotate: { type: 'degrees', angle: WM_ANGLE },
              opacity: WM_OPAC,
            });
          }
        }
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

// In the webhook handler, when building PDFs:

const fetchMaybe = async (url) => (url ? fetchBuf(url) : null);

const puzzleBuf = await fetchMaybe(rec.crosswordImage);  // This is the composite
const cluesBuf  = await fetchMaybe(rec.cluesImage);
const backgroundBuf = await fetchMaybe(rec.backgroundImage);  // ✅ NEW - original background

const pdfBytes = await buildGridAndCluesPdf({
  gridBuf: puzzleBuf || undefined,
  cluesBuf: cluesBuf || undefined,
  backgroundBuf: backgroundBuf || undefined,  // ✅ NEW
  cluesText: (rec.cluesText || ''),
  puzzleId,
  opts: { themeKey: rec.themeKey || 'default' }
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

