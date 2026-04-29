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
  console.error("❌ Missing PAGE_ACCESS_TOKEN");
  process.exit(1);
}
if (!WEBHOOK_API_KEY) {
  console.error("❌ Missing WEBHOOK_API_KEY");
  process.exit(1);
}
if (!GROQ_API_KEY) {
  console.warn("⚠️ Missing GROQ_API_KEY – AI fallback & image disabled");
}

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";
const BASE_URL =
  "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${BASE_URL}/api/public/get-products`;
const ALERT_URL = `${BASE_URL}/api/public/order-alert`;

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

/* ------------------- MEMORY ------------------- */
const processedMessages = new Map(); // mid -> timestamp
const userCooldown = new Map();
const userSessions = new Map();

const MESSAGE_TTL = 60000;   // 1 min
const COOLDOWN_MS = 800;
const MAX_PROCESSED_MSGS = 5000;

setInterval(() => {
  const now = Date.now();
  // Clean old messages
  for (const [id, time] of processedMessages) {
    if (now - time > MESSAGE_TTL) processedMessages.delete(id);
  }
  // Prevent memory leak: keep only last 5000
  if (processedMessages.size > MAX_PROCESSED_MSGS) {
    const firstKey = processedMessages.keys().next().value;
    processedMessages.delete(firstKey);
  }
  // Clean cooldown
  for (const [id, time] of userCooldown) {
    if (now - time > MESSAGE_TTL) userCooldown.delete(id);
  }
  // Clean inactive sessions
  for (const [id, session] of userSessions) {
    if (now - (session.lastActive || 0) > 3600000) userSessions.delete(id);
  }
}, 30000);

/* ------------------- SESSION (with state & history) ------------------- */
function getSession(senderId) {
  if (!userSessions.has(senderId)) {
    userSessions.set(senderId, {
      lastProduct: null,
      lastIntent: null,
      history: [],           // { role, message }[]
      state: "browsing",     // browsing, product_viewed, collecting_info
      collectingDetails: false,
      pendingOrderProduct: null,
      lang: "en",
      lastActive: Date.now(),
    });
  }
  const sess = userSessions.get(senderId);
  sess.lastActive = Date.now();
  return sess;
}

function addHistory(session, role, message) {
  session.history.push({ role, message });
  if (session.history.length > 15) session.history.shift();
}

/* ------------------- PRODUCT CACHE ------------------- */
let productCache = { data: [], time: 0 };
let fetchingProducts = null;
const CACHE_TTL = 20000;

