const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

/* ===== CONFIG ===== */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "bizassist123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";
const BASE = "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${BASE}/api/public/get-products`;
const ALERT_URL = `${BASE}/api/public/order-alert`;

if (!PAGE_ACCESS_TOKEN) console.error("❌ PAGE_ACCESS_TOKEN missing!");
if (!WEBHOOK_API_KEY) console.error("❌ WEBHOOK_API_KEY missing!");

/* ===== MEMORY ===== */
const seen = new Map();
const historyMap = new Map();
const cooldown = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 60000) seen.delete(k);
  for (const [k, t] of cooldown) if (now - t > 60000) cooldown.delete(k);
  for (const [k, v] of historyMap) if (now - (v._t || 0) > 3600000) historyMap.delete(k);
}, 60000);

function isSpam(id) {
  const now = Date.now();
  const last = cooldown.get(id) || 0;
  if (now - last < 1500) return true;
  cooldown.set(id, now);
  return false;
}

/* ===== PRODUCT CACHE ===== */
let cache = { data: [], time: 0 };

async function getProducts() {
  const now = Date.now();
  if (cache.data.length && now - cache.time < 20000) return cache.data;

  try {
    const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`, {
      headers: { "x-api-key": WEBHOOK_API_KEY },
      timeout: 8000,
    });

    const raw = res.data;

    // সব possible format handle করা
    let data = [];
    if (Array.isArray(raw)) data = raw;
    else if (Array.isArray(raw?.products)) data = raw.products;
    else if (Array.isArray(raw?.data)) data = raw.data;
    else if (raw && typeof raw === "object") {
      // last resort — object এর ভেতরে array খোঁজো
      for (const val of Object.values(raw)) {
        if (Array.isArray(val) && val.length > 0) { data = val; break; }
      }
    }

    console.log("✅ Products loaded:", data.length);
    if (data.length > 0) cache = { data, time: now };
    return data;

  } catch (err) {
    console.error("❌ Product fetch:", err.message);
    return cache.data; // পুরানো cache return করো
  }
}

/* ===== HISTORY ===== */
function getHistory(id) {
  if (!historyMap.has(id)) {
    historyMap.set(id, { lastProduct: null, lang: "bl", _t: Date.now() });
  }
  const h = historyMap.get(id);
  h._t = Date.now();
  return h;
}

/* ===== LANGUAGE ===== */
function getLang(msg = "") {
  if (/[\u0980-\u09FF]/.test(msg)) return "bn";
  if (/\b(koto|dam|ache|nai|ki|taka|nibo|rong|lagbe|ase|chai|korbo|boro|valo)\b/i.test(msg)) return "bl";
  return "en";
}

function fmt(lang, bn, bl, en) {
  if (lang === "bn") return bn;
  if (lang === "bl") return bl;
  return en;
}

/* ===== FUZZY MATCH ===== */
function findProduct(products, msg = "") {
  if (!Array.isArray(products) || !msg) return null;
  const m = msg.toLowerCase();

  // exact match আগে
  for (const p of products) {
    if (!p?.product_name) continue;
    if (m.includes(p.product_name.toLowerCase())) return p;
  }

  // fuzzy
  let best = null, bestScore = 0;
  for (const p of products) {
    if (!p?.product_name) continue;
    const words = p.product_name.toLowerCase().split(" ").filter(Boolean);
    const matched = words.filter(w => w.length > 2 && m.includes(w)).length;
    const score = words.length ? matched / words.length : 0;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 0.4 ? best : null;
}

/* ===== INTENT ===== */
function getIntent(msg = "") {
  const m = msg.toLowerCase();
  if (/price|dam|koto|দাম|কত/.test(m)) return "price";
  if (/color|colour|rong|রং/.test(m)) return "color";
  if (/koyta|koyti|quantity|কয়টা/.test(m)) return "quantity";
  if (/stock|ache|available|আছে|ase/.test(m)) return "stock";
  if (/order|buy|nibo|নেব|korbo|kinte|lagbe/.test(m)) return "order";
  return "general";
}

/* ===== BUILD REPLY ===== */
function buildReply(lang, p, intent) {
  const name = p.product_name;
  const price = p.price_bdt || "N/A";
  const color = p.color || "N/A";
  const inStock = p.stock_availability === "in_stock";
  const qty = p.stock_count || p.quantity || null;

  if (intent === "price") return fmt(lang,
    `${name} এর দাম ${price} টাকা।`,
    `${name} er dam ${price} taka.`,
    `${name} price is ${price} BDT.`
  );
  if (intent === "color") return fmt(lang,
    `${name} এর রং: ${color}`,
    `${name} er color: ${color}`,
    `${name} colors: ${color}`
  );
  if (intent === "quantity") return qty
    ? fmt(lang,
        `${name} এখন ${qty}টা আছে।`,
        `${name} ekhon ${qty}ta ache.`,
        `${name} has ${qty} in stock.`
      )
    : fmt(lang,
        inStock ? `${name} আছে। পরিমাণ জানতে seller কে জিজ্ঞেস করুন।` : `${name} নেই।`,
        inStock ? `${name} ache. Porimaan jante seller ke jiggesh korun.` : `${name} nai.`,
        inStock ? `${name} in stock. Ask seller for quantity.` : `${name} out of stock.`
      );
  if (intent === "stock") return fmt(lang,
    inStock ? `${name} এখন available।` : `${name} এখন নেই।`,
    inStock ? `${name} ache.` : `${name} nai.`,
    inStock ? `${name} is in stock.` : `${name} is out of stock.`
  );
  return fmt(lang,
    `${name} — দাম ${price} টাকা, রং: ${color}${inStock ? ", আছে।" : ", নেই।"}`,
    `${name} — dam ${price} taka, color: ${color}${inStock ? ", ache." : ", nai."}`,
    `${name} — ${price} BDT, ${color}${inStock ? ", in stock." : ", out of stock."}`
  );
}

/* ===== PRODUCT LIST ===== */
function productList(products, lang) {
  if (!products.length) return fmt(lang,
    "কোনো product নেই।",
    "Kono product nai.",
    "No products available."
  );
  const list = products.map(p => `• ${p.product_name}`).join("\n");
  return fmt(lang,
    `আমাদের products:\n${list}\n\nকোনটার কথা জানতে চান?`,
    `Amader products:\n${list}\n\nKontar kotha jante chan?`,
    `Our products:\n${list}\n\nWhich one would you like to know about?`
  );
}

/* ===== FB NAME ===== */
async function getFBName(id) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/${id}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`,
      { timeout: 5000 }
    );
    return res.data?.name || "Customer";
  } catch { return "Customer"; }
}

