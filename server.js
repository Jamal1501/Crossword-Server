// server.js  (updated)
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
     if (!origin) return callback(null, true); // allow server-to-server / curl
     const ok = whitelist.some((re) => re.test(origin));
     return ok ? callback(null, true) : callback(new Error('Not allowed by CORS: ' + origin));
   },
   methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
   allowedHeaders: ['Content-Type', 'Authorization'],
   credentials: true,
 };


const { createOrder } = printifyService;
const app = express();

// --- load variant map (existing) ---
let variantMap = {};
try {
  const json = await fs.readFile('./variant-map.json', 'utf-8');
  variantMap = JSON.parse(json);
  console.log('✅ Loaded variant-map.json with', Object.keys(variantMap).length, 'entries');
} catch (err) {
  console.error('❌ Failed to load variant-map.json:', err.message);
}

// --- NEW: load print areas ---
let printAreas = {};
try {
  const json = await fs.readFile(PRINT_AREAS_PATH, 'utf-8');
  printAreas = JSON.parse(json);
  console.log('✅ Loaded print-areas.json from', PRINT_AREAS_PATH, 'with', Object.keys(printAreas).length, 'entries');
} catch (err) {
  console.warn('ℹ️ No print-areas.json at', PRINT_AREAS_PATH, '→ fallback:', err.message);
}


app.use(cors(corsOptions));

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

// Shopify raw body middleware for HMAC verification
app.use('/webhooks/orders/create', bodyParser.raw({ type: 'application/json', limit: '2mb' }));

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;



async function handlePrintifyOrder(order) {
  // Flatten useful fields from Shopify line items
  const items = order.line_items.map((item) => {
    const custom_image = item.properties?.find(p => p.name === '_custom_image')?.value;
    const design_specs_raw = item.properties?.find(p => p.name === '_design_specs')?.value;
    const design_specs = design_specs_raw ? (() => { try { return JSON.parse(design_specs_raw); } catch { return null; } })() : null;

    return {
      title: item.title,
      variant_id: item.variant_id,            // Shopify variant ID
      custom_image,
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

    // We center the artwork; angle 0 for now. (Top/left handled in editor UI.)
    const position = { x: 0.5, y: 0.5, scale, angle: 0 };

    const recipient = {
      name: `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim(),
      email: order.email,
      phone: order.phone || '',
      address1: order.shipping_address?.address1 || '',
      city: order.shipping_address?.city || '',
      zip: order.shipping_address?.zip || '',
      country: order.shipping_address?.country_code || ''
    };

    try {
      const response = await createOrder({
        imageUrl: item.custom_image,
        variantId: printifyVariantId,
        position,
        recipient,
        // pass through for service to use if supported
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

  console.log('SECRET IN USE:', SHOPIFY_WEBHOOK_SECRET);
  console.log('RAW BODY STRING:', rawBody.toString());
  console.log('RAW BODY BUFFER:', rawBody);

  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  console.log('CALCULATED DIGEST:', digest);
  console.log('SHOPIFY HMAC HEADER:', hmac);

  if (digest !== hmac) {
    console.warn('⚠️ Webhook HMAC verification failed.');
    return res.status(401).send('HMAC validation failed');
  }

  const order = JSON.parse(rawBody.toString());
  console.log('✅ Verified webhook for order:', order.id);
  await handlePrintifyOrder(order);
  res.status(200).send('Webhook received');
});



app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    await generateMap();
    res.send('✅ Variant map regenerated and saved.');
  } catch (err) {
  console.error('❌ Error generating variant map:', err.message, err.stack);
  res.status(500).send(`Failed to regenerate variant map: ${err.message}`);
}
});


//app.post('/api/printify/create-test-product', async (req, res) => {
//try {
//const { shopifyTitle, shopifyHandle } = req.body;
//const product = await printifyService.createTestProduct({ shopifyTitle, shopifyHandle });
//res.json({ success: true, product });
//} catch (err) {
//console.error(err);
//res.status(500).json({ error: 'Product creation failed', details: err.message });
//}
//});


const submittedOrders = new Set();  // memory-only cache

app.post('/api/printify/order', async (req, res) => {
  try {
    const { imageUrl, base64Image, variantId, position, recipient } = req.body;
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
      variantId,
      recipient: recipient.name
    });

    const order = await createOrder({ imageUrl, base64Image, variantId, position, recipient });
    res.json({ success: true, order });
  } catch (err) {
    console.error('Order creation failed:', err);
    res.status(500).json({ error: 'Order creation failed', details: err.message });
  }
});

app.post('/save-crossword', async (req, res) => {
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
    const { cloudinaryUrl, variantId, position, recipient } = req.body;

    if (!cloudinaryUrl || !variantId || !recipient) {
      return res.status(400).json({ error: 'Missing required fields: cloudinaryUrl, variantId, recipient', success: false });
    }

    console.log('Creating order directly from Cloudinary URL:', cloudinaryUrl);

    const order = await createOrder({ imageUrl: cloudinaryUrl, variantId, position, recipient });
    res.json({ success: true, order });
  } catch (err) {
    console.error('Order creation failed:', err);
    res.status(500).json({ error: 'Order creation failed', details: err.message });
  }
});

import axios from 'axios';

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



    res.json({ products });
  } catch (error) {
    console.error('❌ Printify fetch failed:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch products from Printify' });
  }
});



app.get('/apps/crossword/products', async (req, res) => {
  try {
    const DEFAULT_AREA = { width: 300, height: 300, top: 50, left: 50 };

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
      const printifyId = variantMap[shopifyId] || null;
      const img = p.image?.src || p.images?.[0]?.src || '';

      const printifyVariantId = variantMap[shopifyId] || null;
const printifyProductId = printifyVariantId ? (pifyVariantToProduct.get(printifyVariantId) || null) : null;

out.push({
  // 🔑 new fields for editor preview
  id: printifyProductId,      // Printify product ID
  printifyVariantId,          // Printify variant ID

  // 🔑 keep all your old fields so nothing breaks
  title: p.title,
  handle: p.handle || '',
  image: img || '',
  shopifyVariantId: String(preferred?.id || ''),
  printifyProductId: variantMap[String(preferred?.id)] || null, // keep legacy
  variantId: preferred?.id || null,
  price: parseFloat(preferred?.price) || 0,
  printArea: printAreas[String(preferred?.id)] || DEFAULT_AREA
});

    }

    res.json({ products: out });
  } catch (err) {
    console.error('❌ Failed to load dynamic products:', err);
    res.status(500).json({ error: 'Failed to load products', details: err.message });
  }
});

import { uploadImageFromUrl, applyImageToProduct, fetchProduct } from './services/printifyService.js';

app.get('/apps/crossword/preview-product/legacy', async (req, res) => {
  try {
    const { imageUrl, productId, variantId } = req.query;

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

    if (!imageUrl || !productId || !variantId) {
      return res.status(400).json({ error: "Missing required params: imageUrl, productId, variantId" });
    }

    // 1. Upload the crossword image
    const uploaded = await uploadImageFromUrl(imageUrl);

    // 2. Apply it to the chosen product + variant
    await applyImageToProduct(productId, parseInt(variantId), uploaded.id);

    // 3. Fetch the updated product (mockup should now exist)
    const product = await fetchProduct(productId);

    res.json({
      success: true,
      uploadedImage: uploaded,
      product,
    });
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

// ---- Printify Preview ----
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
    // Protect route with secret token
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


export default app;
