const express = require('express');
const Groq = require('groq-sdk');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'bizassist123';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

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
    for (const entry of body.entry) {
      const event = entry.messaging[0];
      if (event.message && !event.message.is_echo) {
        const senderId = event.sender.id;
        const userMessage = event.message.text;
        console.log('Customer message:', userMessage);
        const aiReply = await getAIReply(userMessage);
        console.log('AI reply:', aiReply);
        await sendMessage(senderId, aiReply);
      }
    }
  }
});

async function getAIReply(message) {
  const chat = await groq.chat.completions.create({
    messages: [
      { role: 'system', content: 'You are a helpful shop assistant. Reply in Bengali or English based on customer message. Be concise and helpful.' },
      { role: 'user', content: message }
    ],
    model: 'llama3-70b-8192',
  });
  return chat.choices[0].message.content;
}

async function sendMessage(recipientId, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: message }
      }
    );
    console.log('Message sent successfully');
  } catch (error) {
    console.error('Error sending message:', error.response?.data);
  }
}

app.get('/', (req, res) => res.send('BizAssist Webhook is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