/* ===== ORDER ALERT ===== */
async function sendAlert(senderId, product, msg) {
  try {
    const fbName = await getFBName(senderId);
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,        // ✅ fix: secret add করা হয়েছে
      seller_id: SELLER_ID,
      customer_fb_id: senderId,
      customer_fb_name: fbName,
      product_name: product?.product_name || "Unknown",
      message: msg,
    }, { timeout: 5000 });
    console.log("✅ Alert sent:", fbName, "→", product?.product_name);
  } catch (err) {
    console.error("❌ Alert error:", err.message);
  }
}

/* ===== SEND MSG (RETRY) ===== */
async function sendMsg(sender, text, retry = 2) {
  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      { recipient: { id: sender }, message: { text } },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 8000 }
    );
    console.log("✅ Sent");
  } catch (err) {
    console.error("Send error:", err.response?.data || err.message);
    if (retry > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return sendMsg(sender, text, retry - 1);
    }
  }
}

/* ===== TYPING ===== */
function sendTyping(sender) {
  axios.post(
    "https://graph.facebook.com/v18.0/me/messages",
    { recipient: { id: sender }, sender_action: "typing_on" },
    { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 3000 }
  ).catch(() => {});
}

/* ===== IMAGE ===== */
async function analyzeImage(url, products) {
  try {
    const img = await axios.get(url, { responseType: "arraybuffer", timeout: 10000 });
    const base64 = Buffer.from(img.data).toString("base64");
    const list = products.map(p => `- ${p.product_name} | ${p.price_bdt} BDT | ${p.color}`).join("\n");

    const res = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 150,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: "text", text: `Shop products:\n${list}\n\nDoes image match any product? If yes → name + price in 1 sentence. If no → say: NOT_IN_SHOP` }
        ]
      }]
    });
    return res.choices[0].message.content.trim();
  } catch (err) {
    console.error("Image error:", err.message);
    return null;
  }
}

