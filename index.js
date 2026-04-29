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
 
// Clean memory every 60s
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 60000) seen.delete(k);
  for (const [k, t] of cooldown) if (now - t > 60000) cooldown.delete(k);
  for (const [k, v] of historyMap) if (now - (v._t || 0) > 7200000) historyMap.delete(k);
}, 60000);
 
function isSpam(id) {
  const now = Date.now();
  const last = cooldown.get(id) || 0;
  if (now - last < 800) return true;
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
    let data = [];
    if (Array.isArray(raw)) data = raw;
    else if (Array.isArray(raw?.products)) data = raw.products;
    else if (Array.isArray(raw?.data)) data = raw.data;
    else if (raw && typeof raw === "object") {
      for (const val of Object.values(raw)) {
        if (Array.isArray(val) && val.length > 0) { data = val; break; }
      }
    }
    if (data.length > 0) cache = { data, time: now };
    console.log("✅ Products loaded:", data.length);
    return data.length > 0 ? data : cache.data;
  } catch (err) {
    console.error("❌ Product fetch:", err.response?.data || err.message);
    return cache.data.length ? cache.data : [];
  }
}
 
/* ===== HISTORY ===== */
/*
  History shape:
  {
    lastProduct: object | null,
    lang: "bn" | "bl" | "en" | null,
    orderStep: null | "awaiting_details" | "awaiting_confirm",
    orderProduct: object | null,
    orderName: string | null,
    orderAddress: string | null,
    orderPhone: string | null,
    _t: timestamp
  }
*/
function getHistory(id) {
  if (!historyMap.has(id)) {
    historyMap.set(id, {
      lastProduct: null,
      lang: null,
      orderStep: null,
      orderProduct: null,
      orderName: null,
      orderAddress: null,
      orderPhone: null,
      _t: Date.now(),
    });
  }
  const h = historyMap.get(id);
  h._t = Date.now();
  return h;
}
 
/* ===== LANGUAGE ===== */
function getLang(msg = "") {
  if (/[\u0980-\u09FF]/.test(msg)) return "bn";
  if (/\b(koto|dam|ache|nai|ki|taka|nibo|rong|lagbe|ase|chai|korbo|boro|valo|name|address|phone)\b/i.test(msg)) return "bl";
  return "en";
}
 
function fmt(lang, bn, bl, en) {
  if (lang === "bn") return bn;
  if (lang === "bl") return bl;
  return en;
}
 
/* ===== FUZZY PRODUCT MATCH ===== */
function findProduct(products, msg = "") {
  if (!Array.isArray(products) || !msg) return null;
  const m = msg.toLowerCase();
 
  // Exact match first
  for (const p of products) {
    if (!p?.product_name) continue;
    if (m.includes(p.product_name.toLowerCase())) return p;
  }
 
  // Fuzzy word match
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
  if (/price|dam|koto|দাম|কত|cost|how much/.test(m)) return "price";
  if (/color|colour|rong|রং/.test(m)) return "color";
  if (/koyta|koyti|quantity|কয়টা/.test(m)) return "quantity";
  if (/stock|ache|available|আছে|ase|in stock/.test(m)) return "stock";
  if (/order|buy|nibo|নেব|korbo|kinte|lagbe|purchase|want to buy|i want/.test(m)) return "order";
  return "general";
}
 
/* ===== BUILD PRODUCT REPLY ===== */
function buildReply(lang, p, intent) {
  if (!p || !p.product_name) return fmt(lang, "Product তথ্য পাওয়া যায়নি।", "Product info nai.", "Product info not available.");
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
    ? fmt(lang, `${name} এখন ${qty}টা আছে।`, `${name} ekhon ${qty}ta ache.`, `${name} has ${qty} in stock.`)
    : fmt(lang,
        inStock ? `${name} আছে। পরিমাণ জানতে seller কে জিজ্ঞেস করুন।` : `${name} নেই।`,
        inStock ? `${name} ache. Porimaan jante seller ke jiggesh korun.` : `${name} nai.`,
        inStock ? `${name} is in stock. Ask seller for quantity.` : `${name} is out of stock.`
      );
  if (intent === "stock") return fmt(lang,
    inStock ? `${name} এখন available আছে।` : `${name} এখন stock এ নেই।`,
    inStock ? `${name} ache.` : `${name} nai ekhon.`,
    inStock ? `${name} is in stock.` : `${name} is out of stock.`
  );
  // General info
  return fmt(lang,
    `${name}\nদাম: ${price} টাকা\nরং: ${color}\nStatus: ${inStock ? "Available ✅" : "Out of stock ❌"}`,
    `${name}\nDam: ${price} taka\nColor: ${color}\nStatus: ${inStock ? "Available ✅" : "Out of stock ❌"}`,
    `${name}\nPrice: ${price} BDT\nColor: ${color}\nStatus: ${inStock ? "Available ✅" : "Out of stock ❌"}`
  );
}
 
