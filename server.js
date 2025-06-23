import 'dotenv/config';
import express from 'express';
import { v2 as cloudinary } from 'cloudinary';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const printifyService = require('./services/printifyService');

// Enhanced CORS configuration
const corsOptions = {
  origin: true, // Allow all origins temporarily
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
const port = process.env.PORT || 8888;

// Increase payload limit for base64 images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Health check endpoint
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

// Save crossword endpoint with enhanced error handling
app.post('/save-crossword', async (req, res) => {
  try {
    console.log('Received save request');
    const { image } = req.body;
    
    if (!image) {
      return res.status(400).json({ 
        error: 'No image data provided',
        success: false 
      });
    }

    if (!image.startsWith('data:image/')) {
      return res.status(400).json({ 
        error: 'Invalid image format',
        success: false 
      });
    }

    console.log('Uploading to Cloudinary...');
    const result = await cloudinary.uploader.upload(image, {
      folder: 'crosswords',
      timeout: 60000 // 60 seconds timeout
    });
    
    console.log('Upload successful:', result.secure_url);
    res.json({ 
      url: result.secure_url,
      success: true 
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Failed to save image',
      details: error.message,
      success: false 
    });
  }
});

// Products endpoint with proper error handling
app.get('/products', async (req, res) => {
  try {
    const [printifyProducts, shopifyProducts] = await Promise.all([
      fetchPrintifyProducts(),
      fetchShopifyProducts()
    ]);

    const transformedData = transformProducts(printifyProducts, shopifyProducts);
    res.json(transformedData);
  } catch (error) {
    console.error('Products error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch products',
      details: error.message 
    });
  }
});

// Helper functions
async function fetchPrintifyProducts() {
  const response = await fetch(
    `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/products.json`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.PRINTIFY_API_KEY}`
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`Printify API error: ${response.status}`);
  }
  
  return response.json();
}

async function fetchShopifyProducts() {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/products.json`,
    {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_PASSWORD
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status}`);
  }
  
  return response.json();
}

function transformProducts(printifyData, shopifyData) {
  return {
    products: printifyData.data.map(printifyProduct => {
      const shopifyProduct = shopifyData.products.find(p => 
        p.title.toLowerCase().includes(printifyProduct.title.toLowerCase()) ||
        printifyProduct.title.toLowerCase().includes(p.title.toLowerCase())
      );

      return {
        id: printifyProduct.id,
        title: printifyProduct.title,
        image: printifyProduct.images[0]?.src || 'https://via.placeholder.com/150',
        price: (printifyProduct.variants[0]?.price || 0) / 100,
        variantId: shopifyProduct?.variants[0]?.id.toString() || '',
        shopifyProductId: shopifyProduct?.id || ''
      };
    }).filter(product => product.variantId)
  };
}

// Start server with environment check
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${port}`);
  console.log(`Health check available at http://localhost:${port}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

export default app;
