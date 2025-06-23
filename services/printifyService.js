import fetch from 'node-fetch';

const baseUrl = 'https://api.printify.com/v1/';
const apiKey = process.env.PRINTIFY_API_KEY;

export async function getShopId() {
  const res = await fetch(`${baseUrl}shops.json`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  if (!res.ok) throw new Error(`Printify API error: ${res.status}`);
  const data = await res.json();
  return data[0]?.id || null;
}
export async function uploadImage(imageUrl) {
  const res = await fetch(`${baseUrl}uploads/images.json`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file_url: imageUrl })
  });

  if (!res.ok) throw new Error(`Image upload failed: ${res.status}`);
  return await res.json();
}

export async function createProduct({ imageUrl, blueprintId, variantId, x, y, scale }) {
  const uploaded = await uploadImage(imageUrl);

  const body = {
    title: 'Crossword Test Mug',
    blueprint_id: blueprintId,
    print_provider_id: 3,
    variants: [
      { id: variantId, price: 1500, is_enabled: true }
    ],
    print_areas: [
      {
        variant_ids: [variantId],
        placeholders: [
          {
            position: 'front',
            images: [
              {
                id: uploaded.id,
                x,
                y,
                scale,
                angle: 0
              }
            ]
          }
        ]
      }
    ],
    is_visible: true
  };

  const res = await fetch(`${baseUrl}shops/${process.env.PRINTIFY_SHOP_ID}/products.json`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Product creation failed: ${res.status}`);
  return await res.json();
}
