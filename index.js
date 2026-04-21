const express = require('express');
const Groq = require('groq-sdk');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'bizassist123';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
      if (event.message) {
        const userMessage = event.message.text;
        console.log('Customer message:', userMessage);
        const aiReply = await getAIReply(userMessage);
        console.log('AI reply:', aiReply);
      }
    }
  }
});

async function getAIReply(message) {
  const chat = await groq.chat.completions.create({
    messages: [
      { role: 'system', content: 'You are a helpful shop assistant. Reply in Bengali or English based on customer message.' },
      { role: 'user', content: message }
    ],
    model: 'llama3-8b-8192',
  });
  return chat.choices[0].message.content;
}

app.get('/', (req, res) => res.send('BizAssist Webhook is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
