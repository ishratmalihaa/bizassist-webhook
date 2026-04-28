
  const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

/* ================= CONFIG ================= */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "bizassist123";
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;

const SELLER_ID = "67f55dc2-41e9-410c-8c6b-289ebee08118";

const BASE_URL = "https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app";
const PRODUCTS_URL = `${BASE_URL}/api/public/get-products`;
const ALERT_URL = `${BASE_URL}/api/public/order-alert`;

/* ================= MEMORY ================= */
const processedMessages = new Set();
const historyMap = new Map();

/* ================= HELPERS ================= */
function getHistory(id) {
  if (!historyMap.has(id)) {
    historyMap.set(id, {
      lastProduct: null,
      awaitingOrderConfirm: false,
      orderProduct: null,
    });
  }
  return historyMap.get(id);
}

/* ================= PRODUCT ================= */
async function getProducts() {
  try {
    const res = await axios.get(`${PRODUCTS_URL}?seller_id=${SELLER_ID}`, {
      headers: { "x-api-key": WEBHOOK_API_KEY },
      timeout: 8000,
    });

    const data = res.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.products)) return data.products;

    return [];
  } catch (err) {
    console.error("Product fetch error:", err.message);
    return [];
  }
}

function findProduct(products, msg) {
  msg = msg.toLowerCase();

  let best = null;
  let bestScore = 0;

  for (let p of products) {
    if (!p.product_name) continue;

    const name = p.product_name.toLowerCase();

    if (msg.includes(name) || name.includes(msg)) return p;

    const words = name.split(" ");
    const matched = words.filter(w => w.length > 2 && msg.includes(w)).length;
    const score = matched / words.length;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return bestScore >= 0.4 ? best : null;
}

/* ================= INTENT ================= */
function detectIntent(msg) {
  msg = msg.toLowerCase();

  if (msg.includes("price") || msg.includes("dam")) return "price";
  if (msg.includes("color") || msg.includes("rong")) return "color";
  if (msg.includes("stock") || msg.includes("ache")) return "stock";
  if (msg.includes("order") || msg.includes("nibo")) return "order";

  return "general";
}

/* ================= FACEBOOK ================= */
async function getUserName(id) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/${id}?fields=name&access_token=${PAGE_ACCESS_TOKEN}`,
      { timeout: 5000 }
    );
    return res.data.name || "Customer";
  } catch {
    return "Customer";
  }
}

/* ================= ALERT ================= */
async function sendAlert(senderId, name, product, msg) {
  try {
    await axios.post(ALERT_URL, {
      secret: WEBHOOK_API_KEY,
      seller_id: SELLER_ID,
      customer_fb_id: senderId,
      customer_fb_name: name,
      product_name: product.product_name,
      message: msg,
    }, { timeout: 5000 });
  } catch (err) {
    console.error("Alert error:", err.message);
  }
}

/* ================= SEND MESSAGE ================= */
async function sendMessage(sender, text, retries = 2) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: sender },
        message: { text },
      },
      { timeout: 5000 }
    );
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return sendMessage(sender, text, retries - 1);
    }
    console.error("Send failed:", err.message);
  }
}

/* ================= TYPING ================= */
async function sendTyping(sender) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: sender },
        sender_action: "typing_on",
      },
      { timeout: 3000 }
    );
  } catch {}
}

/* ================= IMAGE ================= */
async function analyzeImage(url, products) {
  try {
    const img = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 10000,
    });

    const base64 = Buffer.from(img.data).toString("base64");

    const list = products.map(p =>
      `${p.product_name} (${p.price_bdt} BDT)`
    ).join("\n");

    const res = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 150,
      messages: [{
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64}` },
          },
          {
            type: "text",
            text: `Match this image with product list:\n${list}\nIf none, say NOT_IN_SHOP.`,
          },
        ],
      }],
    });

    return res.choices[0].message.content;
  } catch (err) {
    console.error("Image error:", err.message);
    return null;
  }
}

/* ================= AI ================= */
async function ai(senderId, msg, products, history) {

  /* ORDER CONFIRM */
  if (history.awaitingOrderConfirm) {
    if (msg.toLowerCase().includes("yes")) {
      const p = history.orderProduct;

      history.awaitingOrderConfirm = false;
      history.orderProduct = null;

      const name = await getUserName(senderId);
      await sendAlert(senderId, name, p, msg);

      return `🛒 Order placed for ${p.product_name}`;
    }

    if (msg.toLowerCase().includes("no")) {
      history.awaitingOrderConfirm = false;
      history.orderProduct = null;
      return "Order cancelled.";
    }
  }

  const product = findProduct(products, msg);

  if (!product) {
    if (!products.length) return "No products available.";

    const list = products.map(p => `• ${p.product_name}`).join("\n");
    return `Available products:\n${list}`;
  }

  const intent = detectIntent(msg);

  if (intent === "order") {
    history.awaitingOrderConfirm = true;
    history.orderProduct = product;
    return `Confirm order for ${product.product_name}? (yes/no)`;
  }

  if (intent === "price") {
    return `${product.product_name} price ${product.price_bdt} BDT`;
  }

  if (intent === "color") {
    return `${product.product_name} colors: ${product.color}`;
  }

  if (intent === "stock") {
    return product.stock_availability === "in_stock"
      ? "Available"
      : "Out of stock";
  }

  return `${product.product_name} - ${product.price_bdt} BDT`;
}

/* ================= WEBHOOK ================= */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  for (let entry of req.body.entry || []) {
    for (let event of entry.messaging || []) {

      if (!event.message || event.message.is_echo) continue;

      const sender = event.sender.id;
      const msg = event.message.text;
      const img = event.message.attachments?.[0];

      const mid = event.message.mid;
      if (processedMessages.has(mid)) continue;

      processedMessages.add(mid);
      setTimeout(() => processedMessages.delete(mid), 60000);

      await sendTyping(sender);

      const products = await getProducts();
      const history = getHistory(sender);

      let reply = "";

      if (img?.type === "image") {
        const result = await analyzeImage(img.payload.url, products);
        reply = (!result || result.includes("NOT_IN_SHOP"))
          ? "This product is not in our shop."
          : result;
      }

      else if (msg) {
        reply = await ai(sender, msg, products, history);
      }

      await sendMessage(sender, reply);
    }
  }
});

/* ================= START ================= */
app.get("/", (req, res) => res.send("BizAssist Running"));
app.listen(3000, () => console.log("Server running 🚀"));
