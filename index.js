const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

/* ==================== CONFIG ==================== */
const VERIFY_TOKEN        = process.env.VERIFY_TOKEN        || "bizassist123";
const WEBHOOK_API_KEY     = process.env.WEBHOOK_API_KEY     || "";
const GROQ_API_KEY        = process.env.GROQ_API_KEY        || "";
const FACEBOOK_APP_ID     = process.env.FACEBOOK_APP_ID     || "";
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || "";

if (!WEBHOOK_API_KEY) { console.error("❌ Missing WEBHOOK_API_KEY"); process.exit(1); }
if (!GROQ_API_KEY)    console.warn("⚠️ GROQ_API_KEY missing - AI disabled");
if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) console.warn("⚠️ Facebook OAuth not configured");

const SELLER_ID    = process.env.SELLER_ID || "67f55dc2-41e9-410c-8c6b-289ebee08118";
const BASE_URL     = "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${BASE_URL}/api/public/get-products`;
const ALERT_URL    = `${BASE_URL}/api/public/order-alert`;
const FRONTEND_URL = "https://talk-to-seller-ai.lovable.app";

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

/* ==================== MULTI-USER TOKEN STORAGE ==================== */
const pageTokens  = new Map(); // pageId → token
const sellerPages = new Map(); // sellerId → [pageIds]

async function savePageToken(sellerId, pageId, pageName, token) {
  // Save in memory (for current session)
  pageTokens.set(pageId, token);
  if (!sellerPages.has(sellerId)) sellerPages.set(sellerId, []);
  if (!sellerPages.get(sellerId).includes(pageId)) {
    sellerPages.get(sellerId).push(pageId);
  }
  
  console.log(`✅ Saved to memory: ${pageName} (${pageId}) for seller ${sellerId}`);
  
  // Save to database (persistent)
  try {
    await axios.patch(`${BASE_URL}/api/sellers/${sellerId}`, {
      page_id: pageId,
      page_access_token: token,
    }, {
      headers: { 
        "Content-Type": "application/json",
        "x-api-key": WEBHOOK_API_KEY 
      },
      timeout: 8000,
    });
    console.log(`✅ Saved to DB: ${pageName} (${pageId})`);
  } catch (err) {
    console.error("❌ Failed to save token to DB:", err.response?.data || err.message);
  }
}

async function getPageToken(pageId) {
  // Check memory first
  if (pageTokens.has(pageId)) {
    return pageTokens.get(pageId);
  }
  
  // If not in memory, fetch from database
  try {
    const res = await axios.get(`${BASE_URL}/api/public/get-sellers`, {
      headers: { "x-api-key": WEBHOOK_API_KEY },
      timeout: 8000,
    });
    
    // Find the seller with matching page_id
    const sellers = res.data || [];
    const seller = sellers.find(s => s.page_id === pageId);
    
    if (seller?.page_access_token) {
      // Save to memory for faster access
      pageTokens.set(pageId, seller.page_access_token);
      console.log(`✅ Loaded token from DB for page ${pageId}`);
      return seller.page_access_token;
    }
  } catch (err) {
    console.error("❌ Failed to fetch token from DB:", err.response?.data || err.message);
  }
  
  return null;
}

/* ==================== LOAD ALL TOKENS ON STARTUP ==================== */
async function loadAllTokensFromDB() {
  try {
    console.log("🔄 Loading tokens from database...");
    const res = await axios.get(`${BASE_URL}/api/public/get-sellers`, {
      headers: { "x-api-key": WEBHOOK_API_KEY },
      timeout: 10000,
    });
    
    const sellers = res.data || [];
    let loaded = 0;
    
    for (const seller of sellers) {
      if (seller.page_id && seller.page_access_token) {
        pageTokens.set(seller.page_id, seller.page_access_token);
        
        if (!sellerPages.has(seller.seller_id)) {
          sellerPages.set(seller.seller_id, []);
        }
        if (!sellerPages.get(seller.seller_id).includes(seller.page_id)) {
          sellerPages.get(seller.seller_id).push(seller.page_id);
        }
        
        loaded++;
        console.log(`  ✓ Loaded token for page ${seller.page_id} (seller: ${seller.seller_id})`);
      }
    }
    
    console.log(`✅ Loaded ${loaded} page tokens from database`);
  } catch (err) {
    console.error("❌ Failed to load tokens from DB:", err.response?.data || err.message);
  }
}

/* ==================== MEMORY ==================== */
const processedMessages = new Map();
const userCooldown      = new Map();
const userSessions      = new Map();

