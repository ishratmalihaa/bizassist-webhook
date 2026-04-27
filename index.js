const express = require('express');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'bizassist123';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL;
const SELLER_ID = process.env.SELLER_ID;

const processedMessages = new Set();
const conversationHistory = new Map();

/* =========================
   FETCH PRODUCTS
========================= */
async function getProductsFromDB() {
  try {
    const res = await axios.get(
      `${LOVABLE_API_URL}?seller_id=${SELLER_ID}`,
      { headers: { 'x-api-key': WEBHOOK_API_KEY } }
    );

    const data = res.data;

    if (Array.isArray(data)) return data;
    if (Array.isArray(data.products)) return data.products;
    if (Array.isArray(data.data)) return data.data;

    return [];
  } catch (err) {
    console.error("API Error:", err.response?.data || err.message);
    return [];
  }
}

/* =========================
   LANGUAGE DETECT
========================= */
function detectLanguage(msg) {
  const bengali = /[\u0980-\u09FF]/;
  const banglish = /\b(er|koto|dam|ache|nibo|kinbo|taka)\b/i;

  if (bengali.test(msg)) return "bengali";
  if (banglish.test(msg)) return "banglish";
  return "english";
}

function formatReply(lang, bn, bl, en) {
  if (lang === "bengali") return bn;
  if (lang === "banglish") return bl;
  return en;
}

/* =========================
   FUZZY MATCH
========================= */
function similarity(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();

  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }

  return matches / Math.max(a.length, b.length);
}

function findProduct(products, msg) {
  let bestMatch = null;
  let bestScore = 0;

  for (let p of products) {
    const name = (p.product_name || "").toLowerCase();

    let score = similarity(msg, name);

    if (msg.includes(name) || name.includes(msg)) score += 0.5;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
  }

  return bestScore > 0.4 ? bestMatch : null;
}

/* =========================
   AI MATCH (fallback)
========================= */
async function aiFindProduct(products, userMessage) {
  try {
    const list = products.map(p => p.product_name).join(", ");

    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Match user message to product.

Products:
${list}

Return ONLY product name or NONE.`
        },
        { role: "user", content: userMessage }
      ]
    });

    const result = res.choices[0].message.content.trim();

    if (result === "NONE") return null;

    return products.find(p =>
      p.product_name.toLowerCase() === result.toLowerCase()
    );
  } catch {
    return null;
  }
}

/* =========================
   IMAGE PROCESS
========================= */
async function getImage(url) {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` }
    });

    return {
      base64: Buffer.from(res.data).toString("base64"),
      type: res.headers["content-type"]
    };
  } catch {
    return null;
  }
}

async function analyzeImage(imageUrl, products) {
  const img = await getImage(imageUrl);
  if (!img) return "Image failed.";

  const list = products.map(p =>
    `${p.product_name} (${p.price_bdt} BDT)`
  ).join("\n");

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${img.type};base64,${img.base64}` } },
          { type: "text", text: `Match image to product:\n${list}` }
        ]
      }
    ]
  });

  return res.choices[0].message.content;
}

/* =========================
   WEBHOOK VERIFY
========================= */
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

/* =========================
   MAIN WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {

      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender.id;
      const msgId = event.message.mid;

      if (processedMessages.has(msgId)) continue;
      processedMessages.add(msgId);
      setTimeout(() => processedMessages.delete(msgId), 60000);

      const text = event.message.text;
      const attachments = event.message.attachments;

      let reply;

      /* IMAGE */
      if (attachments?.length) {
        const img = attachments.find(a => a.type === "image");
        if (img) {
          const products = await getProductsFromDB();
          reply = await analyzeImage(img.payload.url, products);
        } else {
          reply = "Send product image.";
        }
      }

      /* TEXT */
      else if (text) {
        reply = await generateReply(senderId, text);
      }

      await sendMessage(senderId, reply);
    }
  }
});

/* =========================
   GENERATE REPLY
========================= */
async function generateReply(senderId, userMessage) {
  const products = await getProductsFromDB();

  const msg = userMessage.toLowerCase();
  const lang = detectLanguage(userMessage);

  if (!conversationHistory.has(senderId)) {
    conversationHistory.set(senderId, { last: null });
  }

  const history = conversationHistory.get(senderId);

  let product = findProduct(products, msg);

  if (!product) {
    product = await aiFindProduct(products, userMessage);
  }

  if (!product && history.last) {
    product = history.last;
  }

  if (!product) {
    return formatReply(
      lang,
      "আপনি কোন product চান স্পষ্ট করে বলুন",
      "Please clearly bolun kon product",
      "Please specify the product"
    );
  }

  history.last = product;

  const name = product.product_name;
  const price = product.price_bdt;
  const stock = product.stock_quantity || 0;
  const color = product.color || "";

  if (msg.includes("stock") || msg.includes("koyta")) {
    return `${name} stock ${stock} ta`;
  }

  if (msg.includes("price") || msg.includes("koto")) {
    return `${name} price ${price} taka`;
  }

  if (msg.includes("color") || msg.includes("rong")) {
    return `${name} colors: ${color}`;
  }

  if (msg.includes("order") || msg.includes("nibo")) {
    return `To order ${name} 👍\nSend name, address, phone in inbox`;
  }

  if (msg.includes("image") || msg.includes("pic")) {
    return `Check our page for ${name} images 👍`;
  }

  return `${name} available 👍 price ${price}`;
}

/* =========================
   SEND MESSAGE
========================= */
async function sendMessage(id, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id },
      message: { text }
    }
  );
}

/* =========================
   START
========================= */
app.get("/", (req, res) => res.send("Running"));

app.listen(process.env.PORT || 3000);
