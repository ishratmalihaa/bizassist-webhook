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
function getHistory(id) {
  if (!historyMap.has(id)) {
    historyMap.set(id, {
      lastProduct: null,
      lang: null,
      orderStep: null,        // null, "awaiting_details", "awaiting_confirm"
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

  for (const p of products) {
    if (!p?.product_name) continue;
    if (m.includes(p.product_name.toLowerCase())) return p;
  }

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

/* ===== DETECT PRODUCT QUERY (to exit order mode) ===== */
function isProductQuery(msg = "") {
  const m = msg.toLowerCase();
  // If message contains product name from database match? We'll check later.
  // Also common patterns: "ache", "ase", "do you have", "price koto", "dam", "color"
  const productQuestion = /\b(ache|ase|do you have|have you|price|dam|koto|color|rong|stock|available)\b/i;
  return productQuestion.test(m) && m.split(/\s+/).length <= 8;
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
    `${name} er price ${price} taka.`,
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
    `${name}\nPrice: ${price} taka\nColor: ${color}\nStatus: ${inStock ? "Available ✅" : "Out of stock ❌"}`,
    `${name}\nPrice: ${price} BDT\nColor: ${color}\nStatus: ${inStock ? "Available ✅" : "Out of stock ❌"}`
  );
}

/* ===== ORDER ALERT ===== */
async function sendOrderAlert(senderId, product, name, address, phone, originalMsg) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: senderId,
      customer_fb_name: name,
      product_name: product?.product_name || "Unknown",
      message: `🧾 Order Request (pending confirmation)\nName: ${name}\nAddress: ${address}\nPhone: ${phone}\nProduct: ${product?.product_name}\nMessage: ${originalMsg}`,
    }, { timeout: 5000 });
    console.log("✅ Order alert sent:", product?.product_name, "←", name);
  } catch (err) {
    console.error("❌ Alert error:", err.response?.data || err.message);
  }
}

/* ===== PARSE ORDER DETAILS (robust, no commas required) ===== */
function parseOrderDetails(msg = "") {
  // Extract phone number (Bangladeshi 11-digit or any 10-14 digits)
  let phone = null;
  const phoneMatch = msg.match(/\b(\+?880|0)?\d{10,11}\b/);
  if (phoneMatch) phone = phoneMatch[0];

  // Remove phone number from the string
  let remaining = phone ? msg.replace(phoneMatch[0], "") : msg;
  // Also remove common punctuation
  remaining = remaining.replace(/[,،\n]+/g, " ").trim();

  let name = null, address = null;
  const words = remaining.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) {
    return { name: null, address: null, phone };
  }
  // First word = name, rest = address
  name = words[0];
  if (words.length > 1) address = words.slice(1).join(" ");
  else address = null;

  // If address still missing but remaining has commas, try alternative split
  if (!address && remaining.includes(",")) {
    const parts = remaining.split(",").map(s => s.trim());
    name = parts[0] || name;
    address = parts.slice(1).join(", ") || null;
  }

  return { name, address, phone };
}

/* ===== GREETING CHECK ===== */
function isGreeting(msg = "") {
  const m = msg.trim().toLowerCase();
  return /^(hi|hello|hey|hii|hy|salam|salaam|assalamualaikum|assalam|হ্যালো|হাই|শুভ|good morning|good evening|start|shuru|hi there|hey there)$/i.test(m);
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

/* ===== AI FEATURE REPLY ===== */
async function getFeatureReply(product, userMsg, lang) {
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
        { role: "user", content: userMsg }
      ]
    });
    return res.choices[0].message.content.trim();
  } catch (err) {
    console.error("AI feature error:", err.message);
    return buildReply(lang, product, "general");
  }
}

