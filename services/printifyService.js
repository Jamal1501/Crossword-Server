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
