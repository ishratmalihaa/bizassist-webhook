const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");

/* ------------------- CONFIG ------------------- */
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "bizassist123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

if (!PAGE_ACCESS_TOKEN) {
  console.error("❌ Missing PAGE_ACCESS_TOKEN. Set it in Render env vars.");
  process.exit(1);
}
if (!WEBHOOK_API_KEY) {
  console.error("❌ Missing WEBHOOK_API_KEY. Set it in Render env vars.");
  process.exit(1);
}
if (!GROQ_API_KEY) {
  console.warn("⚠️ Missing GROQ_API_KEY – AI fallback and image analysis disabled.");
}

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";
const BASE_URL =
  "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${BASE_URL}/api/public/get-products`;
const ALERT_URL = `${BASE_URL}/api/public/order-alert`;

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

/* ------------------- MEMORY & CLEANUP ------------------- */
const processedMessages = new Map();
const userCooldown = new Map();
const userSessions = new Map();

const MESSAGE_TTL = 60000;
const COOLDOWN_MS = 800;

setInterval(() => {
  const now = Date.now();
  for (const [id, time] of processedMessages.entries()) {
    if (now - time > MESSAGE_TTL) processedMessages.delete(id);
  }
  for (const [id, time] of userCooldown.entries()) {
    if (now - time > MESSAGE_TTL) userCooldown.delete(id);
  }
  for (const [id, session] of userSessions.entries()) {
    if (now - (session.lastActive || 0) > 3600000) userSessions.delete(id);
  }
}, 30000);

/* ------------------- SESSION MANAGER ------------------- */
function getSession(senderId) {
  if (!userSessions.has(senderId)) {
    userSessions.set(senderId, {
      lastProduct: null,
      lastIntent: null,
      collectingDetails: false,   // waiting for name/address/phone after order request
      pendingOrderProduct: null,
      lang: "en",
      lastActive: Date.now(),
    });
  }
  const sess = userSessions.get(senderId);
  sess.lastActive = Date.now();
  return sess;
}

/* ------------------- PRODUCT SERVICE (cached + concurrency lock) ------------------- */
let productCache = { data: [], time: 0 };
let fetchingProducts = null;
const CACHE_TTL = 20000;

