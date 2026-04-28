const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const BASE =
  "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";

const PRODUCTS_URL = `${BASE}/api/public/get-products`;
const ALERT_URL = `${BASE}/api/public/order-alert`;

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";

/* ================= SAFE STATE ================= */
const seen = new Map();
const history = new Map();

/* ================= UTIL ================= */
const clean = (t) => (t || "").toString().toLowerCase().trim();

/* ================= GET PRODUCTS ================= */
async function getProducts() {
  try {
    const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`);

    if (Array.isArray(res.data?.products)) return res.data.products;
    if (Array.isArray(res.data)) return res.data;

    return [];
  } catch (e) {
    return [];
  }
}

/* ================= PRODUCT MATCH ================= */
function findProduct(products, msg) {
  msg = clean(msg);

  let best = null;
  let score = 0;

  for (const p of products || []) {
    if (!p?.product_name) continue;

    const name = clean(p.product_name);

    if (msg.includes(name)) return p;

    const words = name.split(" ");
    let match = 0;

    for (const w of words) {
      if (msg.includes(w)) match++;
    }

    const s = words.length ? match / words.length : 0;

    if (s > score) {
      score = s;
      best = p;
    }
  }

  return score >= 0.3 ? best : null;
}

/* ================= AI ================= */
async function ai(sender, msg, products, h) {
  msg = clean(msg);

  if (!Array.isArray(products)) products = [];

  /* ================= GREETING ================= */
  if (/^(hi|hello|hey|halo|helo)$/i.test(msg)) {
    return "👋 Hello! What are you looking for?";
  }

  if (/^(হাই|হ্যালো|আসসালামু আলাইকুম)$/i.test(msg)) {
    return "👋 আসসালামু আলাইকুম! আপনি কী খুঁজছেন?";
  }

  /* ================= INTENT ================= */
  const intent =
    /price|dam|koto/.test(msg)
      ? "price"
      : /color|rong/.test(msg)
      ? "color"
      : /stock|available|ache/.test(msg)
      ? "stock"
      : /order|buy|nibo/.test(msg)
      ? "order"
      : "general";

  /* ================= PRODUCT ================= */
  let product = findProduct(products, msg);

  const context =
    /\b(ki|eta|this|it)\b/.test(msg) &&
    /(price|color|stock|available)/.test(msg);

  if (!product && context && h?.lastProduct) {
    product = h.lastProduct;
  }

  /* ================= NO PRODUCT ================= */
  if (!product) {
    if (!products.length) {
      return "⚠️ Product system loading...";
    }

    const list = products
      .slice(0, 5)
      .map((p) => `• ${p?.product_name || "Unknown"}`)
      .join("\n");

    return `❌ Product not found\n\nAvailable:\n${list}`;
  }

  /* ================= SAVE CONTEXT ================= */
  h.lastProduct = product;

  const name = product.product_name || "Product";
  const price = product.price_bdt ?? "N/A";
  const color = product.color ?? "N/A";

  /* ================= RESPONSES ================= */
  if (intent === "price") return `${name} price is ${price} BDT`;
  if (intent === "color") return `${name} color is ${color}`;

  if (intent === "stock") {
    return product.stock_availability === "in_stock"
      ? `${name} is available`
      : `❌ Not available`;
  }

  /* ================= ORDER (ONLY ALERT TO SELLER) ================= */
  if (intent === "order") {
    try {
      await axios.post(ALERT_URL, {
        sender,
        product_name: name,
        price,
        color,
        status: "pending",
        time: Date.now(),
      });
    } catch (e) {
      console.log("alert error");
    }

    return `🟡 Order request sent to seller. Waiting for confirmation.`;
  }

  return `${name} - ${price} BDT`;
}

/* ================= WEBHOOK ================= */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const products = await getProducts();

  for (const entry of req.body?.entry || []) {
    for (const event of entry?.messaging || []) {
      if (!event.message || event.message.is_echo) continue;

      const sender = event.sender?.id;
      const msg = event.message?.text || "";
      const mid = event.message?.mid;

      if (!sender || !mid) continue;
      if (seen.has(mid)) continue;

      seen.set(mid, Date.now());

      const h =
        history.get(sender) ||
        history.set(sender, {
          lastProduct: null,
        }).get(sender);

      const reply = await ai(sender, msg, products, h);

      await axios.post(
        "https://graph.facebook.com/v18.0/me/messages",
        {
          recipient: { id: sender },
          message: { text: reply },
        },
        {
          params: {
            access_token: process.env.PAGE_ACCESS_TOKEN || "",
          },
        }
      );
    }
  }
});

/* ================= VERIFY ================= */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* ================= START ================= */
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 BOT RUNNING");
});
