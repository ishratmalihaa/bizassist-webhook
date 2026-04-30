const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

/* ==================== CONFIG ==================== */
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || "bizassist123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";  // fallback (optional)
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY || "";
const GROQ_API_KEY    = process.env.GROQ_API_KEY    || "";
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;

if (!PAGE_ACCESS_TOKEN) console.warn("⚠️ PAGE_ACCESS_TOKEN missing – will only work with connected pages");
if (!WEBHOOK_API_KEY)   { console.error("❌ Missing WEBHOOK_API_KEY"); process.exit(1); }
if (!GROQ_API_KEY)      console.warn("⚠️ GROQ_API_KEY missing – AI & image disabled");
if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) console.warn("⚠️ Facebook OAuth env vars missing – Connect button won't work");

const SELLER_ID   = process.env.SELLER_ID   || "67f55dc2-41e9-410c-8c6b-289ebee08118";
const BASE_URL    = process.env.BASE_URL    || "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${BASE_URL}/api/public/get-products`;
const ALERT_URL    = `${BASE_URL}/api/public/order-alert`;

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

/* ==================== IN-MEMORY TOKEN STORAGE (multi‑user) ==================== */
const pageTokens = new Map();        // page_id → page_access_token
const sellerPages = new Map();       // seller_id → array of page_ids

async function savePageToken(sellerId, pageId, pageName, pageToken) {
  pageTokens.set(pageId, pageToken);
  if (!sellerPages.has(sellerId)) sellerPages.set(sellerId, []);
  sellerPages.get(sellerId).push(pageId);
  console.log(`✅ Saved page: ${pageName} (${pageId}) for seller ${sellerId}`);
}

async function getPageToken(pageId) {
  return pageTokens.get(pageId) || null;
}

/* ==================== MEMORY & SESSION ==================== */
const processedMessages = new Map();
const userCooldown      = new Map();
const userSessions      = new Map();

const MESSAGE_TTL = 60000;
const COOLDOWN_MS = 800;
const SESSION_TTL = 3600000;

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of processedMessages) if (now - t > MESSAGE_TTL) processedMessages.delete(id);
  for (const [id, t] of userCooldown)      if (now - t > MESSAGE_TTL) userCooldown.delete(id);
  for (const [id, s] of userSessions)      if (now - (s.lastActive||0) > SESSION_TTL) userSessions.delete(id);
}, 30000);

function getSession(senderId) {
  if (!userSessions.has(senderId)) {
    userSessions.set(senderId, {
      lastProduct: null,
      lastIntent: null,
      history: [],
      state: "browsing",
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
const CACHE_TTL    = 30000;

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
      if (Array.isArray(res.data))              data = res.data;
      else if (Array.isArray(res.data?.data))   data = res.data.data;
      else if (Array.isArray(res.data?.products)) data = res.data.products;
      if (data.length) productCache = { data, time: now };
      return data.length ? data : productCache.data;
    } catch (err) {
      console.error("Product fetch error:", err.message);
      return productCache.data;
    } finally { fetchingLock = null; }
  })();
  return fetchingLock;
}

/* ==================== FUZZY MATCH ==================== */
function normalize(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m+1 }, (_, i) => Array.from({ length: n+1 }, (_, j) => i===0 ? j : j===0 ? i : 0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
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
    if (q.includes(name) || name.includes(q)) score = 1.0;
    if (score < 1.0) {
      const nameWords = name.split(" ").filter(w => w.length > 1);
      let wordMatchScore = 0;
      for (const nw of nameWords) {
        const bestWord = Math.max(...qWords.map(qw => {
          if (qw === nw) return 1.0;
          if (qw.includes(nw) || nw.includes(qw)) return 0.85;
          const dist = levenshtein(qw, nw);
          const maxLen = Math.max(qw.length, nw.length);
          return maxLen > 0 ? Math.max(0, 1 - dist/maxLen) : 0;
        }), 0);
        wordMatchScore += bestWord;
      }
      score = Math.max(score, nameWords.length ? wordMatchScore/nameWords.length : 0);
    }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 0.40 ? best : null;
}

