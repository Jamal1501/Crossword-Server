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

export async function uploadImageFromUrl(imageUrl) {
  try {
    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new Error('Invalid imageUrl input');
    }

    try {
      new URL(imageUrl);
    } catch {
      throw new Error('Invalid URL format');
    }

    console.log(`Uploading image from URL: ${imageUrl}`);

    const body = {
      url: imageUrl,
      file_name: `crossword_${Date.now()}.png`,
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

export async function uploadImageFromBase64(base64Image) {
  try {
    if (!base64Image || typeof base64Image !== 'string') {
      throw new Error('Invalid base64Image input');
    }

    let base64Content;
    let mimeType = 'image/png';

    if (base64Image.startsWith('data:')) {
      const [header, content] = base64Image.split(',');
      if (!content) {
        throw new Error('Invalid data URL format');
      }
      base64Content = content;

      const mimeMatch = header.match(/data:([^;]+)/);
      if (mimeMatch) {
        mimeType = mimeMatch[1];
      }
    } else {
      base64Content = base64Image;
    }

    if (!base64Content || base64Content.length === 0) {
      throw new Error('Empty base64 content');
    }

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

export async function createOrder({
  imageUrl,
  base64Image,
  variantId,
  position = { x: 0.5, y: 0.5, scale: 1.0, angle: 0 },
  recipient,
}) {
  if ((!imageUrl && !base64Image) || !variantId || !recipient) {
    throw new Error('Missing required fields: imageUrl/base64Image, variantId, recipient');
  }

  console.log('Creating order with:', {
    hasImageUrl: !!imageUrl,
    hasBase64: !!base64Image,
    variantId,
    recipient: recipient.name
  });

  let uploaded;
  if (imageUrl) {
    uploaded = await uploadImageFromUrl(imageUrl);
  } else if (base64Image) {
    uploaded = await uploadImageFromBase64(base64Image);
  }

  console.log('Image uploaded successfully:', uploaded.id);

  const shopProductsUrl = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products.json`;
  const products = await safeFetch(shopProductsUrl, { headers: authHeaders() });

  let printProviderId = null;
  for (const product of products) {
    const variant = product.variants.find(v => v.id === parseInt(variantId));
    if (variant) {
      printProviderId = product.print_provider_id;
      break;
    }
  }

  if (!printProviderId) {
    throw new Error(`Unable to resolve print_provider_id for variant ${variantId}`);
  }

  const payload = {
    external_id: `order-${Date.now()}`,
    label: 'Crossword Custom Order',
    line_items: [
      {
        variant_id: parseInt(variantId),
        quantity: 1,
        print_provider_id: printProviderId,
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
  return safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}