async function fetchProducts() {
  if (fetchingProducts) return fetchingProducts;

  fetchingProducts = (async () => {
    const now = Date.now();
    if (now - productCache.time < CACHE_TTL && productCache.data.length) {
      return productCache.data;
    }

    try {
      const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`, {
        headers: { "x-api-key": WEBHOOK_API_KEY },
        timeout: 8000,
      });
      let data = [];
      if (Array.isArray(res.data)) data = res.data;
      else if (Array.isArray(res.data?.data)) data = res.data.data;
      else if (Array.isArray(res.data?.products)) data = res.data.products;

      if (data.length) {
        productCache = { data, time: now };
      } else if (!productCache.data.length) {
        console.error("❌ No product data from API and cache is empty.");
      }
      return data;
    } catch (err) {
      console.error("Product fetch error:", err.message);
      return productCache.data;
    } finally {
      fetchingProducts = null;
    }
  })();

  return fetchingProducts;
}

function findBestProduct(products, query) {
  if (!products.length || !query) return null;
  const q = query.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const p of products) {
    const name = (p.product_name || "").toLowerCase();
    if (!name) continue;

    if (q.includes(name) || name.includes(q)) return p;

    const nameWords = name.split(/\s+/).filter(w => w.length > 1);
    const queryWords = q.split(/\s+/).filter(w => w.length > 1);
    let matchCount = 0;
    for (const nw of nameWords) {
      if (queryWords.some(qw => qw.includes(nw) || nw.includes(qw))) matchCount++;
    }
    const score = nameWords.length ? matchCount / nameWords.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 0.35 ? best : null;
}

/* ------------------- INTENT SERVICE ------------------- */
function detectIntent(text) {
  const t = text.toLowerCase();
  let scores = { price: 0, stock: 0, color: 0, order: 0, greeting: 0 };

  if (/(price|dam|koto|দাম|কত)/i.test(t)) scores.price += 3;
  if (/(stock|ache|available|আছে|ase|in stock|do you have)/i.test(t)) scores.stock += 3;
  if (/(color|colour|rong|রং)/i.test(t)) scores.color += 3;
  if (/(order|buy|purchase|nibo|নেব|kinbo|কিনব|lagbe|লাগবে|i want|i need)/i.test(t))
    scores.order += 3;
  if (/^(hi|hello|hey|হ্যালো|হাই|assalamualaikum|salam)$/i.test(t))
    scores.greeting += 2;

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 0 ? top[0] : "fallback";
}

/* ------------------- MULTI‑LANGUAGE ------------------- */
function replyInLanguage(lang, bn, bl, en) {
  if (lang === "bn") return bn;
  if (lang === "bl") return bl;
  return en;
}

function detectLanguage(text) {
  if (/[\u0980-\u09FF]/.test(text)) return "bn";
  if (/(koto|dam|ache|nai|ki|taka|nibo|rong|lagbe|ase)/i.test(text)) return "bl";
  return "en";
}

/* ------------------- AI FALLBACK (safe, no hallucination) ------------------- */
async function getAIHelp(userMessage, session) {
  if (!groq) return "I'm having trouble thinking. Please try again.";

  try {
    const chat = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `You are BizAssist, a friendly and helpful shop assistant for an online store.

RULES:
- NEVER invent products, prices, colors, or stock. If you don't know, say "I'm not sure, please check our product list."
- Keep replies SHORT, one sentence max.
- Match the user's language (English, Bangla, or Banglish).
- Be pleasant and slightly persuasive like a real shop assistant.

Conversation context:
Last product asked: ${session.lastProduct?.product_name || "none"}
Last intent: ${session.lastIntent || "none"}
User message: ${userMessage}

Now reply naturally, but do NOT invent product details.`,
        },
      ],
      max_tokens: 150,
    });
    let reply = chat.choices[0].message.content.trim();

    const products = await fetchProducts();
    const mentionsReal = products.some(p =>
      reply.toLowerCase().includes(p.product_name.toLowerCase())
    );
    if (!mentionsReal && reply.toLowerCase().match(/(?:price|cost|stock|available|have|in stock)/)) {
      return replyInLanguage(session.lang,
        "আমি নিশ্চিত নই। দয়া করে প্রোডাক্টের নাম স্পষ্ট করে বলুন।",
        "Ami nishchit noi. Please product er naam shpôshto kore bolun.",
        "I'm not sure. Please tell me the exact product name."
      );
    }
    return reply;
  } catch (err) {
    console.error("AI fallback error:", err.message);
    return replyInLanguage(session.lang,
      "একটু পরে আবার চেষ্টা করুন।",
      "Ektu pore abar chesta korun.",
      "Please try again in a moment."
    );
  }
}

/* ------------------- IMAGE ANALYSIS ------------------- */
async function analyzeImage(imageUrl, products) {
  const urlLower = imageUrl.toLowerCase();
  const fastMatch = findBestProduct(products, urlLower);
  if (fastMatch) {
    return {
      found: true,
      product: fastMatch,
      reply: `${fastMatch.product_name} — Price: ${fastMatch.price_bdt || "N/A"} BDT.`,
    };
  }

  if (!groq) return { found: false, reply: null };

  try {
    const img = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 8000 });
    const base64 = Buffer.from(img.data).toString("base64");
    const productList = products.map(p => `- ${p.product_name} (${p.price_bdt || "N/A"} BDT)`).join("\n");

    const vision = await groq.chat.completions.create({
      model: "llama-3.2-11b-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64}` },
            },
            {
              type: "text",
              text: `You are a product matcher. Our products:\n${productList}\n\nDoes the image match any product exactly? If yes, reply with ONLY the product name (nothing else). If no, reply with "NOT_IN_SHOP". Do not invent.`,
            },
          ],
        },
      ],
      max_tokens: 50,
    });
    const answer = vision.choices[0].message.content.trim();
    if (answer !== "NOT_IN_SHOP") {
      const matched = findBestProduct(products, answer);
      if (matched) return { found: true, product: matched, reply: `${matched.product_name} — ${matched.price_bdt || "N/A"} BDT` };
    }
    return { found: false, reply: null };
  } catch (err) {
    console.error("Image AI error:", err.message);
    return { found: false, reply: null };
  }
}