/* ==================== INTENT & LANGUAGE ==================== */
function detectIntent(text) {
  const t = text.toLowerCase();
  const scores = { price: 0, stock: 0, color: 0, order: 0, greeting: 0, help: 0, cancel: 0 };
  if (/(price|dam|koto|দাম|কত|cost|how much|taka koto)/i.test(t))                             scores.price   += 3;
  if (/(stock|ache|available|আছে|ase|in stock|do you have|pabo|পাবো)/i.test(t))               scores.stock   += 3;
  if (/(color|colour|rong|রং|colours|colors|ki rong|কি রং)/i.test(t))                        scores.color   += 3;
  if (/(order|buy|purchase|nibo|নেব|kinbo|কিনব|lagbe|লাগবে|i want|i need|nite chai|amr order|আমার অর্ডার)/i.test(t)) scores.order += 3;
  if (/^(hi|hello|hey|হ্যালো|হাই|assalamualaikum|salam)$/i.test(t.trim()))                   scores.greeting += 3;
  if (/(help|ki ache|product list|what do you have|show me|ki product|কি আছে)/i.test(t))      scores.help    += 2;
  if (/(cancel|বাতিল|no thanks|nah)/i.test(t))                                               scores.cancel  += 2;
  const top = Object.entries(scores).sort((a,b) => b[1]-a[1])[0];
  return top[1] > 0 ? top[0] : "fallback";
}

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

/* ==================== AI FALLBACK ==================== */
async function getAIReply(userMessage, session, products) {
  if (!groq) return null;
  const catalogue = products.map(p =>
    `• ${p.product_name} | ${p.price_bdt||"N/A"} BDT | Colors: ${p.color||"N/A"} | ${p.stock_availability==="in_stock"?"In Stock":"Out of Stock"}`
  ).join("\n");
  const messages = [
    { role: "system", content: `You are Mira, a warm shop assistant. Match user language. ONLY discuss products in catalogue:\n${catalogue}\nLast product: ${session.lastProduct?.product_name||"none"}` },
    ...session.history.slice(-6).map(h => ({ role: h.role==="user"?"user":"assistant", content: h.content })),
    { role: "user", content: userMessage },
  ];
  try {
    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.45,
      max_tokens: 200,
      messages,
    });
    return resp.choices[0].message.content.trim();
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
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mimeType = (imgRes.headers["content-type"] || "image/jpeg").split(";")[0].trim();
    const productList = products.map(p => `- ${p.product_name}`).join("\n");

    const vision = await groq.chat.completions.create({
      model: "llama-3.2-11b-vision-preview",
      max_tokens: 80,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: `Our products:\n${productList}\n\nDoes this image match any product? Reply ONLY with product name or "NO_MATCH".` },
        ],
      }],
    });

    const answer = vision.choices[0].message.content.trim();
    if (answer === "NO_MATCH" || !answer) return { found: false, reply: null };

    const matched = findBestProduct(products, answer);
    if (matched) {
      return {
        found: true,
        product: matched,
        reply: `✅ Found it! *${matched.product_name}* — ${matched.price_bdt||"N/A"} BDT\nColors: ${matched.color||"N/A"} | ${matched.stock_availability==="in_stock"?"In Stock 🟢":"Out of Stock 🔴"}\n\nType "order" to buy!`,
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
  const payload = {
    secret: WEBHOOK_API_KEY,
    seller_id: SELLER_ID,
    customer_fb_id: senderId,
    product_name: product.product_name,
    message: `🧾 NEW ORDER REQUEST\nProduct: ${product.product_name}\nPrice: ${product.price_bdt||"N/A"} BDT\nCustomer: ${detailsText}\n\n⚠️ Seller must confirm before processing.`,
  };
  console.log("📦 Order alert payload:", JSON.stringify(payload));
  try {
    const res = await axios.post(ALERT_URL, payload, {
      headers: { "Content-Type": "application/json", "x-api-key": WEBHOOK_API_KEY },
      timeout: 10000,
    });
    console.log("✅ Order alert sent:", res.status);
  } catch (err) {
    console.error("Order alert failed:", err.response?.data || err.message);
  }
}

/* ==================== FACEBOOK HELPERS ==================== */
async function sendTyping(senderId) {
  try {
    await axios.post("https://graph.facebook.com/v19.0/me/messages",
      { recipient: { id: senderId }, sender_action: "typing_on" },
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 3000 });
  } catch {}
}

