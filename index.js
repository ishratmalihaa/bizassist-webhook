const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

/* ==================== CONFIG ==================== */
const VERIFY_TOKEN = "bizassist123";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;
const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";
const LOVABLE_BASE =
  "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${LOVABLE_BASE}/api/public/get-products`;
const ALERT_URL = `${LOVABLE_BASE}/api/public/order-alert`;

/* ==================== MEMORY ==================== */
const processedMessages = new Set();
const conversationHistory = new Map();
const userMessageTimes = new Map();
const RATE_LIMIT_MS = 2000;

function isRateLimited(senderId) {
  const now = Date.now();
  const last = userMessageTimes.get(senderId) || 0;
  if (now - last < RATE_LIMIT_MS) return true;
  userMessageTimes.set(senderId, now);
  return false;
}

/* ==================== PRODUCT FETCH ==================== */
async function getProductsFromDB() {
  try {
    const res = await axios.get(
      `${PRODUCTS_URL}?seller_id=${SELLER_ID}`,
      {
        headers: { "x-api-key": WEBHOOK_API_KEY },
        timeout: 8000,
      }
    );
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.products)) return data.products;
    if (Array.isArray(data.data)) return data.data;
    return [];
  } catch (err) {
    console.error("Product fetch error:", err.message);
    return [];
  }
}

/* ==================== LANGUAGE DETECT ==================== */
function detectLanguage(msg) {
  const bengali = /[\u0980-\u09FF]/;
  const banglish =
    /\b(koto|dam|ache|nai|ki|taka|order|nibo|dibo|ase|koi|rong|koren|chai|hobe|lagbe|boro|choto|valo|kemon|koyta|koyti|diye|dao|pabo)\b/i;
  if (bengali.test(msg)) return "bengali";
  if (banglish.test(msg)) return "banglish";
  return "english";
}

function formatReply(lang, bn, bl, en) {
  if (lang === "bengali") return bn;
  if (lang === "banglish") return bl;
  return en;
}

