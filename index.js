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

/* ===== STARTUP CHECK ===== */
if (!PAGE_ACCESS_TOKEN) console.error("❌ PAGE_ACCESS_TOKEN missing!");
if (!WEBHOOK_API_KEY) console.error("❌ WEBHOOK_API_KEY missing!");

/* ===== MEMORY ===== */
const seen = new Map();
const history = new Map();
const cooldown = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seen) {
    if (now - t > 60000) seen.delete(k);
  }
}, 30000);

/* ===== CACHE ===== */
let cache = { data: [], time: 0 };

async function getProducts() {
  const now = Date.now();

  if (now - cache.time < 20000 && cache.data.length > 0) {
    return cache.data;
  }

  try {
    const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`, {
      headers: { "x-api-key": WEBHOOK_API_KEY },
      timeout: 8000,
    });

    const raw = res.data;

    let data = [];
    if (Array.isArray(raw)) data = raw;
    else if (Array.isArray(raw?.products)) data = raw.products;
    else if (Array.isArray(raw?.data)) data = raw.data;

    if (!Array.isArray(data)) data = [];

    if (data.length > 0) {
      cache = { data, time: now };
    }

    return data;
  } catch (err) {
    console.error("PRODUCT ERROR:", err.message);
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

/* ===== SPAM ===== */
function isSpam(user) {
  const now = Date.now();
  const last = cooldown.get(user) || 0;
  if (now - last < 1500) return true;
  cooldown.set(user, now);
  return false;
}

/* ===== MATCH ===== */
function findProduct(products, msg) {
  if (!Array.isArray(products)) return null;

  msg = (msg || "").toLowerCase();

  for (const p of products) {
    if (!p?.product_name) continue;
    if (msg.includes(p.product_name.toLowerCase())) return p;
  }

  let best = null;
  let bestScore = 0;

  for (const p of products) {
    if (!p?.product_name) continue;

    const words = p.product_name.toLowerCase().split(" ");
    const match = words.filter((w) => msg.includes(w)).length;
    const score = words.length ? match / words.length : 0;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return bestScore >= 0.4 ? best : null;
}

/* ===== INTENT ===== */
function getIntent(msg) {
  msg = msg.toLowerCase();

  if (/price|dam|koto|দাম/.test(msg)) return "price";
  if (/color|rong|রং/.test(msg)) return "color";
  if (/stock|ache|available|আছে/.test(msg)) return "stock";
  if (/order|buy|nibo|lagbe/.test(msg)) return "order";

  return "general";
}

/* ===== LANGUAGE ===== */
function getLang(msg) {
  if (/[\u0980-\u09FF]/.test(msg)) return "bn";
  if (/\b(koto|dam|ache|nai|ki|nibo|rong|lagbe)\b/i.test(msg)) return "bl";
  return "en";
}

function reply(lang, bn, bl, en) {
  if (lang === "bn") return bn;
  if (lang === "bl") return bl;
  return en;
}

/* ===== PRODUCT LIST ===== */
function productList(products, lang) {
  if (!products.length) {
    return reply(lang,
      "এখন কোনো product নেই।",
      "Ekhon kono product nai.",
      "No products available."
    );
  }

  const list = products.map(p => `• ${p.product_name}`).join("\n");

  return reply(lang,
    `আমাদের products:\n${list}\n\nকোনটার কথা জানতে চান?`,
    `Amader products:\n${list}\n\nKontar kotha jante chan?`,
    `Our products:\n${list}\n\nWhich one would you like to know about?`
  );
}

/* ===== SEND ===== */
async function sendMessage(sender, text, retry = 2) {
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
    if (retry > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return sendMessage(sender, text, retry - 1);
    }
    console.error("FB ERROR:", err.message);
  }
}

/* ===== MAIN LOGIC ===== */
async function processMessage(sender, msg, products, h) {
  const m = (msg || "").toLowerCase();
  const lang = getLang(msg);
  const intent = getIntent(msg);

  /* GREETING */
  if (/^(hi|hello|hey|assalamu alaikum|salam)$/i.test(m)) {
    return reply(lang,
      "আসসালামু আলাইকুম! কোন product চান?",
      "Assalamu alaikum! Kon product chan?",
      "Hello! Which product are you looking for?"
    );
  }

  /* THIS / ETA FIX 🔥 */
  let product = findProduct(products, msg);

  if (!product && /(this|eta|ota|eita|ta|eti)/i.test(m)) {
    product = h.lastProduct || products[0];
  }

  if (product) h.lastProduct = product;

  /* ORDER CONFIRM */
  if (h.awaitingOrderConfirm) {
    if (/yes|haa|ok|sure|nibo/i.test(m)) {
      const p = h.orderProduct;
      h.awaitingOrderConfirm = false;
      h.orderProduct = null;

      if (!p) return "Error";

      await sendAlert(sender, p);

      return `🛒 Order confirmed: ${p.product_name}`;
    }

    if (/no|na|cancel/i.test(m)) {
      h.awaitingOrderConfirm = false;
      h.orderProduct = null;
      return "❌ Order cancelled";
    }

    return "Please say yes or no";
  }

  if (!product) {
    if (intent === "order") {
      return "Which product do you want to order?";
    }
    return productList(products, lang);
  }

  const name = product.product_name;
  const price = product.price_bdt || "N/A";
  const color = product.color || "N/A";
  const stock = product.stock_availability === "in_stock";

  if (intent === "price") return `${name} price ${price} BDT`;
  if (intent === "color") return `${name} color ${color}`;
  if (intent === "stock") return stock ? "Available" : "Out of stock";

  if (intent === "order") {
    h.awaitingOrderConfirm = true;
    h.orderProduct = product;
    return `Confirm order for ${name}? (yes/no)`;
  }

  return `${name} - ${price} BDT`;
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
  } catch (err) {
    console.error("ALERT ERROR:", err.message);
  }
}

/* ===== WEBHOOK ===== */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    for (const entry of req.body?.entry || []) {
      for (const event of entry?.messaging || []) {
        if (!event?.message || event.message.is_echo) continue;

        const sender = event.sender.id;
        const msg = event.message?.text || "";
        const mid = event.message?.mid;

        if (!mid || seen.has(mid)) continue;

        seen.set(mid, Date.now());

        if (isSpam(sender)) continue;

        const products = await getProducts();
        const h = getHistory(sender);

        const reply = await processMessage(sender, msg, products, h);

        await sendMessage(sender, reply);
      }
    }
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 BizAssist ULTRA RUNNING on", PORT)
);