/* ===== PRODUCT LIST ===== */
function productListText(products, lang) {
  if (!products.length) return fmt(lang, "কোনো product নেই।", "Kono product nai.", "No products available.");
  const list = products.map(p => `• ${p.product_name} — ${p.price_bdt || "N/A"} BDT`).join("\n");
  return fmt(lang,
    `আমাদের products:\n${list}`,
    `Amader products:\n${list}`,
    `Our products:\n${list}`
  );
}
 
/* ===== ORDER ALERT (sends to Lovable dashboard) ===== */
async function sendOrderAlert(senderId, product, name, address, phone, originalMsg) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: senderId,
      customer_fb_name: name,
      product_name: product?.product_name || "Unknown",
      message: `Order Request\nName: ${name}\nAddress: ${address}\nPhone: ${phone}\nMessage: ${originalMsg}`,
    }, { timeout: 5000 });
    console.log("✅ Order alert sent:", product?.product_name, "←", name);
  } catch (err) {
    console.error("❌ Alert error:", err.response?.data || err.message);
  }
}
 
/* ===== SEND MESSAGE (with retry) ===== */
async function sendMsg(sender, text, retry = 2) {
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
      await new Promise(r => setTimeout(r, 1000));
      return sendMsg(sender, text, retry - 1);
    }
  }
}
 
/* ===== TYPING INDICATOR ===== */
function sendTyping(sender) {
  axios.post(
    "https://graph.facebook.com/v18.0/me/messages",
    { recipient: { id: sender }, sender_action: "typing_on" },
    { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 3000 }
  ).catch(() => {});
}
 
/* ===== IMAGE ANALYSIS ===== */
async function analyzeImage(url, products) {
  try {
    const img = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    const base64 = Buffer.from(img.data).toString("base64");
    const contentType = img.headers["content-type"] || "image/jpeg";
    const list = products.map(p =>
      `- ${p.product_name} | ${p.price_bdt || "N/A"} BDT | color: ${p.color || "N/A"}`
    ).join("\n");
 
    const res = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
          {
            type: "text",
            text: `You are a shop assistant. Our products:\n${list}\n\nLook at the image carefully. Does it match any product in the list? If YES → reply with: product name, price, color in 1-2 sentences. If NO match → reply exactly: NOT_IN_SHOP`
          }
        ]
      }]
    });
 
    const result = res.choices[0].message.content.trim();
    console.log("🖼️ Image AI result:", result);
    return result;
  } catch (err) {
    console.error("❌ Image error:", err.message);
    return null;
  }
}
 
/* ===== GREETING CHECK ===== */
function isGreeting(msg = "") {
  return /^(hi|hello|hey|hii|hy|salam|salaam|assalam|হ্যালো|শুভ|good morning|good evening|start|shuru)$/i.test(msg.trim());
}
 
/* ===== PARSE COLLECTED ORDER DETAILS ===== */
/*
  Customer sends details in one message like:
  "John, Dhaka Mirpur 10, 01700000000"
  We try to parse name, address, phone from it.
*/
function parseOrderDetails(msg = "") {
  // Phone number: 11-digit Bangladeshi number or any number sequence
  const phoneMatch = msg.match(/\b(\+?880|0)?\d{10,11}\b/);
  const phone = phoneMatch ? phoneMatch[0] : null;
 
  // Remove phone from string, then split by comma
  const withoutPhone = msg.replace(phoneMatch ? phoneMatch[0] : "", "").trim();
  const parts = withoutPhone.split(/[,،\n]+/).map(s => s.trim()).filter(Boolean);
 
  const name = parts[0] || null;
  const address = parts.slice(1).join(", ") || null;
 
  return { name, address, phone };
}
 