/* ==================== FUZZY MATCH ==================== */
function findProduct(products, msg) {
  msg = msg.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (let p of products) {
    if (!p.product_name) continue;
    const name = p.product_name.toLowerCase();

    if (msg.includes(name) || name.includes(msg)) return p;

    const words = name.split(" ");
    const matched = words.filter(
      (w) => w.length > 2 && msg.includes(w)
    ).length;
    const score = matched / words.length;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 0.4 ? best : null;
}

/* ==================== HISTORY ==================== */
function getHistory(senderId) {
  if (!conversationHistory.has(senderId)) {
    conversationHistory.set(senderId, {
      lastProduct: null,
      lang: "banglish",
      pendingProduct: null,
      pendingIntent: null,
      awaitingOrderConfirm: false,
      orderProduct: null,
    });
  }
  return conversationHistory.get(senderId);
}

/* ==================== INTENT ==================== */
function detectIntent(msg) {
  const m = msg.toLowerCase();
  if (
    m.includes("price") || m.includes("koto") ||
    m.includes("dam") || m.includes("দাম") || m.includes("কত")
  ) return "price";
  if (
    m.includes("color") || m.includes("colour") ||
    m.includes("rong") || m.includes("রং")
  ) return "color";
  if (
    m.includes("koyta") || m.includes("koyti") ||
    m.includes("quantity") || m.includes("কয়টা")
  ) return "quantity";
  if (
    m.includes("stock") || m.includes("ache") ||
    m.includes("available") || m.includes("আছে") || m.includes("ase")
  ) return "stock";
  if (
    m.includes("order") || m.includes("buy") ||
    m.includes("nibo") || m.includes("নেব") ||
    m.includes("korbo") || m.includes("kinte") ||
    m.includes("lagbe") || m.includes("dao")
  ) return "order";
  return "general";
}

function isDirectIntent(msg) {
  const directWords = [
    "price", "dam", "koto", "দাম", "কত",
    "color", "rong", "রং",
    "stock", "ache", "available", "আছে",
    "koyta", "koyti", "কয়টা",
    "order", "nibo", "korbo", "lagbe",
  ];
  return directWords.some((w) => msg.toLowerCase().includes(w));
}

function isContextOnly(msg) {
  const words = [
    "this", "eta", "ota", "eita", "same",
    "this one", "this product", "ata", "ta", "eti",
  ];
  return words.some((w) => msg.toLowerCase().trim() === w);
}

function isYes(msg) {
  const y = [
    "yes", "haa", "ha", "হ্যাঁ", "হা", "hya", "ok", "okay",
    "ji", "জি", "sure", "thik", "han", "yep", "haan",
    "nibo", "lagbe", "chai", "dao", "confirm",
  ];
  return y.some((w) => msg.toLowerCase().includes(w));
}

function isNo(msg) {
  const n = ["no", "na", "না", "nah", "nope", "nai", "naa", "cancel"];
  return n.some((w) => msg.toLowerCase().trim() === w);
}

/* ==================== BUILD REPLY ==================== */
function buildReply(lang, product, intent) {
  const name    = product.product_name;
  const price   = product.price_bdt;
  const color   = product.color || "N/A";
  const stock   = product.stock_availability;
  const qty     = product.stock_count || product.quantity || null;
  const inStock = stock === "in_stock";

  if (intent === "price") {
    return formatReply(lang,
      `${name} এর দাম ${price} টাকা।`,
      `${name} er dam ${price} taka.`,
      `${name} price is ${price} BDT.`
    );
  }
  if (intent === "color") {
    return formatReply(lang,
      `${name} এর রং: ${color}`,
      `${name} er color: ${color}`,
      `${name} colors: ${color}`
    );
  }
  if (intent === "quantity") {
    return qty
      ? formatReply(lang,
          `${name} এখন ${qty}টা stock এ আছে।`,
          `${name} ekhon ${qty}ta ache.`,
          `${name} has ${qty} units in stock.`
        )
      : formatReply(lang,
          inStock
            ? `${name} stock এ আছে। সঠিক পরিমাণের জন্য seller কে জিজ্ঞেস করুন।`
            : `${name} এখন নেই।`,
          inStock
            ? `${name} ache. Porimaan jante seller ke jiggesh korun.`
            : `${name} nai ekhon.`,
          inStock
            ? `${name} is in stock. Contact seller for exact quantity.`
            : `${name} is out of stock.`
        );
  }
  if (intent === "stock") {
    return formatReply(lang,
      inStock ? `${name} এখন available আছে।` : `${name} এখন নেই।`,
      inStock ? `${name} ache.` : `${name} nai ekhon.`,
      inStock ? `${name} is in stock.` : `${name} is out of stock.`
    );
  }
  if (intent === "order") {
    return formatReply(lang,
      `🛒 ${name} এর order seller কে পাঠানো হচ্ছে। তিনি শীঘ্রই confirm করবেন।`,
      `🛒 ${name} order pathano hocche. Seller confirm korbe.`,
      `🛒 Order for ${name} (${price} BDT) sent to seller. They will confirm shortly.`
    );
  }
  return formatReply(lang,
    `${name} এর দাম ${price} টাকা। রং: ${color}।`,
    `${name} dam ${price} taka. Color: ${color}.`,
    `${name} costs ${price} BDT. Color: ${color}.`
  );
}

/* ==================== PRODUCT LIST (FALLBACK) ==================== */
function buildProductList(products, lang) {
  if (!products || products.length === 0) {
    return formatReply(lang,
      "এখন কোনো product নেই।",
      "Ekhon kono product nai.",
      "No products available right now."
    );
  }
  const list = products.map((p) => `• ${p.product_name}`).join("\n");
  return formatReply(lang,
    `আমাদের products:\n${list}\n\nকোনটার কথা জানতে চান?`,
    `Amader products:\n${list}\n\nKontar kotha jante chan?`,
    `Our products:\n${list}\n\nWhich one would you like to know about?`
  );
}

/* ==================== FACEBOOK NAME ==================== */
async function getFBUserName(senderId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/${senderId}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`,
      { timeout: 5000 }
    );
    return res.data?.name || "Customer";
  } catch {
    return "Customer";
  }
}

/* ==================== ORDER ALERT ==================== */
async function sendOrderAlert(senderId, fbName, product, originalMsg) {
  try {
    await axios.post(
      ALERT_URL,
      {
        secret: WEBHOOK_API_KEY,
        seller_id: SELLER_ID,
        customer_fb_id: senderId,
        customer_fb_name: fbName,
        product_name: product?.product_name || "Unknown",
        message: originalMsg,
      },
      { timeout: 5000 }
    );
    console.log("Order alert sent:", fbName, "→", product?.product_name);
  } catch (err) {
    console.error("Alert failed (non-critical):", err.message);
  }
}

/* ==================== SEND MESSAGE (WITH RETRY) ==================== */
async function sendMessage(senderId, text, retries = 2) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: senderId }, message: { text } },
      { timeout: 5000 }
    );
  } catch (err) {
    if (retries > 0) {
      console.log(`Retrying send... (${retries} left)`);
      await new Promise((r) => setTimeout(r, 1000));
      return sendMessage(senderId, text, retries - 1);
    }
    console.error("Send failed:", err.response?.data || err.message);
  }
}

/* ==================== TYPING INDICATOR ==================== */
async function sendTyping(senderId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderId },
        sender_action: "typing_on",
      },
      { timeout: 3000 }
    );
  } catch {
    // typing fail হলে ignore
  }
}

/* ==================== IMAGE ANALYSIS ==================== */
async function analyzeImage(imageUrl, products) {
  // STEP 1: আগে fuzzy match try করো (fast + free)
  // image URL থেকে filename বের করে product match দেখো
  const urlLower = imageUrl.toLowerCase();
  const fuzzyMatch = findProduct(products, urlLower);
  if (fuzzyMatch) {
    console.log("Image fuzzy matched:", fuzzyMatch.product_name);
    return `${fuzzyMatch.product_name} — Price: ${fuzzyMatch.price_bdt} BDT, Color: ${fuzzyMatch.color}`;
  }

  // STEP 2: AI vision (slow path)
  try {
    const img = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 10000,
    });

    const base64 = Buffer.from(img.data).toString("base64");
    const list = products
      .map((p) => `- ${p.product_name} | ${p.price_bdt} BDT | color: ${p.color}`)
      .join("\n");

    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 200,
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
              text: `You are a shop assistant. Our products:\n${list}\n\nDoes the image match any product? If yes → reply with product name, price, color in 1-2 sentences. If no → say exactly "NOT_IN_SHOP".`,
            },
          ],
        },
      ],
    });

    return result.choices[0].message.content.trim();
  } catch (err) {
    console.error("Image AI error:", err.message);
    return null;
  }
}

/* ==================== AI AGENT ==================== */
async function aiAgent(senderId, msg, products, history) {
  const lang = detectLanguage(msg);
  history.lang = lang;

  /* ---- ORDER CONFIRM STEP ---- */
  if (history.awaitingOrderConfirm && history.orderProduct) {
    if (isYes(msg)) {
      const product = history.orderProduct;
      history.awaitingOrderConfirm = false;
      history.orderProduct = null;
      history.lastProduct = product;

      const fbName = await getFBUserName(senderId);
      await sendOrderAlert(senderId, fbName, product, msg);

      return {
        reply: buildReply(lang, product, "order"),
        intent: "order",
        product,
      };
    }

    if (isNo(msg)) {
      history.awaitingOrderConfirm = false;
      history.orderProduct = null;
      return {
        reply: formatReply(lang,
          "ঠিক আছে, order cancel হয়ে গেছে।",
          "Okay, order cancel hoyeche.",
          "Okay, order has been cancelled."
        ),
        intent: "cancelled",
      };
    }
  }

  /* ---- PRODUCT CONFIRM STEP ---- */
  if (history.pendingProduct) {
    if (isYes(msg)) {
      const product = history.pendingProduct;
      const intent  = history.pendingIntent;
      history.lastProduct    = product;
      history.pendingProduct = null;
      history.pendingIntent  = null;

      // order হলে আরেকটা confirm step
      if (intent === "order") {
        history.awaitingOrderConfirm = true;
        history.orderProduct = product;
        return {
          reply: formatReply(lang,
            `🛒 আপনি কি সত্যিই "${product.product_name}" order করতে চান? (yes/no)`,
            `🛒 Apni ki sotti "${product.product_name}" order korte chan? (yes/no)`,
            `🛒 Are you sure you want to order "${product.product_name}"? (yes/no)`
          ),
          intent: "order_confirm",
        };
      }

      return {
        reply: buildReply(lang, product, intent),
        intent,
        product,
      };
    }

    if (isNo(msg)) {
      history.pendingProduct = null;
      history.pendingIntent  = null;
      return {
        reply: formatReply(lang,
          "ঠিক আছে। কোন product এর কথা জানতে চান?",
          "Okay. Kon product er kotha jante chan?",
          "Okay! Which product would you like to know about?"
        ),
        intent: "unknown",
      };
    }

    // direct intent এলে pending clear
    history.pendingProduct = null;
    history.pendingIntent  = null;
  }

  /* ---- PRODUCT MATCH ---- */
  let product = findProduct(products, msg);

  if (!product && isContextOnly(msg)) {
    product = history.lastProduct;
  }

  /* ---- NO PRODUCT FOUND ---- */
  if (!product) {
    const intent = detectIntent(msg);

    if (intent === "order") {
      return {
        reply: formatReply(lang,
          "কোন product order করতে চান সেটা বলুন।",
          "Kon product order korte chan seta bolen.",
          "Please tell me which product you want to order."
        ),
        intent: "order_no_product",
      };
    }

    // FALLBACK: product list দেখাও
    return {
      reply: buildProductList(products, lang),
      intent: "unknown",
    };
  }

  /* ---- INTENT ---- */
  const intent = detectIntent(msg);

  /* ---- DIRECT INTENT = SKIP CONFIRM ---- */
  if (isDirectIntent(msg)) {
    history.lastProduct    = product;
    history.pendingProduct = null;
    history.pendingIntent  = null;

    // order হলে confirm step
    if (intent === "order") {
      history.awaitingOrderConfirm = true;
      history.orderProduct = product;
      return {
        reply: formatReply(lang,
          `🛒 আপনি কি "${product.product_name}" order করতে চান? (yes/no)`,
          `🛒 Apni ki "${product.product_name}" order korte chan? (yes/no)`,
          `🛒 Do you want to order "${product.product_name}"? (yes/no)`
        ),
        intent: "order_confirm",
      };
    }

    return {
      reply: buildReply(lang, product, intent),
      intent,
      product,
    };
  }

  /* ---- AMBIGUOUS = CONFIRM FIRST ---- */
  history.pendingProduct = product;
  history.pendingIntent  = intent;

  return {
    reply: formatReply(lang,
      `আপনি কি "${product.product_name}" এর কথা জিজ্ঞেস করছেন? 🤔`,
      `Apni ki "${product.product_name}" er kotha jiggesh korchen? 🤔`,
      `Are you asking about "${product.product_name}"? 🤔`
    ),
    intent: "confirm_pending",
  };
}

/* ==================== WEBHOOK GET ==================== */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* ==================== WEBHOOK POST ==================== */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== "page") return;

  for (let entry of body.entry || []) {
    for (let event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;

      const senderId    = event.sender.id;
      const msg         = event.message.text;
      const attachments = event.message.attachments;
      const mid         = event.message.mid;

      if (processedMessages.has(mid)) continue;
      processedMessages.add(mid);
      setTimeout(() => processedMessages.delete(mid), 60000);

      if (isRateLimited(senderId)) {
        console.log("Rate limited:", senderId);
        continue;
      }

      // typing indicator
      await sendTyping(senderId);

      const products = await getProductsFromDB();
      const history  = getHistory(senderId);

      let reply = "";

      /* ----- IMAGE ----- */
      if (attachments?.[0]?.type === "image") {
        console.log("Image from:", senderId);
        const result = await analyzeImage(
          attachments[0].payload.url,
          products
        );

        reply = (!result || result.includes("NOT_IN_SHOP"))
          ? formatReply(history.lang || "banglish",
              `এই product আমাদের shop এ নেই।\n\n${buildProductList(products, "bengali")}`,
              `Ei product amader shop e nai.\n\n${buildProductList(products, "banglish")}`,
              `This product is not in our shop.\n\n${buildProductList(products, "english")}`
            )
          : result;
      }

      /* ----- TEXT ----- */
      else if (msg) {
        console.log("Customer:", msg);
        const result = await aiAgent(senderId, msg, products, history);
        reply = result.reply;
      } else {
        continue;
      }

      console.log("Reply:", reply);
      await sendMessage(senderId, reply);
    }
  }
});

/* ==================== START ==================== */
app.get("/", (req, res) => res.send("BizAssist AI Running"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