/* ------------------- ORDER ALERT (PENDING CONFIRMATION) ------------------- */
async function sendOrderAlert(senderId, product, detailsText) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: senderId,
      product_name: product.product_name,
      message: `🧾 NEW ORDER REQUEST (PENDING CONFIRMATION)\n\nProduct: ${product.product_name}\n\nCustomer Details:\n${detailsText}\n\n⚠️ Seller must confirm this order before processing.`,
    });
    console.log(`✅ Order request sent for confirmation: ${product.product_name}`);
  } catch (err) {
    console.error("Order alert failed:", err.message);
  }
}

/* ------------------- FACEBOOK SEND & TYPING ------------------- */
async function sendTyping(senderId) {
  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      { recipient: { id: senderId }, sender_action: "typing_on" },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 3000 }
    );
  } catch {}
}

async function sendMessage(senderId, text, retry = 2) {
  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      { recipient: { id: senderId }, message: { text } },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 8000 }
    );
  } catch (err) {
    if (retry > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return sendMessage(senderId, text, retry - 1);
    }
    console.error("FB send error:", err.message);
  }
}

/* ------------------- MAIN MESSAGE PROCESSOR ------------------- */
async function processMessage(senderId, messageText) {
  const session = getSession(senderId);
  const lang = detectLanguage(messageText);
  session.lang = lang;

  // ========== ORDER DETAILS COLLECTION (after user expressed intent) ==========
  if (session.collectingDetails) {
    // Cancel order
    if (/^(cancel|no|na|না|cancel order)$/i.test(messageText)) {
      session.collectingDetails = false;
      session.pendingOrderProduct = null;
      return replyInLanguage(session.lang,
        "❌ অর্ডার বাতিল করা হয়েছে।",
        "❌ Order cancel kora hoyeche.",
        "❌ Order has been cancelled."
      );
    }

    const product = session.pendingOrderProduct;

    // Basic validation: must contain phone number (10-14 digits) and at least 3 words
    const hasPhone = /\d{10,14}/.test(messageText);
    const hasWords = messageText.trim().split(/\s+/).length >= 3;

    if (!hasPhone || !hasWords) {
      return replyInLanguage(session.lang,
        "⚠️ দয়া করে আপনার নাম, ঠিকানা এবং মোবাইল নাম্বার সঠিকভাবে লিখুন।",
        "⚠️ Please name, address, phone thik vabe likhun.",
        "⚠️ Please provide valid name, address, and phone number."
      );
    }

    // Send ONE alert to seller (with customer details)
    if (product) {
      await sendOrderAlert(senderId, product, messageText);
    }

    session.collectingDetails = false;
    session.pendingOrderProduct = null;

    // Tell customer that seller will confirm (no bot confirmation)
    return replyInLanguage(session.lang,
      "⚠️ আপনার অর্ডার রিকোয়েস্ট seller এর কাছে পাঠানো হয়েছে। তিনি ফোনে যোগাযোগ করে confirm করবেন।",
      "⚠️ Apnar order request seller er kache pathano hoyeche. Tini phone e contact kore confirm korben.",
      "⚠️ Your order request has been sent to the seller. They will contact you by phone to confirm."
    );
  }

  // ========== NORMAL FLOW: product lookup, intents, AI fallback ==========
  const products = await fetchProducts();
  let product = findBestProduct(products, messageText);

  // Context follow‑up: "eta", "this", "same", etc.
  const contextWords = /^(this|eta|ota|eita|same|that|ata|ta|eti)$/i;
  if (!product && contextWords.test(messageText.trim()) && session.lastProduct) {
    product = session.lastProduct;
  }

  const intent = detectIntent(messageText);
  session.lastIntent = intent;

  if (product) {
    session.lastProduct = product;
    const name = product.product_name;
    const price = product.price_bdt || "N/A";
    const color = product.color || "N/A";
    const inStock = product.stock_availability === "in_stock";

    switch (intent) {
      case "price":
        return replyInLanguage(lang,
          `${name} এর দাম ${price} টাকা।`,
          `${name} er dam ${price} taka.`,
          `${name} price is ${price} BDT.`
        );
      case "color":
        return replyInLanguage(lang,
          `${name} এর রং: ${color}`,
          `${name} er color: ${color}`,
          `${name} colors: ${color}`
        );
      case "stock":
        return replyInLanguage(lang,
          inStock ? `${name} available আছে।` : `${name} এখন নেই।`,
          inStock ? `${name} ache.` : `${name} nai ekhon.`,
          inStock ? `${name} is in stock.` : `${name} is out of stock.`
        );
      case "order":
        // Do NOT send alert yet – first collect details
        session.collectingDetails = true;
        session.pendingOrderProduct = product;
        return replyInLanguage(lang,
          `🛒 "${name}" অর্ডার করতে চান।

দয়া করে আপনার:
• নাম
• ঠিকানা
• মোবাইল নাম্বার

লিখে দিন। Seller আপনার তথ্য যাচাই করে ফোনে confirm করবে।`,
          `🛒 "${name}" order korte chan.

Please apnar:
• Name
• Address
• Phone number

din. Seller apnar info verify kore phone e confirm korbe.`,
          `🛒 You want to order "${name}".

Please provide:
• Name
• Address
• Phone number

The seller will verify and confirm your order by phone.`
        );
      default:
        return replyInLanguage(lang,
          `${name} — দাম: ${price} টাকা, রং: ${color}${inStock ? ", এখন available।" : ", এখন নেই।"}`,
          `${name} — dam: ${price} taka, color: ${color}${inStock ? ", ache." : ", nai."}`,
          `${name} — Price: ${price} BDT, Color: ${color}${inStock ? ", in stock." : ", out of stock."}`
        );
    }
  }

  // No product matched
  if (intent === "order") {
    return replyInLanguage(lang,
      "কোন প্রোডাক্ট অর্ডার করতে চান? প্রোডাক্টের নাম বলুন।",
      "Kon product order korte chan? Product er naam bolun.",
      "Which product would you like to order? Please tell the product name."
    );
  }

  if (intent === "greeting") {
    return replyInLanguage(lang,
      "হ্যালো! আমি BizAssist। আপনি কোন প্রোডাক্ট সম্পর্কে জানতে চান?",
      "Hello! Ami BizAssist. Apni kon product er kotha jante chan?",
      "Hi! I'm BizAssist. What product would you like to know about?"
    );
  }

  // AI fallback (only when unclear or no product matched)
  const aiReply = await getAIHelp(messageText, session);
  return aiReply || replyInLanguage(lang,
    "আমি বুঝতে পারিনি। প্রোডাক্টের নাম বলুন।",
    "Ami bujhte parini. Product er naam bolun.",
    "I didn't understand. Please tell me a product name."
  );
}

