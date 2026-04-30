const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");

/* ==================== CONFIG ==================== */
const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || "bizassist123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY || "";
const GROQ_API_KEY    = process.env.GROQ_API_KEY    || "";

if (!PAGE_ACCESS_TOKEN) { console.error("❌ Missing PAGE_ACCESS_TOKEN"); process.exit(1); }
if (!WEBHOOK_API_KEY)   { console.error("❌ Missing WEBHOOK_API_KEY");   process.exit(1); }
if (!GROQ_API_KEY)      { console.warn("⚠️ Missing GROQ_API_KEY – AI & image features disabled"); }

const SELLER_ID   = process.env.SELLER_ID   || "67f55dc2-41e9-410c-8c6b-289ebee08118";
const BASE_URL    = process.env.BASE_URL    || "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${BASE_URL}/api/public/get-products`;
const ALERT_URL    = `${BASE_URL}/api/public/order-alert`;

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

/* ==================== MEMORY ==================== */
const processedMessages = new Map();
const userCooldown      = new Map();
const userSessions      = new Map();

const MESSAGE_TTL = 60_000;
const COOLDOWN_MS = 800;
const SESSION_TTL = 3_600_000; // 1 hour

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of processedMessages) if (now - t > MESSAGE_TTL) processedMessages.delete(id);
  for (const [id, t] of userCooldown)      if (now - t > MESSAGE_TTL) userCooldown.delete(id);
  for (const [id, s] of userSessions)      if (now - (s.lastActive||0) > SESSION_TTL) userSessions.delete(id);
}, 30_000);

