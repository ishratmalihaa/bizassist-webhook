const express = require('express');
const Groq = require('groq-sdk');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'bizassist123';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;

const LOVABLE_API_URL = 'https://project--b95f1c78-6680-4b45-b2e2-e1d1fbebf00d.lovable.app/api/public/get-products';
const SELLER_ID = '67f55dc2-41e9-410c-8c6b-289ebee08118';

const processedMessages = new Set();
const conversationHistory = new Map();

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
    console.error('API Error:', err.response?.data || err.message);
    return [];
  }
}

function detectLanguage(msg) {
  const bengaliChars = /[\u0980-\u09FF]/;
  const banglishWords = /\b(er|koto|dam|ache|ki|nai|daam|kori|hobe|theke|ta|te|ke|re|taka|jabe|chai|bol|dik|vai|bhai|apu)\b/i;
  if (bengaliChars.test(msg)) return 'bengali';
  if (banglishWords.test(msg)) return 'banglish';
  return 'english';
}

function findProduct(products, msg) {
  return products.find(p =>
    p.product_name && msg.includes(p.product_name.toLowerCase())
  );
}

function formatReply(lang, bengali, banglish, english) {
  if (lang === 'bengali') return bengali;
  if (lang === 'banglish') return banglish;
  return english;
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue;
        const messageId = event.message.mid;
        const senderId = event.sender.id;
        const userMessage = event.message.text;
        if (!userMessage) continue;
        if (processedMessages.has(messageId)) continue;
        processedMessages.add(messageId);
        setTimeout(() => processedMessages.delete(messageId), 60000);
        console.log('Customer:', userMessage);
        const reply = await generateReply(senderId, userMessage);
        console.log('Reply:', reply);
        await sendMessage(senderId, reply);
      }
    }
  }
});

async function generateReply(senderId, userMessage) {
  try {
    const products = await getProductsFromDB() || [];

    if (products.length === 0) {
      return 'Sorry, no products available right now.';
    }

    const msg = userMessage.toLowerCase();
    const lang = detectLanguage(userMessage);

    if (!conversationHistory.has(senderId)) {
      conversationHistory.set(senderId, { lastProduct: null });
    }
    const userHistory = conversationHistory.get(senderId);

    let matchedProduct = findProduct(products, msg);

    if (!matchedProduct && userHistory.lastProduct) {
      matchedProduct = userHistory.lastProduct;
    }

    if (matchedProduct) {
      userHistory.lastProduct = matchedProduct;
    }

    if (!matchedProduct) {
      return formatReply(lang,
        'কোন product এর কথা বলছেন বলুন।',
        'Kon product er kotha bolchen?',
        'Which product are you asking about?'
      );
    }

    const name = matchedProduct.product_name;
    const price = matchedProduct.price_bdt;
    const color = matchedProduct.color || '';
    const stock = matchedProduct.stock_availability;

    if (msg.includes('color') || msg.includes('colour') ||
        msg.includes('rong') || msg.includes('রং')) {
      return formatReply(lang,
        `${name} এর রং: ${color || 'জানা নেই'}`,
        `${name} er color: ${color || 'nai'}`,
        `${name} colors: ${color || 'Not specified'}`
      );
    }

    if (msg.includes('price') || msg.includes('dam') ||
        msg.includes('daam') || msg.includes('koto') ||
        msg.includes('কত')) {
      return formatReply(lang,
        `${name} এর দাম ${price} টাকা।`,
        `${name} er dam ${price} taka.`,
        `${name} price is ${price} taka.`
      );
    }

    if (msg.includes('stock') || msg.includes('ache') || msg.includes('available')) {
      const inStock = stock === 'in_stock';
      return formatReply(lang,
        inStock ? `${name} এখন available আছে।` : `${name} এখন নেই।`,
        inStock ? `${name} ache.` : `${name} nai ekhon.`,
        inStock ? `${name} is in stock.` : `${name} is out of stock.`
      );
    }

    const chat = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are BizAssist AI, a helpful shop assistant.
Product info: ${name}: price ${price} BDT, color: ${color}, stock: ${stock}
Detected language: ${lang}
RULES:
- If language is "bengali": reply in pure Bengali script
- If language is "banglish": reply in Banglish (Bengali words in English letters)
- If language is "english": reply in English
- Keep reply SHORT (1-2 sentences only)
- Only use the product info given above
- Never make up prices or products`
        },
        { role: 'user', content: userMessage }
      ]
    });
    return chat.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error:', error);
    return 'Sorry, something went wrong.';
  }
}

async function sendMessage(recipientId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text: message } }
    );
    console.log('Sent ✔');
  } catch (err) {
    console.error('Send Error:', err.response?.data || err.message);
  }
}

app.get('/', (req, res) => res.send('BizAssist Webhook Running! 🚀'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