/* ------------------- WEBHOOK HANDLERS ------------------- */
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
        const text = event.message.text || "";
        const attachments = event.message.attachments;

        if (processedMessages.has(messageId)) continue;
        processedMessages.set(messageId, Date.now());

        const last = userCooldown.get(senderId) || 0;
        if (Date.now() - last < COOLDOWN_MS) continue;
        userCooldown.set(senderId, Date.now());

        sendTyping(senderId);

        let reply = "";

        if (attachments && attachments[0]?.type === "image") {
          const products = await fetchProducts();
          const imageUrl = attachments[0].payload.url;
          const analysis = await analyzeImage(imageUrl, products);
          if (analysis.found) {
            reply = analysis.reply;
          } else {
            const lang = detectLanguage(text);
            reply = replyInLanguage(lang,
              "এই ছবির প্রোডাক্টটি আমাদের শপে নেই। প্রোডাক্টের নাম বলুন।",
              "Ei chhobir product ta amader shop e nai. Product er naam bolun.",
              "This product is not in our shop. Please tell me the product name."
            );
          }
        } else if (text) {
          reply = await processMessage(senderId, text);
        }

        if (reply) await sendMessage(senderId, reply);
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err.message);
  }
});

/* ------------------- HEALTH CHECK ------------------- */
app.get("/", (req, res) => res.send("✅ BizAssist AI Assistant Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
