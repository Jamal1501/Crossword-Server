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
    'User-Agent': 'Crossword-Automation/1.2',
    ...extra,
  };
}

async function safeFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${options.method || 'GET'} ${url} → ${res.status}\n${txt}`);
  }
  return res.status === 204 ? null : await res.json();
}

export async function uploadImageFromUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new Error('Invalid imageUrl input');
  }
  try {
    new URL(imageUrl);
  } catch {
    throw new Error('Invalid URL format');
  }
  const body = {
    url: imageUrl,
    file_name: `crossword_${Date.now()}.png`,
  };
  const url = `${BASE_URL}/uploads/images.json`;
  return safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}

export async function uploadImageFromBase64(base64Image) {
  if (!base64Image || typeof base64Image !== 'string') {
    throw new Error('Invalid base64Image input');
  }
  let base64Content;
  let mimeType = 'image/png';
  if (base64Image.startsWith('data:')) {
    const [header, content] = base64Image.split(',');
    if (!content) throw new Error('Invalid data URL format');
    base64Content = content;
    const mimeMatch = header.match(/data:([^;]+)/);
    if (mimeMatch) mimeType = mimeMatch[1];
  } else {
    base64Content = base64Image;
  }
  if (!base64Content.length) {
    throw new Error('Empty base64 content');
  }
  const timestamp = Date.now();
  const extension = mimeType.split('/')[1] || 'png';
  const fileName = `crossword_${timestamp}.${extension}`;
  const body = {
    contents: base64Content,
    file_name: fileName,
  };
  const url = `${BASE_URL}/uploads/images.json`;
  return safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
}

export async function createTestProduct({ shopifyTitle, shopifyHandle }) {
  const payload = {
    title: shopifyTitle,
    description: "Auto-created crossword gift product.",
    blueprint_id: 1, // ← replace with your actual blueprint
    print_provider_id: 1, // ← replace with your actual provider
    variants: [
      {
        id: 111, // ← replace with actual variant ID
        price: 1500,
        is_enabled: true
      }
    ],
    print_areas: [
      {
        variant_ids: [111], // ← match above
        placeholders: [
          {
            position: "front",
            images: [
              {
                id: "PLACEHOLDER_IMAGE_ID", // ← optional, can be left empty
                x: 0.5,
                y: 0.5,
                scale: 1,
                angle: 0
              }
            ]
          }
        ]
      }
    ],
    external: {
      handle: `https://your-store.myshopify.com/products/${shopifyHandle}`
    }
  };

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products.json`;
  const response = await safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  return response;
}

export async function createOrder({
  imageUrl,
  base64Image,
  variantId,
  position = { x: 0.5, y: 0.5, scale: 1.0, angle: 0 },
  recipient,
}) {
  if ((!imageUrl && !base64Image) || !variantId || !recipient) {
    console.error('❌ Missing required fields:', { imageUrl, base64Image, variantId, recipient });
    throw new Error('Missing required fields: imageUrl/base64Image, variantId, recipient');
  }

  console.log('📤 Uploading image to Printify:', imageUrl || '[base64Image]');
  let uploaded;
  try {
    uploaded = imageUrl
      ? await uploadImageFromUrl(imageUrl)
      : await uploadImageFromBase64(base64Image);
    console.log('✅ Image uploaded to Printify:', uploaded);
  } catch (uploadErr) {
    console.error('❌ Failed to upload image to Printify:', uploadErr.message);
    throw uploadErr;
  }

  console.log('🔍 Fetching all Printify products...');
  let products;
  try {
    const shopProductsUrl = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products.json`;
    const response = await safeFetch(shopProductsUrl, { headers: authHeaders() });
    products = Array.isArray(response.data) ? response.data : response;
    if (!Array.isArray(products)) throw new Error('Not an array');
    console.log(`✅ Found ${products.length} Printify products.`);
  } catch (fetchErr) {
    console.error('❌ Failed to fetch Printify products:', fetchErr.message);
    throw fetchErr;
  }

  let product = null;
  let printProviderId = null;
  let blueprintId = null;

  for (const p of products) {
    const variant = p.variants?.find(v => v.id === parseInt(variantId));
    if (variant) {
      product = p;
      printProviderId = p.print_provider_id;
      blueprintId = p.blueprint_id;
      console.log(`✅ Matched variant ${variantId} to product:`, {
        title: p.title,
        blueprintId,
        printProviderId
      });
      break;
    }
  }

  if (!printProviderId || !blueprintId || !product) {
    console.error('❌ Could not resolve print_provider_id or blueprint_id for variant:', variantId);
    console.log('🧪 Scanned variants:', products.flatMap(p => p.variants.map(v => v.id)));
    throw new Error(`Unable to resolve print_provider_id or blueprint_id for variant ${variantId}`);
  }

  const payload = {
    external_id: `order-${Date.now()}`,
    label: 'Crossword Custom Order',
    line_items: [
      {
        variant_id: parseInt(variantId),
        quantity: 1,
        print_provider_id: printProviderId,
        blueprint_id: blueprintId,
        print_areas: {
          front: [
            {
              src: uploaded.preview_url,
              x: position.x,
              y: position.y,
              scale: position.scale,
              angle: position.angle,
            }
          ]
        }
      }
    ],
    shipping_method: 1,
    send_shipping_notification: true,
    address_to: {
      first_name: recipient.name.split(' ')[0],
      last_name: recipient.name.split(' ').slice(1).join(' ') || '-',
      email: recipient.email,
      address1: recipient.address1,
      city: recipient.city,
      country: recipient.country,
      zip: recipient.zip,
    },
  };

  console.log('📦 Final Printify order payload:', JSON.stringify(payload, null, 2));

  try {
    const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/orders.json`;
    const orderRes = await safeFetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    });
    console.log('✅ Printify order successfully created:', orderRes?.id || '[no id]');
    return orderRes;
  } catch (orderErr) {
    console.error('❌ Printify order creation failed:', orderErr.message);
    throw orderErr;
  }
}

export async function applyImageToProduct(productId, variantId, imageId) {
  if (!productId || !variantId || !imageId) {
    throw new Error("Missing productId, variantId or imageId");
  }

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;

  const payload = {
    print_areas: [
      {
        variant_ids: [parseInt(variantId)],
        placeholders: [
          {
            position: "front",
            images: [
              {
                id: imageId,   // ← comes from uploadImageFromUrl/Base64 response
                x: 0.5,
                y: 0.5,
                scale: 1,
                angle: 0
              }
            ]
          }
        ]
      }
    ]
  };

  return safeFetch(url, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}

export async function fetchProduct(productId) {
  if (!productId) {
    throw new Error("Missing productId");
  }

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products/${productId}.json`;

  return safeFetch(url, {
    method: 'GET',
    headers: authHeaders(),
  });
}

export { safeFetch };