/* ===== MESSAGE HANDLER ===== */
async function handleMessage(sender, msg, products, h) {
  const safeMsg = (msg || "").trim();
  if (!safeMsg) return null;

  // Set language once
  if (!h.lang) h.lang = getLang(safeMsg);
  const lang = h.lang;

  // ========== ORDER FLOW ==========
  if (h.orderStep === "awaiting_details") {
    // If user asks about a product (e.g., "gold braclte ache"), exit order mode and answer that product instead.
    const anyProduct = findProduct(products, safeMsg);
    if (anyProduct) {
      // Cancel order and treat as normal product query
      h.orderStep = null;
      h.orderProduct = null;
      // Fall through to normal product handling below
    } else {
      // Try to parse details
      const { name, address, phone } = parseOrderDetails(safeMsg);
      if (!name || !address || !phone) {
        return fmt(lang,
          `আপনার তথ্য পুরোপুরি পাইনি। দয়া করে লিখুন:\n\nনাম, ঠিকানা, মোবাইল নাম্বার\nউদাহরণ: Rahim, Dhaka Mirpur 10, 01712345678`,
          `Apnar info purono pailam na. Eivabe likhen:\n\nNaam, Address, Phone\nUdaharon: Rahim, Dhaka Mirpur 10, 01712345678`,
          `Couldn't get all your details. Please write:\n\nName, Address, Phone\nExample: Rahim, Dhaka Mirpur 10, 01712345678`
        );
      }
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
  }

  if (h.orderStep === "awaiting_confirm") {
    const m = safeMsg.toLowerCase().trim();
    const isYes = /^(yes|haa|ha|ok|okay|ji|sure|confirm|haan|han|yep)$/i.test(m);
    const isNo = /^(no|na|না|nah|nope|nai|cancel|bata|naa)$/i.test(m);
    if (isYes) {
      const product = h.orderProduct;
      const name = h.orderName;
      const address = h.orderAddress;
      const phone = h.orderPhone;
      await sendOrderAlert(sender, product, name, address, phone, safeMsg);
      // Reset order state
      h.orderStep = null;
      h.orderProduct = null;
      h.orderName = null;
      h.orderAddress = null;
      h.orderPhone = null;
      return fmt(lang,
        `🛒 আপনার order confirm হয়েছে!\n\nProduct: ${product.product_name}\nSeller শীঘ্রই আপনার সাথে যোগাযোগ করবেন।`,
        `🛒 Apnar order confirm hoyeche!\n\nProduct: ${product.product_name}\nSeller shighroi contact korben.`,
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
        "❌ Order cancel hoyeche. Aro kichu jante chaile bolun.",
        "❌ Order cancelled. Let me know if you need anything else."
      );
    }
    return fmt(lang,
      `"yes" লিখুন confirm করতে, "no" লিখুন বাতিল করতে।`,
      `"yes" likhen confirm korte, "no" likhen cancel korte.`,
      `Type "yes" to confirm or "no" to cancel.`
    );
  }

  // ========== GREETING ==========
  if (isGreeting(safeMsg)) {
    const list = productListText(products, lang);
    return fmt(lang,
      `👋 আস্সালামু আলাইকুম! আমি BizAssist, আপনার shop assistant।\n\n${list}\n\nকোনটার কথা জানতে চান?`,
      `👋 Hi! Ami BizAssist, apnar shop assistant.\n\n${list}\n\nKontar kotha jante chan?`,
      `👋 Hi! I'm BizAssist, your shop assistant.\n\n${list}\n\nWhich product would you like to know about?`
    );
  }

  // ========== PRODUCT MATCH ==========
  let product = findProduct(products, safeMsg);

  // Context fallback for "this", "eta", "same" etc.
  const isCtxWord = /\b(this|it|eta|eita|ota|eti|same|ata)\b/i.test(safeMsg);
  if (!product && isCtxWord && h.lastProduct) product = h.lastProduct;
  // Also if no product but lastProduct exists and intent is not general (e.g., "price koto?")
  const intent = getIntent(safeMsg);
  if (!product && h.lastProduct && intent !== "general") product = h.lastProduct;

  if (!product) {
    // No product found – show list
    const list = productListText(products, lang);
    if (intent === "order") {
      return fmt(lang,
        "কোন প্রোডাক্ট অর্ডার করতে চান? প্রোডাক্টের নাম বলুন।",
        "Kon product order korte chan? Naam bolun.",
        "Which product would you like to order? Please tell me the product name."
      );
    }
    return fmt(lang,
      `❌ এই প্রোডাক্ট পাওয়া যায়নি।\n\n${list}\n\nআবার চেষ্টা করুন।`,
      `❌ Ei product paoa jai nai.\n\n${list}\n\nAbar try korun.`,
      `❌ Product not found.\n\n${list}\n\nPlease try again.`
    );
  }

  // Save last product
  h.lastProduct = product;

  // ========== ORDER INTENT ==========
  if (intent === "order") {
    h.orderStep = "awaiting_details";
    h.orderProduct = product;
    return fmt(lang,
      `🛒 "${product.product_name}" অর্ডার করতে চান!\n\nআপনার তথ্য দিন:\nনাম, ঠিকানা, মোবাইল নাম্বার\nউদাহরণ: Rahim, Dhaka Mirpur 10, 01712345678`,
      `🛒 "${product.product_name}" order korte chaichen!\n\nApnar info din:\nNaam, Address, Phone\nUdaharon: Rahim, Dhaka Mirpur 10, 01712345678`,
      `🛒 You want to order "${product.product_name}"!\n\nPlease provide:\nName, Address, Phone\nExample: Rahim, Dhaka Mirpur 10, 01712345678`
    );
  }

  // ========== FEATURE / GENERAL QUESTIONS ==========
  if (intent === "general") {
    const isFeatureQ = /feature|detail|describe|what is|kemon|kirokom|ki ache|spec|quality|material|made of|er ki|eta ki/.test(safeMsg.toLowerCase());
    if (isFeatureQ) {
      const aiReply = await getFeatureReply(product, safeMsg, lang);
      return aiReply;
    }
  }

  // ========== STANDARD REPLY (price, color, stock, etc.) ==========
  return buildReply(lang, product, intent);
}

/* ===== WEBHOOK ===== */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

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

        if (attachments?.[0]?.type === "image") {
          console.log("🖼️ Image received");
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
        } else if (msg.trim()) {
          reply = await handleMessage(sender, msg, products, h);
        } else continue;

        if (reply) await sendMsg(sender, reply);
      }
    }
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }
});

/* ===== SEND MESSAGE ===== */
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

function sendTyping(sender) {
  axios.post(
    "https://graph.facebook.com/v18.0/me/messages",
    { recipient: { id: sender }, sender_action: "typing_on" },
    { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 3000 }
  ).catch(() => {});
}

/* ===== HEALTH ===== */
app.get("/", (req, res) => res.send("✅ BizAssist Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BizAssist running on port ${PORT}`));
