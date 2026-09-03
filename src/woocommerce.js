const DEFAULT_TIMEOUT_MS = 15000;

function getConfig() {
  const baseUrl = (process.env.WOOCOMMERCE_URL || 'https://todolisto.uy').replace(/\/$/, '');
  const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error('Faltan WOOCOMMERCE_CONSUMER_KEY y/o WOOCOMMERCE_CONSUMER_SECRET.');
  }

  return { baseUrl, consumerKey, consumerSecret };
}

async function wooRequest(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { baseUrl, consumerKey, consumerSecret } = getConfig();
  const url = new URL(`/wp-json/wc/v3${path}`, baseUrl);
  url.searchParams.set('consumer_key', consumerKey);
  url.searchParams.set('consumer_secret', consumerSecret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const message = data?.message || `WooCommerce respondió ${response.status}`;
      throw new Error(message);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection() {
  const products = await wooRequest('/products?per_page=1');
  return {
    ok: true,
    sampleProductId: Array.isArray(products) && products[0] ? products[0].id : null,
  };
}

async function getProduct(productId) {
  return wooRequest(`/products/${productId}`);
}

async function findProductBySku(sku) {
  if (!sku) return null;
  const products = await wooRequest(`/products?sku=${encodeURIComponent(sku)}&per_page=1`);
  return Array.isArray(products) && products.length ? products[0] : null;
}

async function createProduct(payload) {
  return wooRequest('/products', { method: 'POST', body: payload });
}

async function updateProduct(productId, payload) {
  return wooRequest(`/products/${productId}`, { method: 'PUT', body: payload });
}

module.exports = {
  testConnection,
  getProduct,
  findProductBySku,
  createProduct,
  updateProduct,
};