const COOLDOWN_MS = 800;
const SESSION_TTL = 3600000;

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of processedMessages) if (now - t > 60000) processedMessages.delete(id);
  for (const [id, t] of userCooldown)      if (now - t > 60000) userCooldown.delete(id);
  for (const [id, s] of userSessions)      if (now - (s.lastActive||0) > SESSION_TTL) userSessions.delete(id);
}, 30000);

function getSession(id) {
  if (!userSessions.has(id)) {
    userSessions.set(id, {
      lastProduct: null,
      history: [],
      state: "browsing",
      collectingDetails: false,
      pendingOrderProduct: null,
      lang: "en",
      lastActive: Date.now(),
    });
  }
  const s = userSessions.get(id);
  s.lastActive = Date.now();
  return s;
}

function addHistory(session, role, content) {
  session.history.push({ role, content });
  if (session.history.length > 10) session.history.shift();
}

/* ==================== PRODUCT CACHE ==================== */
let productCache = { data: [], time: 0 };
let fetchingLock = null;
const CACHE_TTL  = 30000;

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
      if (Array.isArray(res.data))                data = res.data;
      else if (Array.isArray(res.data?.data))     data = res.data.data;
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
  const dp = Array.from({ length: m+1 }, (_, i) => Array.from({ length: n+1 }, (_, j) => i===0?j:j===0?i:0));
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
        const bw = Math.max(...qWords.map(qw => {
          if (qw === nw) return 1.0;
          if (qw.includes(nw) || nw.includes(qw)) return 0.85;
          const dist = levenshtein(qw, nw);
          const maxLen = Math.max(qw.length, nw.length);
          return maxLen > 0 ? Math.max(0, 1 - dist/maxLen) : 0;
        }), 0);
        wordMatchScore += bw;
      }
      score = Math.max(score, nameWords.length ? wordMatchScore/nameWords.length : 0);
    }
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 0.40 ? best : null;
}

/* ==================== LANGUAGE ==================== */
function detectLanguage(text) {
  if (/[\u0980-\u09FF]/.test(text)) return "bn";
  if (/(koto|dam|ache|nai|ki|taka|nibo|rong|lagbe|ase|pabo|chai|bolun|nite|theke)/i.test(text)) return "bl";
  return "en";
}

function L(lang, bn, bl, en) {
  return lang === "bn" ? bn : lang === "bl" ? bl : en;
}

/* ==================== SMART AI (NO HARDCODED RESPONSES) ==================== */
async function getSmartReply(userMessage, session, products) {
  if (!groq) {
    return "দুঃখিত, আমি এখন AI ছাড়া চলছি। প্রোডাক্টের নাম বলুন বা 'list' লিখুন।";
  }

  const catalogue = products.map(p =>
    `${p.product_name} - ${p.price_bdt||"N/A"} BDT - Colors: ${p.color||"N/A"} - ${p.stock_availability==="in_stock"?"In Stock":"Out of Stock"}`
  ).join("\n");

  const systemPrompt = `You are Mira, a friendly Bangladeshi shop assistant. You're helpful, warm, and natural - like a real person chatting on Messenger.

STRICT RULES:
1. Match the user's language EXACTLY (Bangla/Banglish/English)
2. Be conversational and natural - NO robotic phrases like "order korte order likhun"
3. If user asks about price, tell the price naturally
4. If user asks about color, tell the color naturally
5. If user wants to order, ask for their details (name, address, phone) in ONE message
6. NEVER say "type order" or "likhun" - just guide them naturally
7. Keep replies SHORT (1-2 sentences max)
8. If asked about something not in the catalogue, say you don't have it and suggest similar products

PRODUCTS IN STOCK:
${catalogue}

CONVERSATION CONTEXT:
Last product: ${session.lastProduct?.product_name || "none"}
User's state: ${session.state}`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...session.history.slice(-6),
    { role: "user", content: userMessage },
  ];

  try {
    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.5,
      max_tokens: 180,
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
  if (!groq) return { found: false, reply: "এই পণ্যটি আমাদের কাছে নেই। অন্য কিছু দেখতে চান? 😊" };
  try {
    const imgRes = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mimeType = (imgRes.headers["content-type"]||"image/jpeg").split(";")[0].trim();
    const productList = products.map(p => `- ${p.product_name}`).join("\n");

    const vision = await groq.chat.completions.create({
      model: "llama-3.2-11b-vision-preview",
      max_tokens: 80,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: `Shop products:\n${productList}\n\nMatch this image to a product. Reply ONLY with exact product name or "NO_MATCH".` },
        ],
      }],
    });

    const answer = vision.choices[0].message.content.trim();
    if (!answer || answer === "NO_MATCH") return { found: false, reply: null };

    const matched = findBestProduct(products, answer);
    if (matched) {
      return {
        found: true,
        product: matched,
        reply: `✅ পেয়ে গেছি! ${matched.product_name}\n💰 ${matched.price_bdt||"N/A"} BDT\n🎨 ${matched.color||"N/A"}\n📦 ${matched.stock_availability==="in_stock"?"In Stock 🟢":"Out of Stock 🔴"}`,
      };
    }
    return { found: false, reply: null };
  } catch (err) {
    console.error("Image error:", err.message);
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
      message: `🧾 নতুন অর্ডার!\nProduct: ${product.product_name}\nPrice: ${product.price_bdt||"N/A"} BDT\nCustomer: ${detailsText}`,
    }, {
      headers: { "Content-Type": "application/json", "x-api-key": WEBHOOK_API_KEY },
      timeout: 10000,
    });
    console.log(`✅ Order alert sent: ${product.product_name}`);
  } catch (err) {
    console.error("Order alert failed:", err.response?.data || err.message);
  }
}