async function sendMessage(senderId, text, pageToken = null, retry = 2) {
  const token = pageToken || PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error("No token available to send message");
    return;
  }
  let t = text;
  const chunks = [];
  while (t.length > 1900) {
    const cut = t.lastIndexOf("\n", 1900);
    chunks.push(t.slice(0, cut > 0 ? cut : 1900));
    t = t.slice(cut > 0 ? cut : 1900).trim();
  }
  if (t.length) chunks.push(t);
  for (const chunk of chunks) {
    try {
      await axios.post("https://graph.facebook.com/v19.0/me/messages",
        { recipient: { id: senderId }, message: { text: chunk } },
        { params: { access_token: token }, timeout: 8000 });
    } catch (err) {
      if (retry > 0) {
        await new Promise(r => setTimeout(r, 1000));
        return sendMessage(senderId, chunk, token, retry - 1);
      }
      console.error("FB send error:", err.response?.data || err.message);
    }
  }
}

/* ==================== PRODUCT LIST ==================== */
function buildProductList(products, lang) {
  if (!products.length) return L(lang, "এখন কোনো প্রোডাক্ট নেই।", "Ekhon kono product nai.", "No products right now.");
  const lines = products.map(p => `• ${p.product_name} — ${p.price_bdt||"N/A"} BDT ${p.stock_availability==="in_stock"?"🟢":"🔴"}`).join("\n");
  return L(lang,
    `আমাদের প্রোডাক্ট:\n\n${lines}\n\nকোনটি সম্পর্কে জানতে চান?`,
    `Amader products:\n\n${lines}\n\nKonti niye jante chan?`,
    `Our products:\n\n${lines}\n\nWhich one would you like?`
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

  // Order details collection state
  if (session.collectingDetails) {
    if (intent === "cancel" || /^(cancel|no|na|না|বাতিল)$/i.test(messageText.trim())) {
      session.collectingDetails = false;
      session.pendingOrderProduct = null;
      session.state = "browsing";
      const reply = L(lang, "❌ অর্ডার বাতিল করা হয়েছে।", "❌ Order cancel hoyeche.", "❌ Order cancelled.");
      addHistory(session, "assistant", reply);
      return reply;
    }
    const hasPhone = /(?:\+?88)?01[3-9]\d{8}/.test(messageText) || /\d{10,14}/.test(messageText);
    const hasWords = messageText.trim().split(/\s+/).length >= 3;
    if (!hasPhone || !hasWords) {
      return L(lang,
        "⚠️ দয়া করে নাম, ঠিকানা এবং মোবাইল নাম্বার একসাথে দিন।\nযেমন: মালিহা, সিলেট, 01911413567",
        "⚠️ Name, address, phone din ekti message e.\nJemon: Maliha, Sylhet, 01911413567",
        "⚠️ Please send your name, address and phone number in one message.\nExample: Maliha, Sylhet, 01911413567"
      );
    }
    const product = session.pendingOrderProduct;
    if (product) await sendOrderAlert(senderId, product, messageText);
    session.collectingDetails = false;
    session.pendingOrderProduct = null;
    session.state = "browsing";
    const reply = L(lang,
      `✅ অর্ডার রিকোয়েস্ট পাঠানো হয়েছে!\n\n📦 প্রোডাক্ট: ${product.product_name}\n💰 দাম: ${product.price_bdt || "N/A"} BDT\n\nSeller আপনার সাথে যোগাযোগ করে confirm করবেন। ধন্যবাদ! 🙏`,
      `✅ Order request pathano hoyeche!\n\n📦 Product: ${product.product_name}\n💰 Price: ${product.price_bdt || "N/A"} BDT\n\nSeller apnar sathe jogajog kore confirm korbe. Dhonnobad! 🙏`,
      `✅ Order request sent!\n\n📦 Product: ${product.product_name}\n💰 Price: ${product.price_bdt || "N/A"} BDT\n\nThe seller will contact you to confirm. Thank you! 🙏`
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  // Greeting
  if (intent === "greeting") {
    const reply = L(lang,
      `হ্যালো! 👋 আমি Mira। "list" লিখুন সব প্রোডাক্ট দেখতে!`,
      `Hello! 👋 Ami Mira. "list" likhun products dekhte!`,
      `Hey! 👋 I'm Mira. Type "list" to see all products!`
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  // Product list
  if (intent === "help" || /^(list|show|products|ki ache|সব|all|দেখাও)$/i.test(messageText.trim())) {
    const reply = buildProductList(products, lang);
    addHistory(session, "assistant", reply);
    return reply;
  }

  // Product lookup
  let product = findBestProduct(products, messageText);
  const contextWords = /^(eta|this|ota|eita|same|that|ata|ta|ei ta|seta)$/i;
  if (!product && session.lastProduct && contextWords.test(messageText.trim())) {
    product = session.lastProduct;
  }

  if (product) {
    session.lastProduct = product;
    session.state = "product_viewed";
    const { product_name: name, price_bdt: price = "N/A", color = "N/A" } = product;
    const inStock  = product.stock_availability === "in_stock";
    const stockTxt = inStock ? "🟢 In Stock" : "🔴 Out of Stock";

    if (intent === "order") {
      session.collectingDetails    = true;
      session.pendingOrderProduct  = product;
      session.state                = "collecting_info";
      const reply = L(lang,
        `🛒 "${name}" অর্ডার করতে এক message এ দিন:\n• নাম\n• ঠিকানা\n• মোবাইল নাম্বার\n\nবাতিল করতে "cancel" লিখুন।`,
        `🛒 "${name}" order er jonno ek message e din:\n• Name\n• Address\n• Phone\n\nCancel korte "cancel" likhun.`,
        `🛒 To order "${name}", send one message with:\n• Name\n• Address\n• Phone number\n\nType "cancel" to cancel.`
      );
      addHistory(session, "assistant", reply);
      return reply;
    }

    let reply;
    switch (intent) {
      case "price":
        reply = L(lang,
          `${name} এর দাম ${price} টাকা।${inStock?" এখন available! 🟢":""}`,
          `${name} er price ${price} taka.${inStock?" Ekhon available! 🟢":""}`,
          `${name} costs ${price} BDT.${inStock?" In stock! 🟢":""}`
        ); break;
      case "color":
        reply = L(lang, `${name} এর রং: ${color}`, `${name} er colors: ${color}`, `${name} colors: ${color}`);
        break;
      case "stock":
        reply = L(lang,
          inStock?`হ্যাঁ! ${name} আছে। 🟢 দাম: ${price} টাকা।`:`দুঃখিত, ${name} নেই। 🔴`,
          inStock?`Ha! ${name} ache. 🟢 Price: ${price} taka.`:`Sorry, ${name} nai. 🔴`,
          inStock?`Yes! ${name} in stock. 🟢 Price: ${price} BDT.`:`Sorry, ${name} out of stock. 🔴`
        ); break;
      default:
        reply = L(lang,
          `*${name}*\n💰 ${price} টাকা\n🎨 ${color}\n📦 ${stockTxt}\n\nঅর্ডার করতে "order" লিখুন!`,
          `*${name}*\n💰 ${price} taka\n🎨 ${color}\n📦 ${stockTxt}\n\nOrder korte "order" likhun!`,
          `*${name}*\n💰 ${price} BDT\n🎨 ${color}\n📦 ${stockTxt}\n\nType "order" to buy!`
        );
    }
    addHistory(session, "assistant", reply);
    return reply;
  }

  // Order without product
  if (intent === "order") {
    const reply = L(lang,
      "কোন প্রোডাক্ট অর্ডার করতে চান? “list” লিখে সব দেখুন।",
      "Kon product order korte chan? “list” likhe dekhte paren?",
      "Which product would you like to order? Type “list” to see all."
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  // AI fallback
  const aiReply = await getAIReply(messageText, session, products);
  if (aiReply) {
    addHistory(session, "assistant", aiReply);
    return aiReply;
  }

  const fallback = L(lang,
    "একটু বুঝতে পারিনি! কোন প্রোডাক্ট সম্পর্কে জানতে চান? 😊",
    "Ektu bujhte parini! Kon product somproke jante chan? 😊",
    "I didn't quite get that! Which product would you like to know about? 😊"
  );
  addHistory(session, "assistant", fallback);
  return fallback;
}

/* ==================== FACEBOOK OAUTH CALLBACK ==================== */
app.get("/auth/facebook/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    console.error("Missing code or state in callback");
    return res.redirect("https://talk-to-seller-ai.lovable.app/integrations?error=missing");
  }

  try {
    // Exchange code for user access token
    const tokenRes = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: {
        client_id: FACEBOOK_APP_ID,
        client_secret: FACEBOOK_APP_SECRET,
        redirect_uri: "https://talk-to-seller-ai.lovable.app/integrations",
        code,
      },
    });
    const userToken = tokenRes.data.access_token;

    // Get user's pages
    const pagesRes = await axios.get("https://graph.facebook.com/v19.0/me/accounts", {
      params: { access_token: userToken },
    });
    const pages = pagesRes.data.data;

    // Save each page to memory
    for (const page of pages) {
      await savePageToken(state, page.id, page.name, page.access_token);
    }

    res.redirect("https://talk-to-seller-ai.lovable.app/integrations?success=true");
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.redirect("https://talk-to-seller-ai.lovable.app/integrations?error=auth_failed");
  }
});

/* ==================== WEBHOOK ==================== */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;

        const senderId   = event.sender.id;
        const messageId  = event.message.mid;
        const text       = event.message.text?.trim() || "";
        const attachments = event.message.attachments;
        const pageId     = entry.id;   // Facebook page that received the message

        if (processedMessages.has(messageId)) continue;
        processedMessages.set(messageId, Date.now());

        const lastTime = userCooldown.get(senderId) || 0;
        if (Date.now() - lastTime < COOLDOWN_MS) continue;
        userCooldown.set(senderId, Date.now());

        sendTyping(senderId);
        let reply = "";

        // Image handling
        if (attachments?.length && attachments[0].type === "image") {
          const products = await fetchProducts();
          const imageUrl = attachments[0].payload.url;
          const analysis = await analyzeImage(imageUrl, products);
          if (analysis.found) {
            reply = analysis.reply;
            const sess = getSession(senderId);
            sess.lastProduct = analysis.product;
            sess.state = "product_viewed";
            addHistory(sess, "assistant", reply);
          } else {
            const sess = getSession(senderId);
            reply = L(sess.lang,
              "এই পণ্যটি আমাদের কাছে নেই। অন্য কিছু দেখতে চান? 😊",
              "Ei pọnno amader kache nai. Onno kisu dekhte chan? 😊",
              "This product isn't in our shop. Would you like to see something else? 😊"
            );
          }
        } else if (text) {
          reply = await processMessage(senderId, text);
        }

        if (reply) {
          // Get the page-specific token (from memory) or fallback to global
          const token = await getPageToken(pageId) || PAGE_ACCESS_TOKEN;
          if (token) {
            await sendMessage(senderId, reply, token);
          } else {
            console.error(`No token available for page ${pageId}`);
          }
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err.message, err.stack);
  }
});

app.get("/", (req, res) => res.json({
  status: "✅ BizAssist v4.0 (Multi‑User in‑memory)",
  uptime: process.uptime(),
  cached_products: productCache.data.length,
  active_sessions: userSessions.size,
  connected_pages: pageTokens.size,
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BizAssist v4.0 running on port ${PORT}`));
