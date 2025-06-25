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

  let uploaded;
  if (imageUrl) {
    uploaded = await uploadImageFromUrl(imageUrl);
  } else if (base64Image) {
    uploaded = await uploadImageFromBase64(base64Image);
  }

  const shopProductsUrl = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/products.json`;
  const response = await safeFetch(shopProductsUrl, { headers: authHeaders() });
  const products = Array.isArray(response.data) ? response.data : response;
  if (!Array.isArray(products)) {
    throw new Error(`Expected products to be an array but got: ${JSON.stringify(response).slice(0, 500)}`);
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
      break;
    }
  }

  if (!printProviderId || !blueprintId || !product) {
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
        print_areas: [
          {
            variant_ids: [parseInt(variantId)],
            placeholders: [
              {
                position: 'front',
                images: [
                  {
                    src: uploaded.src,
                    x: position.x,
                    y: position.y,
                    scale: position.scale,
                    angle: position.angle,
                  },
                ],
              },
            ],
          },
        ],
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

  const url = `${BASE_URL}/shops/${PRINTIFY_SHOP_ID}/orders.json`;
  return safeFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
}

export { safeFetch };