/* ===== MAIN MESSAGE HANDLER ===== */
async function handleMessage(sender, msg, products, h) {
  const safeMsg = (msg || "").trim();
  if (!safeMsg) return null;
 
  // Set language only on first message, don't overwrite
  const detectedLang = getLang(safeMsg);
  if (!h.lang) h.lang = detectedLang;
  const lang = h.lang;
 
  /* ============ ORDER FLOW ============ */
 
  // Step 1: Waiting for customer name/address/phone
  if (h.orderStep === "awaiting_details") {
    const { name, address, phone } = parseOrderDetails(safeMsg);
 
    if (!name || !address || !phone) {
      // Could not parse — ask again
      return fmt(lang,
        `আপনার তথ্য সঠিকভাবে পাইনি। এভাবে লিখুন:\n\nনাম, ঠিকানা, ফোন নম্বর\n\nউদাহরণ: Rahim, Dhaka Mirpur 10, 01712345678`,
        `Apnar info thik moto pailam na. Eivabe likhen:\n\nNaam, Address, Phone\n\nUdaharon: Rahim, Dhaka Mirpur 10, 01712345678`,
        `Couldn't parse your details. Please write like:\n\nName, Address, Phone\n\nExample: Rahim, Dhaka Mirpur 10, 01712345678`
      );
    }
 
    // Got all details — save and ask to confirm
    h.orderName = name;
    h.orderAddress = address;
    h.orderPhone = phone;
    h.orderStep = "awaiting_confirm";
 
    return fmt(lang,
      `✅ আপনার order details:\n\nProduct: ${h.orderProduct.product_name}\nনাম: ${name}\nঠিকানা: ${address}\nফোন: ${phone}\n\nConfirm করতে "yes" লিখুন, বাতিল করতে "no" লিখুন।`,
      `✅ Apnar order details:\n\nProduct: ${h.orderProduct.product_name}\nNaam: ${name}\nAddress: ${address}\nPhone: ${phone}\n\nConfirm korte "yes" likhen, cancel korte "no" likhen.`,
      `✅ Your order details:\n\nProduct: ${h.orderProduct.product_name}\nName: ${name}\nAddress: ${address}\nPhone: ${phone}\n\nType "yes" to confirm, "no" to cancel.`
    );
  }
 
  // Step 2: Waiting for yes/no confirmation
  if (h.orderStep === "awaiting_confirm") {
    const m = safeMsg.toLowerCase().trim();
    const isYes = /^(yes|haa|ha|ok|okay|ji|sure|confirm|haan|han|yep)$/.test(m);
    const isNo = /^(no|na|না|nah|nope|nai|cancel|bata|naa)$/.test(m);
 
    if (isYes) {
      const product = h.orderProduct;
      const name = h.orderName;
      const address = h.orderAddress;
      const phone = h.orderPhone;
 
      // Reset order state
      h.orderStep = null;
      h.orderProduct = null;
      h.orderName = null;
      h.orderAddress = null;
      h.orderPhone = null;
 
      await sendOrderAlert(sender, product, name, address, phone, safeMsg);
 
      return fmt(lang,
        `🛒 আপনার order confirm হয়েছে!\n\nProduct: ${product.product_name}\nSeller শীঘ্রই আপনার সাথে যোগাযোগ করবেন।`,
        `🛒 Apnar order confirm hoyeche!\n\nProduct: ${product.product_name}\nSeller shigghri contact korben.`,
        `🛒 Your order is confirmed!\n\nProduct: ${product.product_name}\nThe seller will contact you shortly.`
      );
    }
 
    if (isNo) {
      h.orderStep = null;
      h.orderProduct = null;
      h.orderName = null;
      h.orderAddress = null;
      h.orderPhone = null;
      return fmt(lang,
        "❌ Order বাতিল হয়েছে। আর কিছু জানতে চাইলে বলুন।",
        "❌ Order cancel hoyeche. Aro kono info lagbe?",
        "❌ Order cancelled. Let me know if you need anything else."
      );
    }
 
    // Unrecognized — remind
    return fmt(lang,
      `"yes" লিখুন confirm করতে, অথবা "no" লিখুন বাতিল করতে।`,
      `"yes" likhen confirm korte, "no" likhen cancel korte.`,
      `Type "yes" to confirm or "no" to cancel.`
    );
  }
 
  /* ============ GREETING ============ */
  if (isGreeting(safeMsg)) {
    const list = productListText(products, lang);
    return fmt(lang,
      `👋 আস্সালামু আলাইকুম! আমি BizAssist, আপনার shop assistant।\n\n${list}\n\nকোনটার কথা জানতে চান?`,
      `👋 Hi! Ami BizAssist, apnar shop assistant.\n\n${list}\n\nKontar kotha jante chan?`,
      `👋 Hi! I'm BizAssist, your shop assistant.\n\n${list}\n\nWhich product would you like to know about?`
    );
  }
 
  /* ============ PRODUCT MATCH ============ */
  let product = findProduct(products, safeMsg);
 
  // Context fallback — only for explicit context words
  const isCtxWord = /\b(this|it|eta|eita|ota|eti|same|ata)\b/i.test(safeMsg);
  if (!product && isCtxWord && h.lastProduct) {
    product = h.lastProduct;
  }
 
  const intent = getIntent(safeMsg);
 
  // If no product found AND intent is not general — try lastProduct
  // (e.g. "price koto?" after talking about bracelet)
  if (!product && h.lastProduct && intent !== "general") {
    product = h.lastProduct;
  }
 
  /* ============ NO PRODUCT FOUND ============ */
  if (!product) {
    if (intent === "order") {
      return fmt(lang,
        "কোন product order করতে চান সেটা বলুন।",
        "Kon product order korte chan?",
        "Which product would you like to order?"
      );
    }
    const list = productListText(products, lang);
    return fmt(lang,
      `❌ এই product পাওয়া যায়নি।\n\n${list}\n\nআবার try করুন।`,
      `❌ Ei product paoa jai nai.\n\n${list}\n\nAbar try korun.`,
      `❌ Product not found.\n\n${list}\n\nPlease try again.`
    );
  }
 
  // Save last product
  h.lastProduct = product;
 
  /* ============ ORDER INTENT ============ */
  if (intent === "order") {
    h.orderStep = "awaiting_details";
    h.orderProduct = product;
    return fmt(lang,
      `🛒 "${product.product_name}" order করতে চান! \n\nঅনুগ্রহ করে আপনার তথ্য দিন:\nনাম, ঠিকানা, ফোন নম্বর\n\nউদাহরণ: Rahim, Dhaka Mirpur 10, 01712345678`,
      `🛒 "${product.product_name}" order korte chaichen!\n\nApnar info din:\nNaam, Address, Phone\n\nUdaharon: Rahim, Dhaka Mirpur 10, 01712345678`,
      `🛒 You want to order "${product.product_name}"!\n\nPlease provide your details:\nName, Address, Phone\n\nExample: Rahim, Dhaka Mirpur 10, 01712345678`
    );
  }
 
  /* ============ GENERAL / FEATURE QUESTION ============ */
  // If customer asks about features, description — use AI with product context
  if (intent === "general") {
    // Check if it sounds like a feature/detail question
    const isFeatureQ = /feature|detail|describe|what is|kemon|kirokom|ki ache|spec|quality|material|made of|er ki|eta ki/.test(safeMsg.toLowerCase());
    if (isFeatureQ) {
      try {
        const res = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          max_tokens: 120,
          temperature: 0.3,
          messages: [
            {
              role: "system",
              content: `You are BizAssist, a shop assistant. Answer ONLY about this product: 
Name: ${product.product_name}
Price: ${product.price_bdt || "N/A"} BDT
Color: ${product.color || "N/A"}
Stock: ${product.stock_availability || "unknown"}
Description: ${product.description || "No description available"}
 
Rules:
- Keep reply under 3 sentences
- Only use the info given above, do NOT make up features
- If no description is given, say you don't have detailed specs but mention name, price, color
- Match language: Bengali script → Bengali, Banglish → Banglish, English → English`
            },
            { role: "user", content: safeMsg }
          ]
        });
        return res.choices[0].message.content.trim();
      } catch {
        // Fallback to basic info
        return buildReply(lang, product, "general");
      }
    }
  }
 
  /* ============ STANDARD REPLY ============ */
  return buildReply(lang, product, intent);
}
 
/* ===== WEBHOOK VERIFY ===== */
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
 
        console.log(`💬 [${sender}]: ${msg || "[image]"}`);
        sendTyping(sender);
 
        const products = await getProducts();
        const h = getHistory(sender);
        let reply = "";
 
        /* IMAGE */
        if (attachments?.[0]?.type === "image") {
          console.log("🖼️ Image received from:", sender);
          const result = await analyzeImage(attachments[0].payload.url, products);
          if (!result || result.includes("NOT_IN_SHOP")) {
            reply = fmt(h.lang || "en",
              `এই product আমাদের shop এ নেই।\n\n${productListText(products, "bn")}`,
              `Ei product amader shop e nai.\n\n${productListText(products, "bl")}`,
              `This product is not in our shop.\n\n${productListText(products, "en")}`
            );
          } else {
            reply = result;
          }
        }
 
        /* TEXT */
        else if (msg.trim()) {
          reply = await handleMessage(sender, msg, products, h);
          if (!reply) continue;
        } else continue;
 
        await sendMsg(sender, reply);
      }
    }
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }
});
 
/* ===== HEALTH CHECK ===== */
app.get("/", (req, res) => res.send("✅ BizAssist Running"));
 
/* ===== START ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BizAssist running on port ${PORT}`));
