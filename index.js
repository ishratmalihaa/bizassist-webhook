const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ===== CONFIG ===== */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "bizassist123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";

const BASE =
  "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";

const PRODUCTS_URL = `${BASE}/api/public/get-products`;
const ALERT_URL = `${BASE}/api/public/order-alert`;

/* ===== MEMORY ===== */
const seen = new Map();
const history = new Map();

/* ===== CACHE ===== */
let cache = { data: [], time: 0 };

async function getProducts() {
  const now = Date.now();

  if (now - cache.time < 20000 && cache.data.length) {
    return cache.data;
  }

  try {
    const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`, {
      headers: { "x-api-key": WEBHOOK_API_KEY },
    });

    const data = Array.isArray(res.data?.data) ? res.data.data : [];

    cache = { data, time: now };
    return data;
  } catch {
    return cache.data || [];
  }
}

/* ===== HISTORY ===== */
function getHistory(id) {
  if (!history.has(id)) {
    history.set(id, {
      lastProduct: null,
      awaitingOrderConfirm: false,
      orderProduct: null,
    });
  }
  return history.get(id);
}

/* ===== INTENT ===== */
function getIntent(msg = "") {
  msg = msg.toLowerCase();

  if (/do you have|have you|available|ache ki|ache naki/.test(msg))
    return "check";

  if (/price|dam/.test(msg)) return "price";
  if (/color|rong/.test(msg)) return "color";
  if (/stock|available|ache/.test(msg)) return "stock";
  if (/order|buy/.test(msg)) return "order";

  return "general";
}

/* ===== PRODUCT MATCH ===== */
function findProduct(products, msg) {
  if (!Array.isArray(products)) return null;

  msg = (msg || "").toLowerCase();

  let best = null;
  let score = 0;

  for (const p of products) {
    if (!p?.product_name) continue;

    const name = p.product_name.toLowerCase();

    if (msg.includes(name)) return p;

    const words = name.split(" ").filter(Boolean);
    const match = words.filter(w => msg.includes(w)).length;

    const s = words.length ? match / words.length : 0;

    if (s > score) {
      score = s;
      best = p;
    }
  }

  return score >= 0.4 ? best : null;
}

/* ===== SEND ===== */
async function sendMessage(sender, text) {
  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      { recipient: { id: sender }, message: { text } },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );
  } catch (err) {
    console.error(err.message);
  }
}

/* ===== ALERT ===== */
async function sendAlert(sender, product) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: sender,
      product_name: product.product_name,
    });
  } catch {}
}

/* ===== MAIN LOGIC ===== */
async function process(sender, msg, products, h) {
  const intent = getIntent(msg);
  const m = msg.toLowerCase();

  /* ORDER CONFIRM */
  if (h.awaitingOrderConfirm) {
    if (/yes|ok|ha|sure/i.test(m)) {
      const p = h.orderProduct;

      h.awaitingOrderConfirm = false;
      h.orderProduct = null;

      await sendAlert(sender, p);

      return `Order confirmed: ${p.product_name}`;
    }

    if (/no/i.test(m)) {
      h.awaitingOrderConfirm = false;
      h.orderProduct = null;
      return "Order cancelled";
    }
  }

  let product = findProduct(products, msg);

  if (!product && h.lastProduct) {
    product = h.lastProduct;
  }

  if (product) h.lastProduct = product;

  if (!product) return "Product not found";

  const name = product.product_name;
  const price = product.price_bdt || "N/A";
  const inStock = product.stock_availability === "in_stock";

  /* 🔥 NEW: CHECK FIX */
  if (intent === "check") {
    return inStock
      ? `Yes, I have ${name}`
      : `Sorry, I don't have ${name}`;
  }

  if (intent === "price") return `${name} price ${price} BDT`;

  if (intent === "stock")
    return inStock ? `${name} is available` : `${name} is not available`;

  if (intent === "order") {
    h.awaitingOrderConfirm = true;
    h.orderProduct = product;
    return `Do you want to order ${name}? (yes/no)`;
  }

  return `${name} - ${price} BDT`;
}

/* ===== WEBHOOK ===== */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    for (const entry of req.body?.entry || []) {
      for (const event of entry?.messaging || []) {
        if (!event?.message || event.message.is_echo) continue;

        const sender = event.sender?.id;
        const msg = event.message?.text || "";
        const mid = event.message?.mid;

        if (!sender || !mid) continue;
        if (seen.has(mid)) continue;

        seen.set(mid, Date.now());

        const products = await getProducts();
        const h = getHistory(sender);

        const reply = await process(sender, msg, products, h);

        await sendMessage(sender, reply);
      }
    }
  } catch (e) {
    console.error("WEBHOOK ERROR:", e.message);
  }
});

/* ===== VERIFY ===== */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* ===== START ===== */
app.listen(3000, () => console.log("🚀 BizAssist Running"));