/* ==================== FACEBOOK SEND ==================== */
async function sendMessage(senderId, text, token) {
  if (!token) {
    console.error(`❌ No token to send message to ${senderId}`);
    return;
  }
  
  const chunks = [];
  let t = text;
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
      console.error("FB send error:", err.response?.data || err.message);
    }
  }
}

/* ==================== MAIN MESSAGE PROCESSOR ==================== */
async function processMessage(senderId, messageText) {
  const session = getSession(senderId);
  const lang = detectLanguage(messageText);
  session.lang = lang;
  addHistory(session, "user", messageText);

  const products = await fetchProducts();

  // ORDER DETAILS COLLECTION
  if (session.collectingDetails) {
    if (/^(cancel|no|na|না|বাতিল)$/i.test(messageText.trim())) {
      session.collectingDetails = false;
      session.pendingOrderProduct = null;
      session.state = "browsing";
      const reply = "❌ অর্ডার বাতিল করা হয়েছে।";
      addHistory(session, "assistant", reply);
      return reply;
    }

    const hasPhone = /(?:\+?88)?01[3-9]\d{8}/.test(messageText) || /\d{10,14}/.test(messageText);
    const hasWords = messageText.trim().split(/\s+/).length >= 3;

    if (!hasPhone || !hasWords) {
      return L(lang,
        "⚠️ নাম, ঠিকানা এবং মোবাইল নাম্বার একসাথে দিন। যেমন: মালিহা, সিলেট, 01911413567",
        "⚠️ Name, address, phone ektu detail diye lekhen. Jemon: Maliha, Sylhet, 01911413567",
        "⚠️ Please send name, address and phone together. Example: Maliha, Sylhet, 01911413567"
      );
    }

    const product = session.pendingOrderProduct;
    if (product) await sendOrderAlert(senderId, product, messageText);

    session.collectingDetails = false;
    session.pendingOrderProduct = null;
    session.state = "browsing";

    const reply = L(lang,
      `✅ অর্ডার পাঠানো হয়েছে!\n\n📦 ${product.product_name}\n💰 ${product.price_bdt||"N/A"} BDT\n\nSeller যোগাযোগ করবেন। ধন্যবাদ! 🙏`,
      `✅ Order pathano hoyeche!\n\n📦 ${product.product_name}\n💰 ${product.price_bdt||"N/A"} BDT\n\nSeller jogajog korbe. Dhonnobad! 🙏`,
      `✅ Order sent!\n\n📦 ${product.product_name}\n💰 ${product.price_bdt||"N/A"} BDT\n\nSeller will contact you. Thank you! 🙏`
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  // CHECK IF USER WANTS TO ORDER A SPECIFIC PRODUCT
  const product = findBestProduct(products, messageText);
  const orderIntent = /(order|buy|nibo|নেব|kinbo|কিনব|nite chai|কিনতে চাই)/i.test(messageText);

  if (product && orderIntent) {
    session.collectingDetails = true;
    session.pendingOrderProduct = product;
    session.lastProduct = product;
    session.state = "collecting_info";
    const reply = L(lang,
      `🛒 ${product.product_name} অর্ডার করতে এক message এ দিন:\n• নাম\n• ঠিকানা\n• মোবাইল নাম্বার`,
      `🛒 ${product.product_name} order er jonno ek message e din:\n• Name\n• Address\n• Phone`,
      `🛒 To order ${product.product_name}, send:\n• Name\n• Address\n• Phone`
    );
    addHistory(session, "assistant", reply);
    return reply;
  }

  // LET AI HANDLE EVERYTHING ELSE
  const reply = await getSmartReply(messageText, session, products);
  if (reply) {
    addHistory(session, "assistant", reply);
    
    // Update last product if AI mentioned one
    if (product) {
      session.lastProduct = product;
      session.state = "product_viewed";
    }
    
    return reply;
  }

  return "একটু বুঝতে পারিনি! কোন প্রোডাক্ট চান? 😊";
}

/* ==================== FACEBOOK OAUTH ==================== */
app.get("/auth/facebook", (req, res) => {
  const { seller_id } = req.query;
  if (!seller_id) return res.status(400).send("Missing seller_id");
  
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/facebook/callback`;
  const state = seller_id;
  const fbAuthUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${FACEBOOK_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=pages_show_list,pages_messaging,pages_read_engagement&state=${state}`;
  
  res.redirect(fbAuthUrl);
});

app.get("/auth/facebook/callback", async (req, res) => {
  const { code, state } = req.query;
  
  if (!code || !state) {
    console.error("❌ Missing code or state");
    return res.redirect(`${FRONTEND_URL}/integrations?error=missing_params`);
  }

  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/facebook/callback`;
    
    // Exchange code for token
    const tokenRes = await axios.get("https://graph.facebook.com/v19.0/oauth/access_token", {
      params: {
        client_id: FACEBOOK_APP_ID,
        client_secret: FACEBOOK_APP_SECRET,
        redirect_uri: redirectUri,
        code,
      },
    });

    const userToken = tokenRes.data.access_token;
    console.log("✅ Got user token");

    // Get pages
    const pagesRes = await axios.get("https://graph.facebook.com/v19.0/me/accounts", {
      params: { access_token: userToken },
    });

    if (!pagesRes.data.data || !pagesRes.data.data.length) {
      return res.redirect(`${FRONTEND_URL}/integrations?error=no_pages`);
    }

    const sellerId = state;
    
    // Save all pages
    for (const page of pagesRes.data.data) {
      await savePageToken(sellerId, page.id, page.name, page.access_token);
      
      // Subscribe page to webhook
      try {
        await axios.post(`https://graph.facebook.com/v19.0/${page.id}/subscribed_apps`, {
          subscribed_fields: "messages,messaging_postbacks",
        }, {
          params: { access_token: page.access_token },
        });
        console.log(`✅ Subscribed: ${page.name}`);
      } catch (subErr) {
        console.error(`❌ Subscribe failed for ${page.name}:`, subErr.message);
      }
    }

    const firstPage = pagesRes.data.data[0];
    res.redirect(`${FRONTEND_URL}/integrations?success=true&page_name=${encodeURIComponent(firstPage.name)}&page_count=${pagesRes.data.data.length}`);

  } catch (err) {
    console.error("❌ OAuth error:", err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}/integrations?error=auth_failed`);
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

        const senderId    = event.sender.id;
        const messageId   = event.message.mid;
        const text        = event.message.text?.trim() || "";
        const attachments = event.message.attachments;
        const pageId      = entry.id;

        if (processedMessages.has(messageId)) continue;
        processedMessages.set(messageId, Date.now());

        const lastTime = userCooldown.get(senderId) || 0;
        if (Date.now() - lastTime < COOLDOWN_MS) continue;
        userCooldown.set(senderId, Date.now());

        let reply = "";

        // IMAGE
        if (attachments?.length && attachments[0].type === "image") {
          const products = await fetchProducts();
          const imageUrl = attachments[0].payload.url;
          const analysis = await analyzeImage(imageUrl, products);
          
          const session = getSession(senderId);
          if (analysis.found) {
            reply = analysis.reply;
            session.lastProduct = analysis.product;
            session.state = "product_viewed";
            addHistory(session, "assistant", reply);
          } else {
            reply = analysis.reply || L(session.lang,
              "এই পণ্যটি আমাদের কাছে নেই। অন্য কিছু দেখতে চান? 😊",
              "Ei ponno amader kache nai. Onno kisu dekhte chan? 😊",
              "This isn't in our shop. Want to see something else? 😊"
            );
          }
        } else if (text) {
          reply = await processMessage(senderId, text);
        }

        if (reply) {
          const token = await getPageToken(pageId);
          if (token) {
            await sendMessage(senderId, reply, token);
          } else {
            console.error(`❌ No token for page ${pageId} - user may need to reconnect`);
          }
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err.message, err.stack);
  }
});

app.get("/", (req, res) => res.json({
  status: "✅ BizAssist Smart Bot v6.0 (Persistent Tokens)",
  uptime: process.uptime(),
  products: productCache.data.length,
  sessions: userSessions.size,
  pages: pageTokens.size,
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Smart Bot v6.0 on port ${PORT}`);
  await loadAllTokensFromDB();
});
