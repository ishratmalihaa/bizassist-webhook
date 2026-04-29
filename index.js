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

/* ===== MEMORY & CLEANUP ===== */
const processedMessages = new Map();    // mid -> timestamp
const userCooldown = new Map();         // senderId -> timestamp
const userSessions = new Map();         // senderId -> session object

const MESSAGE_TTL = 60000;
const COOLDOWN_MS = 800;

setInterval(() => {
  const now = Date.now();
  for (const [id, time] of processedMessages) if (now - time > MESSAGE_TTL) processedMessages.delete(id);
  for (const [id, time] of userCooldown) if (now - time > MESSAGE_TTL) userCooldown.delete(id);
  for (const [id, session] of userSessions) if (now - (session.lastActive || 0) > 3600000) userSessions.delete(id);
}, 30000);

function isSpam(senderId) {
  const now = Date.now();
  const last = userCooldown.get(senderId) || 0;
  if (now - last < COOLDOWN_MS) return true;
  userCooldown.set(senderId, now);
  return false;
}

/* ===== SESSION MANAGER ===== */
function getSession(senderId) {
  if (!userSessions.has(senderId)) {
    userSessions.set(senderId, {
      lastProduct: null,          // last product object
      lang: null,                 // "bn", "bl", "en"
      orderStep: null,            // null, "awaiting_details", "awaiting_confirm"
      orderProduct: null,
      orderName: null,
      orderAddress: null,
      orderPhone: null,
      lastActive: Date.now(),
    });
  }
  const sess = userSessions.get(senderId);
  sess.lastActive = Date.now();
  return sess;
}

/* ===== LANGUAGE DETECTION ===== */
function detectLanguage(msg = "") {
  if (/[\u0980-\u09FF]/.test(msg)) return "bn";
  if (/\b(koto|dam|ache|nai|ki|taka|nibo|rong|lagbe|ase|chai|korbo|name|address|phone)\b/i.test(msg)) return "bl";
  return "en";
}

function fmt(lang, bn, bl, en) {
  if (lang === "bn") return bn;
  if (lang === "bl") return bl;
  return en;
}

/* ===== PRODUCT CACHE ===== */
let productCache = { data: [], time: 0 };
let fetchingProducts = null;

