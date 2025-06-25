import express from 'express';
import crypto from 'crypto';
import bodyParser from 'body-parser';

// Shopify requires raw body for HMAC
const app = express();
app.use('/webhooks/orders/create', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json()); // for all other routes

import 'dotenv/config';
import express from 'express';
import { v2 as cloudinary } from 'cloudinary';
import cors from 'cors';
import fetch from 'node-fetch';
import * as printifyService from './services/printifyService.js';
import { safeFetch } from './services/printifyService.js';


const { createOrder } = printifyService;

const app = express();

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

app.post('/webhooks/orders/create', (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const rawBody = req.body; // Buffer

  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  if (digest !== hmac) {
    console.warn('⚠️ Webhook HMAC verification failed.');
    return res.status(401).send('HMAC validation failed');
  }

  const order = JSON.parse(rawBody.toString());

  // Extract relevant data
  const items = order.line_items.map((item) => ({
    title: item.title,
    custom_image: item.properties?.find(p => p.name === '_custom_image')?.value,
    design_specs: item.properties?.find(p => p.name === '_design_specs')?.value,
  }));

  console.log('✅ Verified webhook for order:', order.id);
  console.log(JSON.stringify(items, null, 2));

  res.status(200).send('Webhook received');
});


/* ────────────────────────────────────────────────────────── CORS */
const corsOptions = {
  origin: true, // TODO: lock this down in prod
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));

/* ─────────────────────────────────────────────── Body parsing */
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/* ─────────────────────────────────────────── Cloudinary setup */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ───────────────────────────────────────────── Error handler */
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

/* ───────────────────────────────────────────── Health check */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ─────────────────────────────────────── Printify — shop test */
app.get('/api/printify/test', async (req, res) => {
  try {
    const shopId = await printifyService.getShopId();
    res.json({ success: true, shopId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Printify API failed', details: err.message });
  }
});

/* ─────────────────────────── Get test variantId */
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

/* ───────────────────────────────────── Printify — test product */
app.post('/api/printify/create-test-product', async (req, res) => {
  try {
    const product = await printifyService.createTestProduct();
    res.json({ success: true, product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Product creation failed', details: err.message });
  }
});

/* ───────────────────────────────────── NEW: Printify — create order with URL */
app.post('/api/printify/order', async (req, res) => {
  try {
    const { imageUrl, base64Image, variantId, position, recipient } = req.body;

    // Prioritize imageUrl over base64Image
    if (!imageUrl && !base64Image) {
      return res.status(400).json({ 
        error: 'Either imageUrl or base64Image is required', 
        success: false 
      });
    }

    if (!variantId || !recipient) {
      return res.status(400).json({ 
        error: 'Missing required fields: variantId, recipient', 
        success: false 
      });
    }

    console.log('Creating order with:', {
      hasImageUrl: !!imageUrl,
      hasBase64: !!base64Image,
      variantId,
      recipient: recipient.name
    });

    const order = await createOrder({ 
      imageUrl, // Use imageUrl if provided
      base64Image, // Fallback to base64Image
      variantId, 
      position, 
      recipient 
    });
    
    res.json({ success: true, order });
  } catch (err) {
    console.error('Order creation failed:', err);
    res.status(500).json({ error: 'Order creation failed', details: err.message });
  }
});

/* ─────────────────────────────────────────── Save crossword */
app.post('/save-crossword', async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No image data provided', success: false });
    }
    if (!image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image format', success: false });
    }

    const result = await cloudinary.uploader.upload(image, {
      folder: 'crosswords',
      timeout: 60000,
    });

    // Return both the URL and success flag
    res.json({ 
      url: result.secure_url, 
      success: true,
      public_id: result.public_id // Useful for future reference
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to save image', details: error.message, success: false });
  }
});

/* ─────────────────────────────────── NEW: Direct order from Cloudinary URL */
app.post('/api/printify/order-from-url', async (req, res) => {
  try {
    const { cloudinaryUrl, variantId, position, recipient } = req.body;

    if (!cloudinaryUrl || !variantId || !recipient) {
      return res.status(400).json({ 
        error: 'Missing required fields: cloudinaryUrl, variantId, recipient', 
        success: false 
      });
    }

    console.log('Creating order directly from Cloudinary URL:', cloudinaryUrl);

    const order = await createOrder({ 
      imageUrl: cloudinaryUrl, 
      variantId, 
      position, 
      recipient 
    });
    
    res.json({ success: true, order });
  } catch (err) {
    console.error('Order creation failed:', err);
    res.status(500).json({ error: 'Order creation failed', details: err.message });
  }
});

/* ─────────────────────────────────────────── Products list */
app.get('/products', async (req, res) => {
  try {
    const [printifyProducts, shopifyProducts] = await Promise.all([
      fetchPrintifyProducts(),
      fetchShopifyProducts(),
    ]);

    const transformed = transformProducts(printifyProducts, shopifyProducts);
    res.json(transformed);
  } catch (error) {
    console.error('Products error:', error);
    res.status(500).json({ error: 'Failed to fetch products', details: error.message });
  }
});

/* ─────────────────────────────────────── Helper functions */

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


/* ─────────────────────────────────────── Helper functions */
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

function transformProducts(printifyData, shopifyData) {
  return {
    products: printifyData.data
      .map(p => {
        const match = shopifyData.products.find(s =>
          s.title.toLowerCase().includes(p.title.toLowerCase()) ||
          p.title.toLowerCase().includes(s.title.toLowerCase()),
        );
        return {
          id: p.id,
          title: p.title,
          image: p.images[0]?.src || 'https://via.placeholder.com/150',
          price: (p.variants[0]?.price || 0) / 100,
          variantId: match?.variants[0]?.id?.toString() || '',
          shopifyProductId: match?.id || '',
        };
      })
      .filter(prod => prod.variantId),
  };
}

/* ────────────────────────────────────────────── Boot server */
const port = process.env.PORT || 8888;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${port}`);
  console.log(`Health check → http://localhost:${port}/health`);
});

/* ────────────────────────────────────────── Graceful shutdown */
process.on('SIGTERM', () => {
  console.log('SIGTERM received: closing HTTP server');
  server.close(() => console.log('HTTP server closed'));
});

export default app;
