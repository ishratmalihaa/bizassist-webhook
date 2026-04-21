const express = require('express');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = 'bizassist123';

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  console.log('Verify attempt:', mode, token);
  
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK VERIFIED');
      return res.status(200).send(challenge);
    }
  }
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  console.log('Message received:', JSON.stringify(req.body));
  res.status(200).send('EVENT_RECEIVED');
});

app.get('/', (req, res) => {
  res.send('BizAssist Webhook Server is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