/* ===== GREETING ===== */
function isGreeting(msg = "") {
  return /^(hi|hello|hey|hii|hy|salam|salaam|assalam|কেমন|হ্যালো|হ্যালো)$/i.test(msg.trim());
}

/* ===== MAIN LOGIC ===== */
async function process(sender, msg, products, h) {
  const safeMsg = (msg || "").trim();
  if (!safeMsg) return null;

  const lang = getLang(safeMsg);
  h.lang = lang;

  /* GREETING */
  if (isGreeting(safeMsg)) {
    return fmt(lang,
      "👋 আস্সালামু আলাইকুম! আমি BizAssist। আপনি কোন product সম্পর্কে জানতে চান?",
      "👋 Hi! Ami BizAssist. Apni kon product er khobor jante chan?",
      "👋 Hi! I'm BizAssist. Which product would you like to know about?"
    );
  }

  /* PRODUCT MATCH */
  let product = findProduct(products, safeMsg);

  // context words
  if (!product && /^(this|eta|ota|eita|ta|eti|same)$/i.test(safeMsg.trim())) {
    product = h.lastProduct;
  }

  const intent = getIntent(safeMsg);

  /* NO PRODUCT */
  if (!product) {
    if (intent === "order") {
      return fmt(lang,
        "কোন product order করতে চান সেটা বলুন।",
        "Kon product order korte chan?",
        "Which product would you like to order?"
      );
    }
    return productList(products, lang);
  }

  h.lastProduct = product;

  /* ORDER → সরাসরি alert, seller confirm করবে */
  if (intent === "order") {
    await sendAlert(sender, product, safeMsg);
    return fmt(lang,
      `🛒 আপনার "${product.product_name}" এর order request seller কে পাঠানো হয়েছে। তিনি শীঘ্রই যোগাযোগ করবেন।`,
      `🛒 "${product.product_name}" order request seller ke pathano hoyeche. Tini contact korben.`,
      `🛒 Your order for "${product.product_name}" has been sent to the seller. They will contact you shortly.`
    );
  }

  return buildReply(lang, product, intent);
}

/* ===== WEBHOOK GET ===== */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* ===== WEBHOOK POST ===== */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    for (const entry of req.body?.entry || []) {
      for (const event of entry?.messaging || []) {
        if (!event?.message || event.message.is_echo) continue;

        const sender = event.sender?.id;
        const msg = event.message?.text || "";
        const attachments = event.message?.attachments;
        const mid = event.message?.mid;

        if (!sender || !mid) continue;
        if (seen.has(mid)) continue;
        seen.set(mid, Date.now());
        if (isSpam(sender)) continue;

        console.log(`💬 [${sender}]: ${msg || "image"}`);
        sendTyping(sender);

        const products = await getProducts();
        const h = getHistory(sender);
        let reply = "";

        /* IMAGE */
        if (attachments?.[0]?.type === "image") {
          const result = await analyzeImage(attachments[0].payload.url, products);
          reply = (!result || result.includes("NOT_IN_SHOP"))
            ? fmt(h.lang || "bl",
                `এই product আমাদের shop এ নেই।\n\n${productList(products, "bn")}`,
                `Ei product amader shop e nai.\n\n${productList(products, "bl")}`,
                `Not in our shop.\n\n${productList(products, "en")}`
              )
            : result;
        }

        /* TEXT */
        else if (msg.trim()) {
          reply = await process(sender, msg, products, h);
          if (!reply) continue;
        } else continue;

        await sendMsg(sender, reply);
      }
    }
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }
});

/* ===== HEALTH ===== */
app.get("/", (req, res) => res.send("✅ BizAssist Running"));

/* ===== START ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