async function fetchProducts() {
  if (fetchingProducts) return fetchingProducts;
  fetchingProducts = (async () => {
    const now = Date.now();
    if (now - productCache.time < CACHE_TTL && productCache.data.length)
      return productCache.data;
    try {
      const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`, {
        headers: { "x-api-key": WEBHOOK_API_KEY },
        timeout: 8000,
      });
      let data = [];
      if (Array.isArray(res.data)) data = res.data;
      else if (Array.isArray(res.data?.data)) data = res.data.data;
      else if (Array.isArray(res.data?.products)) data = res.data.products;
      if (data.length) productCache = { data, time: now };
      else if (!productCache.data.length) console.error("❌ No product data");
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
  let best = null,
    bestScore = 0;
  for (const p of products) {
    const name = (p.product_name || "").toLowerCase();
    if (!name) continue;
    if (q.includes(name) || name.includes(q)) return p;
    const nameWords = name.split(/\s+/).filter((w) => w.length > 1);
    const queryWords = q.split(/\s+/).filter((w) => w.length > 1);
    let match = 0;
    for (const nw of nameWords) {
      if (queryWords.some((qw) => qw.includes(nw) || nw.includes(qw))) match++;
    }
    const score = nameWords.length ? match / nameWords.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 0.35 ? best : null;
}

/* ------------------- INTENT & LANGUAGE ------------------- */
function detectIntent(text) {
  const t = text.toLowerCase();
  let scores = { price: 0, stock: 0, color: 0, order: 0, greeting: 0, about_seller: 0 };

  if (/(price|dam|koto|দাম|কত)/i.test(t)) scores.price += 3;
  if (/(stock|ache|available|আছে|ase|in stock|do you have)/i.test(t)) scores.stock += 3;
  if (/(color|colour|rong|রং)/i.test(t)) scores.color += 3;
  if (/(order|buy|purchase|nibo|নেব|kinbo|কিনব|lagbe|লাগবে|i want|i need)/i.test(t))
    scores.order += 3;
  if (/^(hi|hello|hey|হ্যালো|হাই|assalamualaikum|salam)$/i.test(t))
    scores.greeting += 2;
  if (/(seller|who.*seller|ke ke|owner|contact|seller.*phone)/i.test(t))
    scores.about_seller += 3;

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 0 ? top[0] : "fallback";
}

function detectLanguage(text) {
  if (/[\u0980-\u09FF]/.test(text)) return "bn";
  if (/(koto|dam|ache|nai|ki|taka|nibo|rong|lagbe|ase)/i.test(text)) return "bl";
  return "en";
}

function replyInLanguage(lang, bn, bl, en) {
  if (lang === "bn") return bn;
  if (lang === "bl") return bl;
  return en;
}

/* ------------------- AI FALLBACK (safe) ------------------- */
async function getAIHelp(userMessage, session) {
  if (!groq) return "I'm having trouble thinking. Please try again.";
  try {
    const recentHistory = session.history.slice(-4).map(h => `${h.role}: ${h.message}`).join("\n");
    const chat = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `You are BizAssist, a friendly shop assistant.
RULES:
- NEVER invent products, prices, colors, stock.
- Keep replies SHORT (1 sentence).
- Match user language (English/Bangla/Banglish).
Recent conversation:\n${recentHistory}\nLast product: ${session.lastProduct?.product_name || "none"}
Reply helpfully but without inventing product details.`,
        },
        { role: "user", content: userMessage },
      ],
      max_tokens: 150,
    });
    let reply = chat.choices[0].message.content.trim();
    const products = await fetchProducts();
    const mentionsReal = products.some(p => reply.toLowerCase().includes(p.product_name.toLowerCase()));
    if (!mentionsReal && reply.match(/(?:price|cost|stock|available)/i)) {
      return replyInLanguage(session.lang,
        "আমি নিশ্চিত নই। প্রোডাক্টের নাম স্পষ্ট করে বলুন।",
        "Ami nishchit noi. Product er naam shpôshto bolun.",
        "I'm not sure. Please tell me the exact product name."
      );
    }
    return reply;
  } catch (err) {
    console.error("AI fallback error:", err.message);
    return replyInLanguage(session.lang,
      "একটু পরে আবার চেষ্টা করুন।",
      "Ektu pore chesta korun.",
      "Please try again in a moment."
    );
  }
}

/* ------------------- IMAGE ANALYSIS with SAFE URL RESOLVE ------------------- */
async function resolveImageUrl(attachment) {
  if (attachment?.payload?.url) return attachment.payload.url;
  // Facebook stickers or other non-image types
  return null;
}

async function safeImageBuffer(url) {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BizAssistBot/1.0)" },
    });
    return Buffer.from(res.data);
  } catch (err) {
    console.error("Image fetch failed:", err.message);
    return null;
  }
}

async function analyzeImage(attachment, products) {
  const imageUrl = await resolveImageUrl(attachment);
  if (!imageUrl) return { found: false, reply: null };

  const buffer = await safeImageBuffer(imageUrl);
  if (!buffer) return { found: false, reply: "Image not accessible. Please describe the product." };

  if (!groq) return { found: false, reply: null };
  const base64 = buffer.toString("base64");
  const productList = products.map(p => `- ${p.product_name}`).join("\n");
  try {
    const vision = await groq.chat.completions.create({
      model: "llama-3.2-11b-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: "text", text: `Match this image with ONE product from list:\n${productList}\nIf match, reply ONLY product name. If not, reply NO_MATCH.` },
          ],
        },
      ],
      max_tokens: 50,
    });
    const answer = vision.choices[0].message.content.trim();
    if (answer !== "NO_MATCH") {
      const matched = findBestProduct(products, answer);
      if (matched)
        return { found: true, product: matched, reply: `${matched.product_name} — ${matched.price_bdt || "N/A"} BDT` };
    }
    return { found: false, reply: null };
  } catch (err) {
    console.error("Vision error:", err.message);
    return { found: false, reply: null };
  }
}

/* ------------------- ORDER ALERT ------------------- */
async function sendOrderAlert(senderId, product, detailsText) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: senderId,
      product_name: product.product_name,
      message: `🧾 NEW ORDER REQUEST (PENDING CONFIRMATION)\n\nProduct: ${product.product_name}\n\nCustomer Details:\n${detailsText}\n\n⚠️ Seller must confirm before processing.`,
    });
    console.log(`✅ Order alert sent for ${product.product_name}`);
  } catch (err) {
    console.error("Order alert failed:", err.message);
  }
}

/* ------------------- FACEBOOK SEND / TYPING ------------------- */
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
    console.error("FB send error:", err.response?.data || err.message);
  }
}

/* ------------------- MAIN PROCESSOR ------------------- */
// Bonus: follow-up detection
function isSimpleFollowUp(text) {
  return /^(ok|ঠিক আছে|yes|yes ok|k|kk|👍|thik ache|হ্যাঁ|ঠিক)$/i.test(text);
}

async function processMessage(senderId, messageText) {
  const session = getSession(senderId);
  // Auto-reset stale state (5 minutes idle)
  if (session.state !== "browsing" && Date.now() - session.lastActive > 5 * 60 * 1000) {
    session.state = "browsing";
    session.pendingOrderProduct = null;
    session.collectingDetails = false;
  }

  addHistory(session, "user", messageText);
  const lang = detectLanguage(messageText);
  session.lang = lang;

  // BONUS: simple follow-up after product info
  if (session.state === "product_viewed" && isSimpleFollowUp(messageText) && session.lastProduct) {
    const reply = replyInLanguage(lang,
      `আপনি কি "${session.lastProduct.product_name}" নিয়ে কিছু জানতে চান? দাম, স্টক, অর্ডার বলতে পারেন।`,
      `Apni ki "${session.lastProduct.product_name}" niye jante chan? Dam, stock, order bolte paren.`,
      `Do you want to know more about "${session.lastProduct.product_name}"? Price, stock, or order?`
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  // ----- COLLECTING DETAILS (order flow) -----
  if (session.collectingDetails) {
    if (/^(cancel|no|na|না|cancel order)$/i.test(messageText)) {
      session.collectingDetails = false;
      session.pendingOrderProduct = null;
      session.state = "browsing";
      addHistory(session, "assistant", "Order cancelled");
      return replyInLanguage(session.lang,
        "❌ অর্ডার বাতিল করা হয়েছে।",
        "❌ Order cancel kora hoyeche.",
        "❌ Order cancelled."
      );
    }
    const product = session.pendingOrderProduct;
    const hasPhone = /\d{10,14}/.test(messageText);
    const hasWords = messageText.trim().split(/\s+/).length >= 3;
    if (!hasPhone || !hasWords) {
      return replyInLanguage(session.lang,
        "⚠️ দয়া করে নাম, ঠিকানা ও মোবাইল নাম্বার সঠিকভাবে লিখুন।",
        "⚠️ Name, address, phone thik likhun.",
        "⚠️ Please provide name, address, and phone number."
      );
    }
    if (product) {
      await sendOrderAlert(senderId, product, messageText);
    }
    session.collectingDetails = false;
    session.pendingOrderProduct = null;
    session.state = "browsing";
    addHistory(session, "assistant", "Order request sent");
    return replyInLanguage(session.lang,
      "⚠️ আপনার অর্ডার রিকোয়েস্ট seller এর কাছে পাঠানো হয়েছে। তিনি ফোনে যোগাযোগ করে confirm করবেন।",
      "⚠️ Apnar order request seller er kache pathano hoyeche. Tini phone e contact kore confirm korben.",
      "⚠️ Your order request has been sent. The seller will contact you by phone to confirm."
    );
  }

  // ----- SPECIAL INTENT: about seller -----
  const intent = detectIntent(messageText);
  if (intent === "about_seller") {
    addHistory(session, "assistant", "Answered seller info");
    return replyInLanguage(session.lang,
      "আমরা একটি online store. Seller আপনার অর্ডার দেওয়ার পর ফোনে যোগাযোগ করবেন এবং confirm করবেন।",
      "Amra ekta online store. Seller apnar order dewar por phone e contact kore confirm korben.",
      "We are an online store. The seller will contact you by phone to confirm your order."
    );
  }

  // ----- PRODUCT LOOKUP -----
  const products = await fetchProducts();
  let product = findBestProduct(products, messageText);

  // SMART CONTEXT: "eta / this / order korbo" only if last assistant message was about product
  const contextTriggers = /^(eta|this|ota|eita|same|that|ata|ta|eti|order korbo|ami nibo|ei ta)$/i;
  const lastAssistantMsg = session.history.filter(h => h.role === "assistant").pop()?.message || "";
  const lastMentionsProduct = session.lastProduct && lastAssistantMsg.toLowerCase().includes(session.lastProduct.product_name.toLowerCase());

  if (!product && session.lastProduct && contextTriggers.test(messageText.trim()) && lastMentionsProduct) {
    product = session.lastProduct;
  }

  // Update state
  if (product) session.state = "product_viewed";
  else session.state = "browsing";

  session.lastIntent = intent;

  if (product) {
    session.lastProduct = product;
    const name = product.product_name;
    const price = product.price_bdt || "N/A";
    const color = product.color || "N/A";
    const inStock = product.stock_availability === "in_stock";

    switch (intent) {
      case "price":
        addHistory(session, "assistant", `Price of ${name} answered`);
        return replyInLanguage(lang,
          `${name} এর দাম ${price} টাকা।`,
          `${name} er dam ${price} taka.`,
          `${name} price is ${price} BDT.`
        );
      case "color":
        addHistory(session, "assistant", `Color of ${name} answered`);
        return replyInLanguage(lang,
          `${name} এর রং: ${color}`,
          `${name} er color: ${color}`,
          `${name} colors: ${color}`
        );
      case "stock":
        addHistory(session, "assistant", `Stock of ${name} answered`);
        return replyInLanguage(lang,
          inStock ? `${name} available আছে।` : `${name} এখন নেই।`,
          inStock ? `${name} ache.` : `${name} nai ekhon.`,
          inStock ? `${name} is in stock.` : `${name} is out of stock.`
        );
      case "order":
        session.collectingDetails = true;
        session.pendingOrderProduct = product;
        session.state = "collecting_info";
        addHistory(session, "assistant", `Asked for details for ${name}`);
        return replyInLanguage(lang,
          `🛒 "${name}" অর্ডার করতে চান।\n\nদয়া করে আপনার:\n• নাম\n• ঠিকানা\n• মোবাইল নাম্বার\n\nলিখুন। Seller যাচাই করে ফোনে confirm করবে।`,
          `🛒 "${name}" order korte chan.\n\nPlease apnar:\n• Name\n• Address\n• Phone number\n\ndin. Seller verify kore phone e confirm korbe.`,
          `🛒 You want to order "${name}".\n\nPlease provide:\n• Name\n• Address\n• Phone number\n\nThe seller will verify and confirm by phone.`
        );
      default:
        addHistory(session, "assistant", `Default product info for ${name}`);
        return replyInLanguage(lang,
          `${name} — দাম: ${price} টাকা, রং: ${color}${inStock ? ", এখন available।" : ", এখন নেই।"}`,
          `${name} — dam: ${price} taka, color: ${color}${inStock ? ", ache." : ", nai."}`,
          `${name} — Price: ${price} BDT, Color: ${color}${inStock ? ", in stock." : ", out of stock."}`
        );
    }
  }

  // No product matched
  if (intent === "order") {
    addHistory(session, "assistant", "Asked which product to order");
    return replyInLanguage(lang,
      "কোন প্রোডাক্ট অর্ডার করতে চান? প্রোডাক্টের নাম বলুন।",
      "Kon product order korte chan? Naam bolun.",
      "Which product would you like to order? Please tell me the product name."
    );
  }
  if (intent === "greeting") {
    addHistory(session, "assistant", "Greeted user");
    return replyInLanguage(lang,
      "হ্যালো! আমি BizAssist। কোন প্রোডাক্ট সম্পর্কে জানতে চান?",
      "Hello! Ami BizAssist. Kon product niye jante chan?",
      "Hi! I'm BizAssist. What product would you like to know about?"
    );
  }

  const aiReply = await getAIHelp(messageText, session);
  addHistory(session, "assistant", aiReply);
  return aiReply || replyInLanguage(lang,
    "আমি বুঝতে পারিনি। প্রোডাক্টের নাম বলুন।",
    "Bujhte parini. Product er naam bolun.",
    "I didn't understand. Please tell me a product name."
  );
}

/* ------------------- WEBHOOK ------------------- */
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

        // ATOMIC duplicate check (fix race condition)
        if (processedMessages.get(messageId)) continue;
        processedMessages.set(messageId, Date.now());

        const last = userCooldown.get(senderId) || 0;
        if (Date.now() - last < COOLDOWN_MS) continue;
        userCooldown.set(senderId, Date.now());

        sendTyping(senderId);
        let reply = "";

        if (attachments && attachments[0]?.type === "image") {
          const products = await fetchProducts();
          const analysis = await analyzeImage(attachments[0], products);
          if (analysis.found) {
            reply = analysis.reply;
          } else {
            const lang = detectLanguage(text);
            reply = replyInLanguage(lang,
              "এই ছবির প্রোডাক্টটি আমাদের শপে নেই। প্রোডাক্টের নাম বলুন।",
              "Ei product amader shop e nai. Naam bolun.",
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
    console.error("Webhook error:", err.message);
  }
});

app.get("/", (req, res) => res.send("✅ BizAssist AI Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
