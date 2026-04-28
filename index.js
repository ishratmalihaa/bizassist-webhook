const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ===== CONFIG ===== */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "bizassist123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;
const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";
const BASE = "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${BASE}/api/public/get-products`;
const ALERT_URL = `${BASE}/api/public/order-alert`;

/* ===== STARTUP CHECK ===== */
if (!PAGE_ACCESS_TOKEN) console.error("❌ PAGE_ACCESS_TOKEN missing!");
if (!WEBHOOK_API_KEY) console.error("❌ WEBHOOK_API_KEY missing!");

/* ===== MEMORY ===== */
const seen = new Map();
const history = new Map();
const userCooldown = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 60000) seen.delete(k);
}, 30000);

/* ===== PRODUCT CACHE ===== */
let cache = { data: [], time: 0 };

async function getProducts() {
  const now = Date.now();
  if (now - cache.time < 20000 && cache.data.length > 0) return cache.data;

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

    if (data.length > 0) cache = { data, time: now };
    console.log("Products loaded:", data.length);
    return data;
  } catch (err) {
    console.error("Product fetch error:", err.message);
    return cache.data.length > 0 ? cache.data : [];
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

/* ===== SPAM CHECK ===== */
function isSpam(sender) {
  const now = Date.now();
  const last = userCooldown.get(sender) || 0;
  if (now - last < 1500) return true;
  userCooldown.set(sender, now);
  return false;
}

/* ===== PRODUCT MATCH ===== */
function findProduct(products, msg) {
  if (!Array.isArray(products) || !msg) return null;
  msg = msg.toLowerCase();

  // exact match আগে
  for (const p of products) {
    if (!p?.product_name) continue;
    if (msg.includes(p.product_name.toLowerCase())) return p;
  }

  // fuzzy match
  let best = null;
  let bestScore = 0;

  for (const p of products) {
    if (!p?.product_name) continue;
    const words = p.product_name.toLowerCase().split(" ").filter(Boolean);
    const matched = words.filter((w) => w.length > 2 && msg.includes(w)).length;
    const score = words.length ? matched / words.length : 0;
    if (score > bestScore) { bestScore = score; best = p; }
  }

  return bestScore >= 0.4 ? best : null;
}

/* ===== INTENT ===== */
function getIntent(msg) {
  msg = msg.toLowerCase();
  if (/price|dam|koto|দাম|কত/.test(msg)) return "price";
  if (/color|colour|rong|রং/.test(msg)) return "color";
  if (/stock|ache|available|আছে|ase/.test(msg)) return "stock";
  if (/order|buy|nibo|নেব|korbo|lagbe|chai/.test(msg)) return "order";
  return "general";
}

/* ===== LANGUAGE ===== */
function getLang(msg) {
  if (/[\u0980-\u09FF]/.test(msg)) return "bn";
  if (/\b(koto|dam|ache|nai|ki|taka|nibo|rong|lagbe|ase)\b/i.test(msg)) return "bl";
  return "en";
}

function reply3(lang, bn, bl, en) {
  if (lang === "bn") return bn;
  if (lang === "bl") return bl;
  return en;
}

/* ===== PRODUCT LIST (FALLBACK) ===== */
function productList(products, lang) {
  if (!products.length) return reply3(lang,
    "এখন কোনো product নেই।",
    "Ekhon kono product nai.",
    "No products available."
  );
  const list = products.map((p) => `• ${p.product_name}`).join("\n");
  return reply3(lang,
    `আমাদের products:\n${list}\n\nকোনটার কথা জানতে চান?`,
    `Amader products:\n${list}\n\nKontar kotha jante chan?`,
    `Our products:\n${list}\n\nWhich one would you like to know about?`
  );
}

/* ===== SEND MESSAGE (RETRY) ===== */
async function sendMessage(sender, text, retry = 2) {
  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      { recipient: { id: sender }, message: { text } },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 8000 }
    );
    console.log("✅ Sent to", sender);
  } catch (err) {
    console.error("Send error:", err.response?.data || err.message);
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      return sendMessage(sender, text, retry - 1);
    }
  }
}

/* ===== TYPING ===== */
async function sendTyping(sender) {
  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      { recipient: { id: sender }, sender_action: "typing_on" },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 3000 }
    );
  } catch { /* ignore */ }
}

/* ===== ORDER ALERT ===== */
async function sendAlert(sender, product) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: sender,
      product_name: product?.product_name || "Unknown",
    }, { timeout: 5000 });
    console.log("🛒 Order alert sent:", product?.product_name);
  } catch (err) {
    console.error("Alert error:", err.message);
  }
}

