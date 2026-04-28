const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

/* ================= SAFE CONFIG ================= */
const VERIFY_TOKEN = (process.env && process.env.VERIFY_TOKEN) || "bizassist123";
const PAGE_ACCESS_TOKEN = (process.env && process.env.PAGE_ACCESS_TOKEN) || "";
const WEBHOOK_API_KEY = (process.env && process.env.WEBHOOK_API_KEY) || "";

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";

const BASE =
  "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";

const PRODUCTS_URL = `${BASE}/api/public/get-products`;
const ALERT_URL = `${BASE}/api/public/order-alert`;

/* ================= HEALTH CHECK ================= */
app.get("/", (req, res) => {
  res.send("✅ BizAssist Running");
});

/* ================= MEMORY ================= */
const seen = new Map();
const history = new Map();

/* cleanup */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of seen.entries()) {
    if (now - v > 60000) seen.delete(k);
  }
}, 30000);

/* ================= PRODUCT CACHE ================= */
let cache = { data: [], time: 0 };

async function getProducts() {
  const now = Date.now();

  if (now - cache.time < 20000 && cache.data.length > 0) {
    return cache.data;
  }

  try {
    const res = await axios.get(
      `${PRODUCTS_URL}?seller_id=${SELLER_ID}`,
      {
        headers: { "x-api-key": WEBHOOK_API_KEY },
        timeout: 8000,
      }
    );

    const raw = res.data;

    let data = [];
    if (Array.isArray(raw)) data = raw;
    else if (Array.isArray(raw?.data)) data = raw.data;
    else if (Array.isArray(raw?.products)) data = raw.products;

    cache = { data, time: now };

    return data;
  } catch (err) {
    console.error("PRODUCT ERROR:", err.message);
    return cache.data || [];
  }
}

/* ================= HISTORY ================= */
function getHistory(id) {
  if (!history.has(id)) {
    history.set(id, {
      lastProduct: null,
      awaitingOrder: false,
      orderProduct: null,
    });
  }
  return history.get(id);
}

/* ================= INTENT ================= */
function getIntent(msg = "") {
  msg = msg.toLowerCase();

  if (msg.includes("price") || msg.includes("dam")) return "price";
  if (msg.includes("color") || msg.includes("rong")) return "color";
  if (msg.includes("stock") || msg.includes("available")) return "stock";
  if (msg.includes("order") || msg.includes("buy")) return "order";

  return "general";
}

/* ================= PRODUCT MATCH ================= */
function findProduct(products, msg = "") {
  if (!Array.isArray(products)) return null;
  msg = msg.toLowerCase();

  let best = null;
  let score = 0;

  for (const p of products) {
    if (!p?.product_name) continue;

    const name = p.product_name.toLowerCase();

    if (msg.includes(name)) return p;

    const words = name.split(" ");
    const match = words.filter((w) => msg.includes(w)).length;

    const s = words.length ? match / words.length : 0;

    if (s > score) {
      score = s;
      best = p;
    }
  }

  return score >= 0.4 ? best : null;
}

/* ================= FACEBOOK SEND ================= */
async function sendMessage(sender, text, retry = 1) {
  try {
    await axios.post(
      "https://graph.facebook.com/v18.0/me/messages",
      {
        recipient: { id: sender },
        message: { text },
      },
      {
        params: {
          access_token: PAGE_ACCESS_TOKEN,
        },
        timeout: 8000,
      }
    );
  } catch (err) {
    console.error("FB ERROR:", err.message);

    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      return sendMessage(sender, text, retry - 1);
    }
  }
}

/* ================= ALERT ================= */
async function sendAlert(sender, product) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: sender,
      product_name: product?.product_name || "unknown",
    });
  } catch (err) {
    console.error("ALERT ERROR:", err.message);
  }
}

/* ================= AI ================= */
async function ai(sender, msg, products, h) {
  msg = (msg || "").toLowerCase();

  const intent = getIntent(msg);

  /* order confirm */
  if (h.awaitingOrder) {
    if (msg.includes("yes")) {
      const p = h.orderProduct;
      h.awaitingOrder = false;
      h.orderProduct = null;

      if (!p) return "Product missing";

      await sendAlert(sender, p);

      return `🛒 Order confirmed: ${p.product_name}`;
    }

    if (msg.includes("no")) {
      h.awaitingOrder = false;
      h.orderProduct = null;
      return "❌ Cancelled";
    }
  }

  const product = findProduct(products, msg);

  if (!product) {
    return intent === "order"
      ? "কোন product চান?"
      : "Product পাওয়া যায়নি 🙂";
  }

  if (intent === "order") {
    h.awaitingOrder = true;
    h.orderProduct = product;

    return `Confirm order for ${product.product_name}? (yes/no)`;
  }

  if (intent === "price") {
    return `${product.product_name} price ${product.price_bdt || "N/A"} BDT`;
  }

  if (intent === "color") {
    return `${product.product_name} color ${product.color || "N/A"}`;
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
    for (const entry of req.body?.entry || []) {
      for (const event of entry?.messaging || []) {
        if (!event.message || event.message.is_echo) continue;

        const sender = event.sender?.id;
        const msg = event.message?.text || "";
        const mid = event.message?.mid;

        if (!sender || !mid) continue;
        if (seen.has(mid)) continue;

        seen.set(mid, Date.now());

        const products = await getProducts();
        const h = getHistory(sender);

        const reply = await ai(sender, msg, products, h);

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

app.listen(PORT, () => {
  console.log("🚀 BizAssist FIXED RUNNING on", PORT);
  console.log("VERIFY TOKEN SET:", !!process.env.VERIFY_TOKEN);
});
