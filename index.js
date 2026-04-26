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

async function getProductsFromDB() {
  try {
    const res = await axios.get(
      `${LOVABLE_API_URL}?seller_id=${SELLER_ID}`,
      { headers: { 'x-api-key': WEBHOOK_API_KEY } }
    );
    return res.data;
  } catch (err) {
    console.error('API Error:', err.response?.data || err.message);
    return [];
  }
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
        const reply = await generateReply(userMessage);
        console.log('Reply:', reply);
        await sendMessage(senderId, reply);
      }
    }
  }
});

async function generateReply(userMessage) {
  try {
    const products = await getProductsFromDB() || [];

    if (products.length === 0) {
      return 'Sorry, no products available right now.';
    }

    const msg = userMessage.toLowerCase();

    const matchedProduct = products.find(p =>
      p.name && msg.includes(p.name.toLowerCase())
    );

    if (!matchedProduct) {
      return 'Not available';
    }

    if (msg.includes('color') || msg.includes('colour') ||
        msg.includes('rong') || msg.includes('রং')) {
      return `Available colors: ${matchedProduct.colors || 'Not specified'}`;
    }

    if (msg.includes('price') || msg.includes('dam') ||
        msg.includes('daam') || msg.includes('koto') ||
        msg.includes('কত')) {
      return `Price is ${matchedProduct.price} taka`;
    }

    const chat = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are BizAssist AI, a helpful shop assistant.
Product info: ${matchedProduct.name}: price ${matchedProduct.price} BDT, color: ${matchedProduct.colors}, stock: ${matchedProduct.stock}
RULES:
- Reply in SAME language as customer (Bengali/English/Banglish)
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