async function fetchProducts() {
  if (fetchingProducts) return fetchingProducts;
  fetchingProducts = (async () => {
    const now = Date.now();
    if (now - productCache.time < 20000 && productCache.data.length) return productCache.data;
    try {
      const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`, {
        headers: { "x-api-key": WEBHOOK_API_KEY },
        timeout: 8000,
      });
      let data = [];
      const raw = res.data;
      if (Array.isArray(raw)) data = raw;
      else if (Array.isArray(raw?.products)) data = raw.products;
      else if (Array.isArray(raw?.data)) data = raw.data;
      else if (raw && typeof raw === "object") {
        for (const val of Object.values(raw)) {
          if (Array.isArray(val) && val.length) { data = val; break; }
        }
      }
      if (data.length) productCache = { data, time: now };
      console.log("✅ Products loaded:", data.length);
      return data.length ? data : productCache.data;
    } catch (err) {
      console.error("Product fetch error:", err.message);
      return productCache.data;
    } finally {
      fetchingProducts = null;
    }
  })();
  return fetchingProducts;
}

/* ===== FUZZY PRODUCT MATCH ===== */
function findBestProduct(products, query) {
  if (!products.length || !query) return null;
  const q = query.toLowerCase();
  // Exact match first
  for (const p of products) {
    if (!p.product_name) continue;
    if (q.includes(p.product_name.toLowerCase()) || p.product_name.toLowerCase().includes(q))
      return p;
  }
  // Word overlap scoring
  let best = null, bestScore = 0;
  for (const p of products) {
    if (!p.product_name) continue;
    const name = p.product_name.toLowerCase();
    const nameWords = name.split(/\s+/).filter(w => w.length > 1);
    const queryWords = q.split(/\s+/).filter(w => w.length > 1);
    let match = 0;
    for (const nw of nameWords) {
      if (queryWords.some(qw => qw.includes(nw) || nw.includes(qw))) match++;
    }
    const score = nameWords.length ? match / nameWords.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 0.35 ? best : null;
}

/* ===== PRODUCT INFO REPLY ===== */
function productInfoReply(lang, product, intent = "general") {
  const name = product.product_name;
  const price = product.price_bdt || "N/A";
  const color = product.color || "N/A";
  const inStock = product.stock_availability === "in_stock";
  const qty = product.stock_count || product.quantity || null;

  if (intent === "price") {
    return fmt(lang,
      `${name} এর দাম ${price} টাকা।`,
      `${name} er price ${price} taka.`,
      `${name} price is ${price} BDT.`
    );
  }
  if (intent === "color") {
    return fmt(lang,
      `${name} এর রং: ${color}`,
      `${name} er color: ${color}`,
      `${name} colors: ${color}`
    );
  }
  if (intent === "stock") {
    return fmt(lang,
      inStock ? `${name} এখন available আছে।` : `${name} এখন নেই।`,
      inStock ? `${name} ache.` : `${name} nai ekhon.`,
      inStock ? `${name} is in stock.` : `${name} is out of stock.`
    );
  }
  if (intent === "quantity") {
    if (qty) return fmt(lang, `${name} এখন ${qty}টা আছে।`, `${name} ekhon ${qty}ta ache.`, `${name} has ${qty} in stock.`);
    return fmt(lang,
      inStock ? `${name} আছে। পরিমাণ জানতে seller কে জিজ্ঞেস করুন।` : `${name} নেই।`,
      inStock ? `${name} ache. Porimaan jante seller ke jiggesh korun.` : `${name} nai.`,
      inStock ? `${name} is in stock. Ask seller for quantity.` : `${name} is out of stock.`
    );
  }
  // Default general info
  return fmt(lang,
    `${name}\nদাম: ${price} টাকা\nরং: ${color}\nস্টক: ${inStock ? "✅ আছে" : "❌ নেই"}`,
    `${name}\nPrice: ${price} taka\nColor: ${color}\nStock: ${inStock ? "✅ ache" : "❌ nai"}`,
    `${name}\nPrice: ${price} BDT\nColor: ${color}\nStock: ${inStock ? "✅ in stock" : "❌ out of stock"}`
  );
}

function productListText(products, lang) {
  if (!products.length) return fmt(lang, "কোনো product নেই।", "Kono product nai.", "No products.");
  const list = products.map(p => `• ${p.product_name} — ${p.price_bdt || "N/A"} BDT`).join("\n");
  return fmt(lang,
    `আমাদের products:\n${list}`,
    `Amader products:\n${list}`,
    `Our products:\n${list}`
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
      product_name: product.product_name,
      message: `🧾 NEW ORDER REQUEST\nProduct: ${product.product_name}\nName: ${name}\nAddress: ${address}\nPhone: ${phone}\nOriginal message: ${originalMsg}`,
    }, { timeout: 5000 });
    console.log("✅ Order alert sent");
  } catch (err) {
    console.error("Alert error:", err.message);
  }
}

/* ===== PARSE ORDER DETAILS (flexible) ===== */
function parseOrderDetails(msg) {
  // Extract phone number (10-14 digits)
  let phone = null;
  const phoneMatch = msg.match(/\b(\+?880|0)?\d{10,11}\b/);
  if (phoneMatch) phone = phoneMatch[0];
  let remaining = phone ? msg.replace(phoneMatch[0], "") : msg;
  remaining = remaining.replace(/[,،\n]+/g, " ").trim();
  const words = remaining.split(/\s+/).filter(w => w.length > 0);
  let name = null, address = null;
  if (words.length) {
    name = words[0];
    if (words.length > 1) address = words.slice(1).join(" ");
  }
  // If no address but contains commas, try comma split
  if (!address && remaining.includes(",")) {
    const parts = remaining.split(",").map(s => s.trim());
    name = parts[0] || name;
    address = parts.slice(1).join(", ") || null;
  }
  return { name, address, phone };
}

/* ===== AI FEATURE / FALLBACK ===== */
async function aiReply(userMsg, product, sessionLang) {
  const systemPrompt = `You are BizAssist, a friendly shop assistant.
Rules:
- NEVER invent products, prices, colors, or stock.
- Only answer based on the product info provided below.
- Keep replies SHORT (1-2 sentences).
- Match the user's language (English/Bangla/Banglish).

Product info:
Name: ${product.product_name}
Price: ${product.price_bdt || "N/A"} BDT
Color: ${product.color || "N/A"}
Stock: ${product.stock_availability === "in_stock" ? "In stock" : "Out of stock"}
Description: ${product.description || "No detailed description available"}

Conversation context: The user just asked about this product. Reply helpfully.`;
  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg }
      ],
      max_tokens: 120,
      temperature: 0.3,
    });
    return res.choices[0].message.content.trim();
  } catch (err) {
    console.error("AI error:", err.message);
    return productInfoReply(sessionLang, product, "general");
  }
}

/* ===== GREETING DETECTION ===== */
function isGreeting(msg) {
  const m = msg.trim().toLowerCase();
  return /^(hi|hello|hey|hii|hy|salam|salaam|assalamualaikum|হ্যালো|হাই|good morning|start|shuru|hey there)$/i.test(m);
}

/* ===== INTENT DETECTION ===== */
function detectIntent(msg) {
  const m = msg.toLowerCase();
  if (/price|dam|koto|দাম|কত|how much|cost/.test(m)) return "price";
  if (/color|colour|rong|রং/.test(m)) return "color";
  if (/stock|ache|available|আছে|ase|in stock|do you have/.test(m)) return "stock";
  if (/quantity|koyta|koyti|কয়টা/.test(m)) return "quantity";
  if (/order|buy|nibo|নেব|kinbo|লাগবে|i want|purchase/.test(m)) return "order";
  return "general";
}

/* ===== IMAGE ANALYSIS ===== */
async function analyzeImage(imageUrl, products) {
  try {
    const img = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 15000 });
    const base64 = Buffer.from(img.data).toString("base64");
    const contentType = img.headers["content-type"] || "image/jpeg";
    const productList = products.map(p => `- ${p.product_name} (${p.price_bdt || "N/A"} BDT, color: ${p.color || "N/A"})`).join("\n");
    const res = await groq.chat.completions.create({
      model: "llama-3.2-11b-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
            { type: "text", text: `Match this image to one of our products. Our products:\n${productList}\nIf a match is found, reply with the EXACT product name (nothing else). If no match, reply "NOT_IN_SHOP".` }
          ]
        }
      ],
      max_tokens: 50,
    });
    const answer = res.choices[0].message.content.trim();
    if (answer !== "NOT_IN_SHOP") {
      const matched = findBestProduct(products, answer);
      if (matched) return matched;
    }
    return null;
  } catch (err) {
    console.error("Image analysis error:", err.message);
    return null;
  }
}

/* ===== SEND MESSAGE ===== */
async function sendMessage(senderId, text, retry = 2) {
  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      { recipient: { id: senderId }, message: { text } },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 8000 }
    );
    console.log("✅ Sent to", senderId);
  } catch (err) {
    if (retry > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return sendMessage(senderId, text, retry - 1);
    }
    console.error("Send error:", err.response?.data || err.message);
  }
}

function sendTyping(senderId) {
  axios.post(
    "https://graph.facebook.com/v18.0/me/messages",
    { recipient: { id: senderId }, sender_action: "typing_on" },
    { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 3000 }
  ).catch(() => {});
}

/* ===== MAIN MESSAGE PROCESSOR ===== */
async function processMessage(senderId, messageText, imageProduct = null) {
  const session = getSession(senderId);
  const lang = session.lang || detectLanguage(messageText);
  session.lang = lang;

  // If an image was matched, set that as the current product
  if (imageProduct) {
    session.lastProduct = imageProduct;
  }

  // ----- ORDER FLOW -----
  if (session.orderStep === "awaiting_details") {
    // If user asks a product question instead of giving details, exit order mode
    const anyProduct = findBestProduct(await fetchProducts(), messageText);
    if (anyProduct) {
      session.orderStep = null;
      session.orderProduct = null;
      // fall through to normal product handling
    } else {
      const { name, address, phone } = parseOrderDetails(messageText);
      if (!name || !address || !phone) {
        return fmt(lang,
          `আপনার তথ্য পুরোপুরি পাইনি। দয়া করে লিখুন:\nনাম, ঠিকানা, মোবাইল নাম্বার\nউদাহরণ: Rahim, Dhaka Mirpur 10, 01712345678`,
          `Apnar info puropuri pailam na. Likhen:\nNaam, Address, Phone\nUdaharon: Rahim, Dhaka Mirpur 10, 01712345678`,
          `Couldn't get your full details. Please write:\nName, Address, Phone\nExample: Rahim, Dhaka Mirpur 10, 01712345678`
        );
      }
      session.orderName = name;
      session.orderAddress = address;
      session.orderPhone = phone;
      session.orderStep = "awaiting_confirm";
      return fmt(lang,
        `✅ আপনার order details:\n\nProduct: ${session.orderProduct.product_name}\nনাম: ${name}\nঠিকানা: ${address}\nফোন: ${phone}\n\nConfirm করতে "yes" লিখুন, বাতিল করতে "no" লিখুন।`,
        `✅ Apnar order details:\n\nProduct: ${session.orderProduct.product_name}\nNaam: ${name}\nAddress: ${address}\nPhone: ${phone}\n\nConfirm korte "yes" likhen, cancel korte "no" likhen.`,
        `✅ Your order details:\n\nProduct: ${session.orderProduct.product_name}\nName: ${name}\nAddress: ${address}\nPhone: ${phone}\n\nType "yes" to confirm, "no" to cancel.`
      );
    }
  }

  if (session.orderStep === "awaiting_confirm") {
    const m = messageText.toLowerCase().trim();
    const isYes = /^(yes|haa|ha|ok|okay|sure|confirm|haan|han|yep)$/i.test(m);
    const isNo = /^(no|na|না|nah|nope|nai|cancel|bata|naa)$/i.test(m);
    if (isYes) {
      const product = session.orderProduct;
      const name = session.orderName;
      const address = session.orderAddress;
      const phone = session.orderPhone;
      await sendOrderAlert(senderId, product, name, address, phone, "Customer confirmed order");
      session.orderStep = null;
      session.orderProduct = null;
      session.orderName = null;
      session.orderAddress = null;
      session.orderPhone = null;
      return fmt(lang,
        `🛒 আপনার order confirm হয়েছে!\n\nProduct: ${product.product_name}\nSeller শীঘ্রই আপনার সাথে যোগাযোগ করবেন।`,
        `🛒 Apnar order confirm hoyeche!\n\nProduct: ${product.product_name}\nSeller shighroi contact korben.`,
        `🛒 Your order is confirmed!\n\nProduct: ${product.product_name}\nThe seller will contact you shortly.`
      );
    }
    if (isNo) {
      session.orderStep = null;
      session.orderProduct = null;
      return fmt(lang,
        "❌ Order বাতিল করা হয়েছে।",
        "❌ Order cancel hoyeche.",
        "❌ Order cancelled."
      );
    }
    return fmt(lang,
      `"yes" লিখুন confirm করতে, "no" লিখুন বাতিল করতে।`,
      `"yes" likhen confirm korte, "no" likhen cancel korte.`,
      `Type "yes" to confirm or "no" to cancel.`
    );
  }

  // ----- GREETING -----
  if (isGreeting(messageText)) {
    const products = await fetchProducts();
    const list = productListText(products, lang);
    return fmt(lang,
      `👋 আস্সালামু আলাইকুম! আমি BizAssist, আপনার shop assistant।\n\n${list}\n\nকোনটার কথা জানতে চান?`,
      `👋 Hi! Ami BizAssist, apnar shop assistant.\n\n${list}\n\nKontar kotha jante chan?`,
      `👋 Hi! I'm BizAssist, your shop assistant.\n\n${list}\n\nWhich product would you like to know about?`
    );
  }

  // ----- PRODUCT LOOKUP -----
  const products = await fetchProducts();
  let product = session.lastProduct || findBestProduct(products, messageText);

  // Context follow-up (this, eta, same)
  const contextWords = /^(this|eta|eita|ota|same|that|ata|eti|this one)$/i;
  if (!product && contextWords.test(messageText.trim()) && session.lastProduct) {
    product = session.lastProduct;
  }

  const intent = detectIntent(messageText);

  // If we don't have a product yet, try to match again (maybe user typed product name)
  if (!product) product = findBestProduct(products, messageText);
  if (!product) {
    if (intent === "order") {
      return fmt(lang,
        "কোন product order করতে চান? প্রোডাক্টের নাম বলুন।",
        "Kon product order korte chan? Naam bolun.",
        "Which product would you like to order? Please tell me the product name."
      );
    }
    const list = productListText(products, lang);
    return fmt(lang,
      `❌ এই product পাওয়া যায়নি।\n\n${list}\n\nআবার চেষ্টা করুন।`,
      `❌ Ei product paoa jai nai.\n\n${list}\n\nAbar try korun.`,
      `❌ Product not found.\n\n${list}\n\nPlease try again.`
    );
  }

  // Save last product for context
  session.lastProduct = product;

  // ----- ORDER INTENT -----
  if (intent === "order") {
    session.orderStep = "awaiting_details";
    session.orderProduct = product;
    return fmt(lang,
      `🛒 "${product.product_name}" অর্ডার করতে চান!\n\nআপনার তথ্য দিন:\nনাম, ঠিকানা, মোবাইল নাম্বার\nউদাহরণ: Rahim, Dhaka Mirpur 10, 01712345678`,
      `🛒 "${product.product_name}" order korte chaichen!\n\nApnar info din:\nNaam, Address, Phone\nUdaharon: Rahim, Dhaka Mirpur 10, 01712345678`,
      `🛒 You want to order "${product.product_name}"!\n\nPlease provide:\nName, Address, Phone\nExample: Rahim, Dhaka Mirpur 10, 01712345678`
    );
  }

  // ----- STANDARD INTENTS (price, color, stock, quantity) -----
  if (["price", "color", "stock", "quantity"].includes(intent)) {
    return productInfoReply(lang, product, intent);
  }

  // ----- GENERAL / FEATURE QUESTIONS (use AI) -----
  const aiResponse = await aiReply(messageText, product, lang);
  return aiResponse;
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
    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;
        const senderId = event.sender.id;
        const messageId = event.message.mid;
        if (processedMessages.has(messageId)) continue;
        processedMessages.set(messageId, Date.now());
        if (isSpam(senderId)) continue;

        sendTyping(senderId);

        const attachments = event.message.attachments;
        let reply = "";
        let imageProduct = null;

        if (attachments && attachments[0]?.type === "image") {
          const imageUrl = attachments[0].payload.url;
          const products = await fetchProducts();
          imageProduct = await analyzeImage(imageUrl, products);
          if (imageProduct) {
            // Successfully matched image to a product
            reply = productInfoReply(detectLanguage(""), imageProduct, "general");
            // Save the product in session for follow-up
            const session = getSession(senderId);
            session.lastProduct = imageProduct;
          } else {
            const lang = detectLanguage("");
            reply = fmt(lang,
              `এই ছবির productটি আমাদের shop এ নেই।\n\n${productListText(await fetchProducts(), "bn")}`,
              `Ei chhobir product ta amader shop e nai.\n\n${productListText(await fetchProducts(), "bl")}`,
              `This product is not in our shop.\n\n${productListText(await fetchProducts(), "en")}`
            );
          }
        } else if (event.message.text) {
          reply = await processMessage(senderId, event.message.text, imageProduct);
        } else continue;

        if (reply) await sendMessage(senderId, reply);
      }
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

app.get("/", (req, res) => res.send("✅ BizAssist Smart Bot Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
