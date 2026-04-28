const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ================= ENV SAFETY ================= */
const env = process.env || {};

const VERIFY_TOKEN = env.VERIFY_TOKEN || "bizassist123";
const PAGE_ACCESS_TOKEN = env.PAGE_ACCESS_TOKEN || "";
const WEBHOOK_API_KEY = env.WEBHOOK_API_KEY || "";

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";

const BASE =
  "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";

const PRODUCTS_URL = `${BASE}/api/public/get-products`;

/* ================= SAFETY CHECK ================= */
if (!PAGE_ACCESS_TOKEN) {
  console.warn("⚠️ PAGE_ACCESS_TOKEN missing (messages will not send)");
}

/* ================= MEMORY ================= */
const seen = new Map();
const historyMap = new Map();

/* ================= CACHE ================= */
let cache = { data: [], time: 0 };

/* ================= CLEANUP (PREVENT MEMORY LEAK) ================= */
setInterval(() => {
  const now = Date.now();

  for (const [mid, time] of seen.entries()) {
    if (now - time > 60 * 1000) seen.delete(mid);
  }

  for (const [id, data] of historyMap.entries()) {
    if (data?.lastSeen && now - data.lastSeen > 24 * 60 * 60 * 1000) {
      historyMap.delete(id);
    }
  }
}, 30000);

/* ================= SAFE UTIL ================= */
const safeLower = (v) => (v || "").toString().toLowerCase().trim();

/* ================= GET PRODUCTS ================= */
async function getProducts() {
  const now = Date.now();

  if (Array.isArray(cache.data) && now - cache.time < 20000) {
    return cache.data;
  }

  try {
    const res = await axios.get(
      `${PRODUCTS_URL}?seller_id=${SELLER_ID}`,
      {
        headers: { "x-api-key": WEBHOOK_API_KEY },
        timeout: 8000,
      }
    );

    const raw = res.data;

    let data = [];
    if (Array.isArray(raw)) data = raw;
    else if (Array.isArray(raw?.data)) data = raw.data;
    else if (Array.isArray(raw?.products)) data = raw.products;

    cache = {
      data: Array.isArray(data) ? data : [],
      time: now,
    };

    return cache.data;
  } catch (err) {
    console.error("PRODUCT ERROR:", err.message);
    return Array.isArray(cache.data) ? cache.data : [];
  }
}

/* ================= HISTORY ================= */
function getHistory(id) {
  if (!historyMap.has(id)) {
    historyMap.set(id, {
      lastProduct: null,
      awaitingOrder: false,
      orderProduct: null,
      lastSeen: Date.now(),
    });
  }

  const h = historyMap.get(id);
  h.lastSeen = Date.now();
  return h;
}

/* ================= INTENT ================= */
function getIntent(msg = "") {
  msg = safeLower(msg);

  if (/price|dam|koto/.test(msg)) return "price";
  if (/color|rong/.test(msg)) return "color";
  if (/stock|available|ache/.test(msg)) return "stock";
  if (/order|buy|nibo/.test(msg)) return "order";

  return "general";
}

/* ================= PRODUCT MATCH ================= */
function findProduct(products, msg = "") {
  if (!Array.isArray(products)) return null;

  msg = safeLower(msg);

  let best = null;
  let score = 0;

  for (const p of products) {
    if (!p?.product_name) continue;

    const name = safeLower(p.product_name);

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

/* ================= SEND MESSAGE ================= */
async function sendMessage(sender, text) {
  if (!PAGE_ACCESS_TOKEN) return;

  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      {
        recipient: { id: sender },
        message: { text },
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
        timeout: 8000,
      }
    );
  } catch (err) {
    console.error("FB ERROR:", err.response?.data || err.message);
  }
}

/* ================= AI ENGINE ================= */
async function ai(sender, msg, products, h) {
  msg = safeLower(msg);
  const intent = getIntent(msg);

  if (msg.includes("stop")) return "ঠিক আছে 👍";

  /* ORDER FLOW */
  if (h.awaitingOrder) {
    if (/^(yes|haan|ok|sure|nibo)$/i.test(msg)) {
      const p = h.orderProduct;

      h.awaitingOrder = false;
      h.orderProduct = null;

      if (!p) return "⚠️ Product missing";

      return `🛒 Order confirmed: ${p.product_name}`;
    }

    if (/^(no|cancel|na)$/i.test(msg)) {
      h.awaitingOrder = false;
      h.orderProduct = null;
      return "❌ Cancelled";
    }
  }

  /* PRODUCT FIND */
  let product = findProduct(products, msg);

  const isContext =
    /\b(ki|ache|eta|this|it)\b/.test(msg) &&
    /(color|rong|price|dam|stock|available)/.test(msg);

  if (!product && isContext) {
    product = h.lastProduct;
  }

  if (!product) {
    const list = (products || [])
      .slice(0, 5)
      .map(p => `• ${p.product_name}`)
      .join("\n");

    return `Product পাওয়া যায়নি 😕\n\nAvailable:\n${list}`;
  }

  h.lastProduct = product;

  const name = product.product_name;
  const price = product.price_bdt || "N/A";
  const color = product.color || "N/A";

  if (intent === "price") return `${name} price ${price} BDT`;
  if (intent === "color") return `${name} color: ${color}`;

  if (intent === "stock") {
    return product.stock_availability === "in_stock"
      ? `${name} available`
      : `${name} out of stock`;
  }

  if (intent === "order") {
    h.awaitingOrder = true;
    h.orderProduct = product;
    return `Do you want to order ${name}? (yes/no)`;
  }

  return `${name} - ${price} BDT`;
}

/* ================= WEBHOOK ================= */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    for (const entry of req.body?.entry || []) {
      for (const event of entry?.messaging || []) {
        if (!event.message || event.message.is_echo) continue;

        const sender = event.sender?.id;
        const msg = event.message?.text || "";
        const mid = event.message?.mid;

        if (!sender || !mid) continue;
        if (seen.has(mid)) continue;

        seen.set(mid, Date.now());

        const products = await getProducts();
        const h = getHistory(sender);

        const reply = await ai(sender, msg, products, h);

        await sendMessage(sender, reply);
      }
    }
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }
});

/* ================= VERIFY ================= */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* ================= START ================= */
const PORT = env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 BizAssist PRODUCTION READY RUNNING on", PORT);
});
