const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ================= CONFIG ================= */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "bizassist123";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";

const BASE_URL =
  "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";

const PRODUCTS_URL = `${BASE_URL}/api/public/get-products`;
const ALERT_URL = `${BASE_URL}/api/public/order-alert`;

/* ================= MEMORY ================= */
const processedMessages = new Map();
const MESSAGE_TTL = 60000;

setInterval(() => {
  const now = Date.now();
  for (const [mid, time] of processedMessages.entries()) {
    if (now - time > MESSAGE_TTL) processedMessages.delete(mid);
  }
}, 30000);

/* ================= HISTORY ================= */
const historyMap = new Map();

function getHistory(id) {
  if (!historyMap.has(id)) {
    historyMap.set(id, {
      awaitingOrderConfirm: false,
      orderProduct: null,
    });
  }
  return historyMap.get(id);
}

/* ================= PRODUCT CACHE ================= */
let productCache = { data: [], time: 0 };
const CACHE_TIME = 15000;

/* ================= PRODUCTS (FIXED SAFE) ================= */
async function getProducts() {
  const now = Date.now();

  if (now - productCache.time < CACHE_TIME) {
    return Array.isArray(productCache.data) ? productCache.data : [];
  }

  try {
    const res = await axios.get(
      `${PRODUCTS_URL}?seller_id=${SELLER_ID}`,
      {
        timeout: 8000,
        headers: { "x-api-key": WEBHOOK_API_KEY },
      }
    );

    let data = res.data;

    if (Array.isArray(data)) {
      data = data;
    } else if (Array.isArray(data?.data)) {
      data = data.data;
    } else {
      data = [];
    }

    productCache = { data, time: now };

    return data;
  } catch (err) {
    console.error("PRODUCT ERROR:", err.message);
    return Array.isArray(productCache.data) ? productCache.data : [];
  }
}

/* ================= INTENT ================= */
function detectIntent(msg = "") {
  msg = (msg || "").toLowerCase();

  if (msg.includes("price") || msg.includes("dam")) return "price";
  if (msg.includes("color") || msg.includes("rong")) return "color";
  if (msg.includes("stock") || msg.includes("available")) return "stock";
  if (msg.includes("order") || msg.includes("buy") || msg.includes("nibo"))
    return "order";

  return "general";
}

/* ================= PRODUCT MATCH (SAFE) ================= */
function findProduct(products = [], msg = "") {
  if (!Array.isArray(products)) return null;

  msg = (msg || "").toLowerCase();

  let best = null;
  let score = 0;

  for (const p of products) {
    if (!p?.product_name) continue;

    const name = p.product_name.toLowerCase();

    if (msg.includes(name)) return p;

    const words = name.split(" ").filter(Boolean);
    const match = words.filter(w => msg.includes(w)).length;

    const s = words.length ? match / words.length : 0;

    if (s > score) {
      score = s;
      best = p;
    }
  }

  return score >= 0.4 ? best : null;
}

/* ================= ALERT ================= */
async function sendAlert(senderId, product) {
  if (!product?.product_name) return;

  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: senderId,
      product_name: product.product_name,
    });
  } catch (err) {
    console.error("ALERT ERROR:", err.message);
  }
}

/* ================= FACEBOOK SEND (SAFE) ================= */
async function sendMessage(sender, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages`,
      {
        recipient: { id: sender },
        message: { text },
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
        timeout: 8000,
      }
    );
  } catch (err) {
    console.error("FB ERROR:", err.response?.data || err.message);
  }
}

/* ================= AI CORE ================= */
async function ai(senderId, msg, products, history) {
  msg = (msg || "").toLowerCase();

  const intent = detectIntent(msg);

  if (msg.includes("stop") || msg.includes("dont show")) {
    return "👍 ঠিক আছে, বলুন কী জানতে চান।";
  }

  /* ORDER CONFIRM */
  if (history.awaitingOrderConfirm) {
    if (msg.includes("yes")) {
      const p = history.orderProduct;

      history.awaitingOrderConfirm = false;
      history.orderProduct = null;

      if (!p) return "⚠️ Product missing.";

      await sendAlert(senderId, p);

      return `🛒 Order confirmed: ${p.product_name}`;
    }

    if (msg.includes("no")) {
      history.awaitingOrderConfirm = false;
      history.orderProduct = null;
      return "❌ Order cancelled";
    }
  }

  const product = findProduct(products, msg);

  if (!product) {
    return intent === "order"
      ? "কোন product order করতে চান?"
      : "Product পাওয়া যায়নি 🙂";
  }

  if (intent === "order") {
    history.awaitingOrderConfirm = true;
    history.orderProduct = product;

    return `Confirm order for ${product.product_name}? (yes/no)`;
  }

  if (intent === "price") {
    return `${product.product_name} price ${product.price_bdt || "N/A"} BDT`;
  }

  if (intent === "color") {
    return `${product.product_name} color: ${product.color || "N/A"}`;
  }

  if (intent === "stock") {
    return product.stock_availability === "in_stock"
      ? "Available"
      : "Out of stock";
  }

  return `${product.product_name} - ${product.price_bdt || "N/A"} BDT`;
}

/* ================= WEBHOOK ================= */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    for (const entry of req.body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;

        const sender = event.sender.id;
        const msg = event.message?.text || "";
        const mid = event.message?.mid;

        if (!mid) continue;

        if (processedMessages.has(mid)) continue;
        processedMessages.set(mid, Date.now());

        const products = await getProducts();
        const history = getHistory(sender);

        const reply = await ai(sender, msg, products, history);

        await sendMessage(sender, reply);
      }
    }
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }
});

/* ================= VERIFY ================= */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 BizAssist FINAL STABLE RUNNING on", PORT)
);
