const express = require('express');
const Groq = require('groq-sdk');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'bizassist123';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const processedMessages = new Set();

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
    const { data: products, error } = await supabase
      .from('products')
      .select('product_name, price_bdt, stock_availability, color, description');

    if (error) {
      console.error('Supabase error:', error);
      return 'Sorry, something went wrong.';
    }

    console.log('Products from DB:', products);

    const productList = products.map(p =>
      `${p.product_name}: price ${p.price_bdt} BDT, color: ${p.color}, stock: ${p.stock_availability}, description: ${p.description}`
    ).join('\n');

    const chat = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are BizAssist AI, a helpful shop assistant.
Here are the available products:
${productList}

RULES:
- Reply in the SAME language as the customer (Bengali/English/Banglish)
- Keep reply SHORT (1-2 sentences max)
- Only use product info from the list above
- If product not found, say not available
- Never make up prices or products
- If customer asks for price, give exact price from the list`
        },
        {
          role: 'user',
          content: userMessage
        }
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

app.get('/', (req, res) => res.send('BizAssist Webhook Running! 🚀'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
