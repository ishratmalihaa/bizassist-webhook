const express = require('express');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

// ENV
const VERIFY_TOKEN = 'bizassist123';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// INIT GROQ
const groq = new Groq({ apiKey: GROQ_API_KEY });

// duplicate protection
const processedMessages = new Set();

// ================= WEBHOOK VERIFY =================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ================= MAIN WEBHOOK =================
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

        // duplicate stop
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);
        setTimeout(() => processedMessages.delete(messageId), 60000);

        console.log('User:', userMessage);

        const aiReply = await getAIReply(userMessage);
        console.log('AI:', aiReply);

        await sendMessage(senderId, aiReply);
      }
    }
  }
});

// ================= AI =================
async function getAIReply(message) {
  const chat = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',

    temperature: 0.2,

    messages: [
      {
        role: 'system',
        content: `
You are BizAssist AI.

RULES:
- Reply ONLY in same language (Bangla/English/Banglish)
- ONE short sentence only
- No extra explanation
- No greeting unless user greets
- No fake product or price
- If unknown product → "Not available"
- If order → "Please wait, seller will confirm your order."
        `
      },
      {
        role: 'user',
        content: message
      }
    ]
  });

  return chat.choices[0].message.content.trim();
}

// ================= SEND MESSAGE =================
async function sendMessage(recipientId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: message }
      }
    );

    console.log('Sent ✔');
  } catch (err) {
    console.error('Send Error:', err.response?.data || err.message);
  }
}

// ================= HOME =================
app.get('/', (req, res) => {
  res.send('BizAssist Running 🚀');
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on', PORT));
