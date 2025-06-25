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

export async function listBlueprints() {
  const url = `${BASE_URL}/catalog/blueprints.json`;
  return safeFetch(url, { headers: authHeaders() });
}

export async function findBlueprintId(keyword = 'mug') {
  const blueprints = await listBlueprints();
  const found = blueprints.find(b => b.title.toLowerCase().includes(keyword.toLowerCase()));
  if (!found) throw new Error(`No blueprint matching "${keyword}"`);
  return found.id;
}

export async function listPrintProviders(blueprintId) {
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers.json`;
  return safeFetch(url, { headers: authHeaders() });
}

export async function listVariants(blueprintId, printProviderId) {
  const url = `${BASE_URL}/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json?show-out-of-stock=1`;
  const raw = await safeFetch(url, { headers: authHeaders() });
  const variants = Array.isArray(raw) ? raw : (raw.variants || raw.data || []);
  if (!Array.isArray(variants)) {
    throw new Error(`Unexpected variants response: ${JSON.stringify(raw).slice(0, 500)}`);
  }
  return variants;
}

export async function getShopId() {
  const url = `${BASE_URL}/shops.json`;
  const data = await safeFetch(url, { headers: authHeaders() });
  return data?.[0]?.id ?? null;
}

export async function uploadImageFromBase64(base64Image) {
  try {
    // Validate input
    if (!base64Image || typeof base64Image !== 'string') {
      throw new Error('Invalid base64Image input');
    }

    // Handle data URL format (data:image/png;base64,xxxxx)
    let base64Content;
    let mimeType = 'image/png'; // default
    
    if (base64Image.startsWith('data:')) {
      const [header, content] = base64Image.split(',');
      if (!content) {
        throw new Error('Invalid data URL format');
      }
      base64Content = content;
      
      // Extract mime type from header
      const mimeMatch = header.match(/data:([^;]+)/);
      if (mimeMatch) {
        mimeType = mimeMatch[1];
      }
    } else {
      // Assume it's already base64 content
      base64Content = base64Image;
    }

    // Validate base64 content
    if (!base64Content || base64Content.length === 0) {
      throw new Error('Empty base64 content');
    }

    // Generate unique filename with proper extension
    const timestamp = Date.now();
    const extension = mimeType.split('/')[1] || 'png';
    const fileName = `crossword_${timestamp}.${extension}`;

    console.log(`Uploading image: ${fileName}, size: ${base64Content.length} chars, type: ${mimeType}`);

    const body = {
      contents: base64Content,
      file_name: fileName,
    };

    const url = `${BASE_URL}/uploads/images.json`;
    const result = await safeFetch(url, { 
      method: 'POST', 
      headers: authHeaders(), 
      body: JSON.stringify(body) 
    });

    console.log('Upload successful:', result);
    return result;

  } catch (error) {
    console.error('Image upload failed:', error);
    throw new Error(`Image upload failed: ${error.message}`);
  }
}

export async function createProduct({
  base64Image, // Changed from imageUrl to base64Image
  title = 'Crossword Mug',
  description = 'Auto-generated crossword design',
  tags = ['Crossword', 'Mug'],
  blueprintKeyword = 'Ceramic Mug',
  blueprintId,
  printProviderId,
  variantId,
  x = 0.5,
  y = 0.5,
  scale = 1.0,
  background = '#ffffff',
  priceCents = 1500,
}) {
  if (!blueprintId) blueprintId = await findBlueprintId(blueprintKeyword);

  if (!printProviderId) {
    const providers = await listPrintProviders(blueprintId);
    if (!providers?.length) throw new Error(`No providers for blueprint ${blueprintId}`);
    printProviderId = providers[0].id;
  }

  if (!variantId) {
    const variantsArr = await listVariants(blueprintId, printProviderId);
    if (!variantsArr.length) throw new Error(`No variants returned (provider ${printProviderId})`);
    const enabled = variantsArr.find(v => v.is_enabled !== false) || variantsArr[0];
    variantId = enabled.id;
  }

  const uploaded = await uploadImageFromBase64(base64Image);

  const payload = {
    title,
    description,
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    tags,
    variants: [
      { id: variantId, price: priceCents, is_enabled: true },
    ],
    print_areas: [
      {
        variant_ids: [variantId],
        placeholders: [
          {
            position: 'front',
            images: [
              { id: uploaded.id, x, y, scale, angle: 0 },
            ],
          },
        ],
        background,
      },
    ],
    is_visible: true,
  };

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products.json`;
  return safeFetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
}

export async function createTestProduct() {
  // Create a simple test base64 image (1x1 red pixel)
  const testBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  
  return createProduct({
    base64Image: testBase64,
  });
}

export async function createOrder({
  base64Image,
  variantId,
  position = { x: 0.5, y: 0.5, scale: 1.0, angle: 0 },
  recipient,
}) {
  if (!base64Image || !variantId || !recipient) {
    throw new Error('Missing required fields: base64Image, variantId, recipient');
  }

  console.log('Creating order with:', {
    hasImage: !!base64Image,
    imageLength: base64Image.length,
    variantId,
    recipient: recipient.name
  });

  const uploaded = await uploadImageFromBase64(base64Image);
  
  console.log('Image uploaded successfully:', uploaded.id);

  const payload = {
    external_id: `order-${Date.now()}`,
    label: 'Crossword Custom Order',
    line_items: [
      {
        variant_id: parseInt(variantId), // Ensure it's a number
        quantity: 1,
        print_areas: {
          front: [
            {
              id: uploaded.id,
              x: position.x,
              y: position.y,
              scale: position.scale,
              angle: position.angle,
            },
          ],
        },
      },
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

  console.log('Creating order with payload:', JSON.stringify(payload, null, 2));

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/orders.json`;
  return safeFetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
}