/* ==================== SESSION ==================== */
function getSession(senderId) {
  if (!userSessions.has(senderId)) {
    userSessions.set(senderId, {
      lastProduct: null,
      lastIntent: null,
      history: [],           // { role: "user"|"assistant", content: string }[]
      state: "browsing",     // browsing | product_viewed | collecting_info
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

function addHistory(session, role, content) {
  session.history.push({ role, content });
  if (session.history.length > 20) session.history.shift();
}

/* ==================== PRODUCT CACHE ==================== */
let productCache   = { data: [], time: 0 };
let fetchingLock   = null;
const CACHE_TTL    = 30_000;

async function fetchProducts() {
  if (fetchingLock) return fetchingLock;
  fetchingLock = (async () => {
    const now = Date.now();
    if (now - productCache.time < CACHE_TTL && productCache.data.length) return productCache.data;
    try {
      const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`, {
        headers: { "x-api-key": WEBHOOK_API_KEY },
        timeout: 8000,
      });
      let data = [];
      if (Array.isArray(res.data))           data = res.data;
      else if (Array.isArray(res.data?.data)) data = res.data.data;
      else if (Array.isArray(res.data?.products)) data = res.data.products;
      if (data.length) productCache = { data, time: now };
      return data.length ? data : productCache.data;
    } catch (err) {
      console.error("Product fetch error:", err.message);
      return productCache.data;
    } finally {
      fetchingLock = null;
    }
  })();
  return fetchingLock;
}

/* ==================== FUZZY PRODUCT MATCHING ==================== */
function normalize(str) {
  return str.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein distance for typo tolerance
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function findBestProduct(products, query) {
  if (!products.length || !query) return null;
  const q = normalize(query);
  const qWords = q.split(" ").filter(w => w.length > 1);

  let best = null, bestScore = -1;

  for (const p of products) {
    const name = normalize(p.product_name || "");
    if (!name) continue;

    let score = 0;

    // Exact substring match (highest priority)
    if (q.includes(name) || name.includes(q)) score = 1.0;

    if (score < 1.0) {
      const nameWords = name.split(" ").filter(w => w.length > 1);

      // Word-level fuzzy match (handles typos)
      let wordMatchScore = 0;
      for (const nw of nameWords) {
        const bestWordMatch = Math.max(...qWords.map(qw => {
          if (qw === nw) return 1.0;
          if (qw.includes(nw) || nw.includes(qw)) return 0.85;
          const dist = levenshtein(qw, nw);
          const maxLen = Math.max(qw.length, nw.length);
          return maxLen > 0 ? Math.max(0, 1 - dist / maxLen) : 0;
        }), 0);
        wordMatchScore += bestWordMatch;
      }
      score = Math.max(score, nameWords.length ? wordMatchScore / nameWords.length : 0);
    }

    if (score > bestScore) { bestScore = score; best = p; }
  }

  return bestScore >= 0.40 ? best : null;
}

/* ==================== INTENT DETECTION ==================== */
function detectIntent(text) {
  const t = text.toLowerCase();
  const scores = { price: 0, stock: 0, color: 0, order: 0, greeting: 0, help: 0, cancel: 0 };

  if (/(price|dam|koto|দাম|কত|cost|how much|taka koto)/i.test(t))                       scores.price  += 3;
  if (/(stock|ache|available|আছে|ase|in stock|do you have|pabo|পাবো)/i.test(t))          scores.stock  += 3;
  if (/(color|colour|rong|রং|colours|colors|ki rong|কি রং)/i.test(t))                   scores.color  += 3;
  if (/(order|buy|purchase|nibo|নেব|kinbo|কিনব|lagbe|লাগবে|i want|i need|nite chai)/i.test(t)) scores.order += 3;
  if (/^(hi|hello|hey|হ্যালো|হাই|assalamualaikum|salam|aসসালামুয়ালাইকুম)$/i.test(t.trim())) scores.greeting += 3;
  if (/(help|ki ache|product list|what do you have|show me|ki product|কি আছে)/i.test(t)) scores.help   += 2;
  if (/(cancel|বাতিল|na|না|no thanks|nah)/i.test(t))                                    scores.cancel += 2;

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 0 ? top[0] : "fallback";
}

/* ==================== LANGUAGE DETECTION ==================== */
function detectLanguage(text) {
  if (/[\u0980-\u09FF]/.test(text)) return "bn";
  if (/(koto|dam|ache|nai|ki|taka|nibo|rong|lagbe|ase|pabo|chai|bolun|nite|theke)/i.test(text)) return "bl";
  return "en";
}

function L(lang, bn, bl, en) {
  if (lang === "bn") return bn;
  if (lang === "bl") return bl;
  return en;
}

/* ==================== HUMAN-LIKE AI FALLBACK ==================== */
async function getAIReply(userMessage, session, products) {
  if (!groq) return null;

  // Build product catalogue for context
  const catalogue = products.map(p =>
    `• ${p.product_name} | ${p.price_bdt || "N/A"} BDT | Colors: ${p.color || "N/A"} | ${p.stock_availability === "in_stock" ? "In Stock" : "Out of Stock"}`
  ).join("\n");

  // Build conversation history for the AI
  const messages = [
    {
      role: "system",
      content: `You are Mira, a warm and human-like shop assistant for an online Bangladeshi store.

PERSONALITY:
- Friendly, natural, slightly casual — like a real shop helper
- Use short, direct sentences. Never robotic or overly formal
- Match the user's language EXACTLY (English, Bangla, or Banglish/Roman Bangla)
- Add light warmth: "sure!", "of course!", "great choice!" — but don't overdo it

STRICT RULES:
- ONLY talk about products in the catalogue below. NEVER invent prices, colors, or stock
- If asked about something not in the catalogue, say you don't carry it and suggest similar items if possible
- Keep replies under 2 sentences unless giving product info
- For order intent, always ask for the product name first if unclear
- Never make up seller contact info

PRODUCT CATALOGUE:
${catalogue}

CURRENT CONTEXT:
- Last product discussed: ${session.lastProduct?.product_name || "none"}
- Last intent: ${session.lastIntent || "none"}
- User language: ${session.lang}`,
    },
    ...session.history.slice(-6).map(h => ({ role: h.role === "user" ? "user" : "assistant", content: h.content })),
    { role: "user", content: userMessage },
  ];

  try {
    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.45,
      max_tokens: 200,
      messages,
    });
    const reply = resp.choices[0].message.content.trim();

    // Safety: strip any hallucinated prices not in catalogue
    const hasFakePrice = /\d{3,}\s*(BDT|taka|টাকা)/i.test(reply);
    const hasFakeProduct = hasFakePrice && !products.some(p =>
      reply.toLowerCase().includes(normalize(p.product_name))
    );
    if (hasFakeProduct) {
      return L(session.lang,
        "আমি নিশ্চিত নই। প্রোডাক্টের নাম বলুন।",
        "Ami sure na. Product er naam bolun.",
        "I'm not sure about that. Can you tell me which product you're asking about?"
      );
    }
    return reply;
  } catch (err) {
    console.error("AI error:", err.message);
    return null;
  }
}

/* ==================== IMAGE ANALYSIS ==================== */
async function analyzeImage(imageUrl, products) {
  if (!groq) return { found: false, reply: null };

  try {
    const imgRes = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 10_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BizAssistBot/2.0)" },
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    // Detect content type from response
    const contentType = imgRes.headers["content-type"] || "image/jpeg";
    const mimeType = contentType.split(";")[0].trim();

    const productList = products.map(p => `- ${p.product_name}`).join("\n");

    const vision = await groq.chat.completions.create({
      model: "llama-3.2-11b-vision-preview",
      max_tokens: 60,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: `You are a product image matcher. Our shop products:\n${productList}\n\nDoes this image match any product above? If YES: reply ONLY with the exact product name. If NO: reply exactly "NO_MATCH". No other text.` },
        ],
      }],
    });

    const answer = vision.choices[0].message.content.trim();
    if (answer === "NO_MATCH" || answer === "") return { found: false, reply: null };

    const matched = findBestProduct(products, answer);
    if (matched) {
      return {
        found: true,
        product: matched,
        reply: `✅ Found it! *${matched.product_name}* — ${matched.price_bdt || "N/A"} BDT\nColors: ${matched.color || "N/A"} | ${matched.stock_availability === "in_stock" ? "In Stock 🟢" : "Out of Stock 🔴"}`,
      };
    }
    return { found: false, reply: null };
  } catch (err) {
    console.error("Image analysis error:", err.message);
    return { found: false, reply: null };
  }
}

/* ==================== ORDER ALERT ==================== */
async function sendOrderAlert(senderId, product, detailsText) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: senderId,
      product_name: product.product_name,
      message: `🧾 NEW ORDER REQUEST\n\nProduct: ${product.product_name}\nPrice: ${product.price_bdt || "N/A"} BDT\n\nCustomer Details:\n${detailsText}\n\n⚠️ Seller must confirm before processing.`,
    });
    console.log(`✅ Order alert sent: ${product.product_name}`);
  } catch (err) {
    console.error("Order alert failed:", err.message);
  }
}

/* ==================== FACEBOOK HELPERS ==================== */
async function sendTyping(senderId) {
  try {
    await axios.post(
      "https://graph.facebook.com/v19.0/me/messages",
      { recipient: { id: senderId }, sender_action: "typing_on" },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 3000 }
    );
  } catch {}
}

async function sendMessage(senderId, text, retry = 2) {
  // Facebook has a 2000 char limit per message
  const chunks = [];
  while (text.length > 1900) {
    const cut = text.lastIndexOf("\n", 1900);
    chunks.push(text.slice(0, cut > 0 ? cut : 1900));
    text = text.slice(cut > 0 ? cut : 1900).trim();
  }
  if (text.length) chunks.push(text);

  for (const chunk of chunks) {
    try {
      await axios.post(
        "https://graph.facebook.com/v19.0/me/messages",
        { recipient: { id: senderId }, message: { text: chunk } },
        { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 8000 }
      );
    } catch (err) {
      if (retry > 0) {
        await new Promise(r => setTimeout(r, 1000));
        return sendMessage(senderId, chunk, retry - 1);
      }
      console.error("FB send error:", err.response?.data || err.message);
    }
  }
}

/* ==================== PRODUCT LIST MESSAGE ==================== */
function buildProductListMessage(products, lang) {
  if (!products.length) {
    return L(lang, "এখন কোনো প্রোডাক্ট নেই।", "Ekhon kono product nai.", "No products available right now.");
  }
  const lines = products.map(p =>
    `• ${p.product_name} — ${p.price_bdt || "N/A"} BDT ${p.stock_availability === "in_stock" ? "🟢" : "🔴"}`
  ).join("\n");
  return L(lang,
    `আমাদের প্রোডাক্ট সমূহ:\n\n${lines}\n\nকোনটি সম্পর্কে জানতে চান?`,
    `Amader products:\n\n${lines}\n\nKonti niye jante chan?`,
    `Our products:\n\n${lines}\n\nWhich one would you like to know about?`
  );
}

/* ==================== MAIN MESSAGE PROCESSOR ==================== */
async function processMessage(senderId, messageText) {
  const session = getSession(senderId);
  const lang = detectLanguage(messageText);
  session.lang = lang;
  addHistory(session, "user", messageText);

  const products = await fetchProducts();
  const intent   = detectIntent(messageText);
  session.lastIntent = intent;

  /* --- ORDER DETAILS COLLECTION STATE --- */
  if (session.collectingDetails) {
    // Allow cancel mid-flow
    if (intent === "cancel" || /^(cancel|no|na|না|cancel order|বাতিল)$/i.test(messageText.trim())) {
      session.collectingDetails = false;
      session.pendingOrderProduct = null;
      session.state = "browsing";
      const reply = L(lang, "❌ অর্ডার বাতিল করা হয়েছে। অন্য কিছু জানতে চান?", "❌ Order cancel hoyeche. Ar kono help lagbe?", "❌ Order cancelled. Can I help you with anything else?");
      addHistory(session, "assistant", reply);
      return reply;
    }

    const hasPhone = /(?:\+?88)?01[3-9]\d{8}/.test(messageText) || /\d{10,14}/.test(messageText);
    const hasWords = messageText.trim().split(/\s+/).length >= 3;

    if (!hasPhone || !hasWords) {
      return L(lang,
        "⚠️ দয়া করে নাম, ঠিকানা এবং মোবাইল নাম্বার একসাথে দিন। (যেমন: রাহেলা, ঢাকা মিরপুর, 01711234567)",
        "⚠️ Name, address, phone ektu detail diye lekhen. (Jemon: Rahela, Dhaka Mirpur, 01711234567)",
        "⚠️ Please give your name, address, and phone number together.\nExample: Rahela, Mirpur Dhaka, 01711234567"
      );
    }

    const product = session.pendingOrderProduct;
    if (product) await sendOrderAlert(senderId, product, messageText);

    session.collectingDetails = false;
    session.pendingOrderProduct = null;
    session.state = "browsing";

    const reply = L(lang,
      `✅ আপনার অর্ডার রিকোয়েস্ট পাঠানো হয়েছে!\n\nSeller শীঘ্রই ফোনে যোগাযোগ করে confirm করবেন। ধন্যবাদ! 🙏`,
      `✅ Apnar order request pathano hoyeche!\n\nSeller jotojon possible phone e contact korbe. Dhonnobad! 🙏`,
      `✅ Your order request has been sent!\n\nThe seller will call you to confirm soon. Thank you! 🙏`
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  /* --- GREETING --- */
  if (intent === "greeting") {
    const reply = L(lang,
      `হ্যালো! 👋 আমি Mira, আপনার শপ এসিস্ট্যান্ট।\n\nআমাদের প্রোডাক্ট দেখতে "list" লিখুন, অথবা সরাসরি যে প্রোডাক্ট চান বলুন!`,
      `Hello! 👋 Ami Mira, apnar shop assistant.\n\nAmader products dekhte "list" likhun, othoba je product chai segulo bolun!`,
      `Hey! 👋 I'm Mira, your shop assistant.\n\nType "list" to see all our products, or just ask about any specific product!`
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  /* --- PRODUCT LIST --- */
  if (intent === "help" || /^(list|show|products|ki ache|সব|all|দেখাও)$/i.test(messageText.trim())) {
    const reply = buildProductListMessage(products, lang);
    addHistory(session, "assistant", reply);
    return reply;
  }

  /* --- PRODUCT LOOKUP --- */
  let product = findBestProduct(products, messageText);

  // Smart context resolution: "eta / this / same" → use last product
  const contextWords = /^(eta|this|ota|eita|same|that|ata|ta|eti|ei ta|seta|oita)$/i;
  if (!product && session.lastProduct && contextWords.test(messageText.trim())) {
    // Only use context if last assistant message was about a product
    const lastAssistant = session.history.filter(h => h.role === "assistant").pop()?.content || "";
    if (lastAssistant.toLowerCase().includes(normalize(session.lastProduct.product_name))) {
      product = session.lastProduct;
    }
  }

  if (product) {
    session.lastProduct = product;
    session.state = "product_viewed";
    const name    = product.product_name;
    const price   = product.price_bdt || "N/A";
    const color   = product.color || "N/A";
    const inStock = product.stock_availability === "in_stock";
    const stockTxt = inStock ? "🟢 In Stock" : "🔴 Out of Stock";

    let reply;
    switch (intent) {
      case "price":
        reply = L(lang,
          `${name} এর দাম ${price} টাকা। ${inStock ? "এখন available! 🟢" : ""}`,
          `${name} er dam ${price} taka. ${inStock ? "Ekhon available! 🟢" : ""}`,
          `${name} is ${price} BDT. ${inStock ? "Currently in stock! 🟢" : ""}`
        );
        break;
      case "color":
        reply = L(lang,
          `${name} এর available রং: ${color}`,
          `${name} er available colors: ${color}`,
          `${name} available colors: ${color}`
        );
        break;
      case "stock":
        reply = L(lang,
          inStock ? `হ্যাঁ! ${name} এখন available আছে। 🟢 দাম: ${price} টাকা।` : `দুঃখিত, ${name} এখন stock এ নেই। 🔴`,
          inStock ? `Ha! ${name} ekhon available. 🟢 Dam: ${price} taka.` : `Sorry, ${name} ekhon stock e nai. 🔴`,
          inStock ? `Yes! ${name} is currently in stock. 🟢 Price: ${price} BDT.` : `Sorry, ${name} is currently out of stock. 🔴`
        );
        break;
      case "order":
        session.collectingDetails = true;
        session.pendingOrderProduct = product;
        session.state = "collecting_info";
        reply = L(lang,
          `🛒 "${name}" অর্ডার করতে চান — দারুণ choice!\n\nদয়া করে এক message এ দিন:\n• আপনার নাম\n• ঠিকানা\n• মোবাইল নাম্বার\n\nSeller ফোনে confirm করবেন। বাতিল করতে "cancel" লিখুন।`,
          `🛒 "${name}" order — sundor choice!\n\nEk message e din:\n• Name\n• Address\n• Phone number\n\nSeller phone e confirm korbe. Cancel korte "cancel" likhun.`,
          `🛒 Great choice! You want to order "${name}".\n\nPlease send in one message:\n• Your name\n• Address\n• Phone number\n\nThe seller will confirm by phone. Type "cancel" to cancel.`
        );
        break;
      default:
        reply = L(lang,
          `*${name}*\n💰 দাম: ${price} টাকা\n🎨 রং: ${color}\n📦 ${stockTxt}\n\nঅর্ডার করতে "order" লিখুন!`,
          `*${name}*\n💰 Dam: ${price} taka\n🎨 Color: ${color}\n📦 ${stockTxt}\n\nOrder korte "order" likhun!`,
          `*${name}*\n💰 Price: ${price} BDT\n🎨 Colors: ${color}\n📦 ${stockTxt}\n\nType "order" to place an order!`
        );
    }
    addHistory(session, "assistant", reply);
    return reply;
  }

  /* --- NO PRODUCT FOUND: ORDER INTENT --- */
  if (intent === "order") {
    const reply = L(lang,
      "কোন প্রোডাক্টটি অর্ডার করতে চান? প্রোডাক্টের নাম বলুন, অথবা \"list\" লিখে সব দেখুন।",
      "Kon product order korte chan? Naam bolun, othoba \"list\" likhun.",
      "Which product would you like to order? Tell me the name or type \"list\" to see all products."
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  /* --- AI FALLBACK (human-like, grounded) --- */
  const aiReply = await getAIReply(messageText, session, products);
  if (aiReply) {
    addHistory(session, "assistant", aiReply);
    return aiReply;
  }

  // Final fallback
  const fallback = L(lang,
    "আমি বুঝতে পারিনি। প্রোডাক্টের নাম বলুন বা \"list\" লিখুন।",
    "Bujhte parini. Product er naam bolun ba \"list\" likhun.",
    "I didn't quite get that. Tell me a product name or type \"list\" to see all products."
  );
  addHistory(session, "assistant", fallback);
  return fallback;
}

/* ==================== WEBHOOK HANDLERS ==================== */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.send(req.query["hub.challenge"]);
  console.warn("❌ Webhook verification failed");
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Always respond fast to FB

  try {
    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;

        const senderId   = event.sender.id;
        const messageId  = event.message.mid;
        const text       = event.message.text?.trim() || "";
        const attachments = event.message.attachments;

        // Deduplication
        if (processedMessages.has(messageId)) continue;
        processedMessages.set(messageId, Date.now());

        // Rate limiting per user
        const lastTime = userCooldown.get(senderId) || 0;
        if (Date.now() - lastTime < COOLDOWN_MS) continue;
        userCooldown.set(senderId, Date.now());

        sendTyping(senderId); // non-blocking

        let reply = "";

        if (attachments?.length && attachments[0].type === "image") {
          const products = await fetchProducts();
          const imageUrl = attachments[0].payload.url;
          console.log(`📸 Image received from ${senderId}`);
          const analysis = await analyzeImage(imageUrl, products);

          if (analysis.found) {
            reply = analysis.reply;
            // Update session with found product
            const session = getSession(senderId);
            session.lastProduct = analysis.product;
            session.state = "product_viewed";
            addHistory(session, "assistant", reply);
          } else {
            const session = getSession(senderId);
            reply = L(session.lang,
              "এই ছবির প্রোডাক্টটি আমাদের শপে নেই। 😔 প্রোডাক্টের নাম বলুন বা \"list\" লিখুন।",
              "Ei product amader shop e nai. 😔 Naam bolun ba \"list\" likhun.",
              "This product isn't in our shop. 😔 Tell me a product name or type \"list\" to see what we have."
            );
          }
        } else if (text) {
          reply = await processMessage(senderId, text);
        }

        if (reply) await sendMessage(senderId, reply);
      }
    }
  } catch (err) {
    console.error("Webhook error:", err.message, err.stack);
  }
});

/* ==================== HEALTH CHECK ==================== */
app.get("/", (req, res) => res.json({
  status: "✅ BizAssist AI v2.0 Running",
  uptime: process.uptime(),
  cached_products: productCache.data.length,
  active_sessions: userSessions.size,
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BizAssist v2.0 running on port ${PORT}`));