/* ===== MAIN AI LOGIC ===== */
async function processMessage(sender, msg, products, h) {
  const lang = getLang(msg);
  const intent = getIntent(msg);
  const m = msg.toLowerCase();

  /* ORDER CONFIRMATION */
  if (h.awaitingOrderConfirm) {
    if (/yes|haa|ha|ok|sure|ji|confirm|nibo|lagbe/i.test(m)) {
      const p = h.orderProduct;
      h.awaitingOrderConfirm = false;
      h.orderProduct = null;
      if (!p) return reply3(lang, "কিছু ভুল হয়েছে।", "Kichu vul hoyeche.", "Something went wrong.");
      await sendAlert(sender, p);
      h.lastProduct = p;
      return reply3(lang,
        `✅ ${p.product_name} এর order seller কে পাঠানো হয়েছে। তিনি শীঘ্রই confirm করবেন।`,
        `✅ ${p.product_name} order pathano hoyeche. Seller confirm korbe.`,
        `✅ Order for ${p.product_name} sent to seller. They will confirm shortly.`
      );
    }
    if (/^(no|na|না|nai|cancel)$/i.test(m)) {
      h.awaitingOrderConfirm = false;
      h.orderProduct = null;
      return reply3(lang, "❌ Order cancel হয়েছে।", "❌ Order cancel hoyeche.", "❌ Order cancelled.");
    }
    // কিছু না বুঝলে আবার জিজ্ঞেস করো
    return reply3(lang,
      "yes অথবা no বলুন।",
      "yes অথবা no bolen.",
      "Please reply yes or no."
    );
  }

  /* PRODUCT MATCH */
  let product = findProduct(products, msg);

  // context words
  if (!product && /^(this|eta|ota|eita|ati|ta|eti)$/i.test(m)) {
    product = h.lastProduct;
  }

  if (product) h.lastProduct = product;

  /* NO PRODUCT */
  if (!product) {
    if (intent === "order") {
      return reply3(lang,
        "কোন product order করতে চান সেটা বলুন।",
        "Kon product order korte chan?",
        "Which product would you like to order?"
      );
    }
    return productList(products, lang);
  }

  const name = product.product_name;
  const price = product.price_bdt || "N/A";
  const color = product.color || "N/A";
  const inStock = product.stock_availability === "in_stock";

  /* PRICE */
  if (intent === "price") {
    return reply3(lang,
      `${name} এর দাম ${price} টাকা।`,
      `${name} er dam ${price} taka.`,
      `${name} price is ${price} BDT.`
    );
  }

  /* COLOR */
  if (intent === "color") {
    return reply3(lang,
      `${name} এর রং: ${color}`,
      `${name} er color: ${color}`,
      `${name} colors: ${color}`
    );
  }

  /* STOCK */
  if (intent === "stock") {
    return reply3(lang,
      inStock ? `${name} এখন available আছে।` : `${name} এখন নেই।`,
      inStock ? `${name} ache.` : `${name} nai ekhon.`,
      inStock ? `${name} is in stock.` : `${name} is out of stock.`
    );
  }

  /* ORDER */
  if (intent === "order") {
    h.awaitingOrderConfirm = true;
    h.orderProduct = product;
    return reply3(lang,
      `🛒 আপনি কি "${name}" order করতে চান? (yes/no)`,
      `🛒 Apni ki "${name}" order korte chan? (yes/no)`,
      `🛒 Do you want to order "${name}"? (yes/no)`
    );
  }

  /* GENERAL */
  return reply3(lang,
    `${name} — দাম: ${price} টাকা, রং: ${color}${inStock ? ", এখন available।" : ", এখন নেই।"}`,
    `${name} — dam: ${price} taka, color: ${color}${inStock ? ", ache." : ", nai ekhon."}`,
    `${name} — Price: ${price} BDT, Color: ${color}${inStock ? ", In stock." : ", Out of stock."}`
  );
}

/* ===== WEBHOOK POST ===== */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    for (const entry of req.body?.entry || []) {
      for (const event of entry?.messaging || []) {
        if (!event?.message || event.message.is_echo) continue;

        const sender = event.sender?.id;
        const msg = event.message?.text || "";
        const mid = event.message?.mid;

        if (!sender) continue;
        if (!mid) continue;
        if (seen.has(mid)) continue;
        seen.set(mid, Date.now());
        if (isSpam(sender)) continue;
        if (!msg.trim()) continue;

        console.log(`💬 [${sender}]: ${msg}`);

        await sendTyping(sender);

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

/* ===== WEBHOOK VERIFY ===== */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* ===== HEALTH CHECK ===== */
app.get("/", (req, res) => res.send("✅ BizAssist Running"));

/* ===== START ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
