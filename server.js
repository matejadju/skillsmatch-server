const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    hasKey: !!LIVEKIT_API_KEY,
    hasSecret: !!LIVEKIT_API_SECRET
  });
});

app.post('/token', async (req, res) => {
  const { roomName, identity } = req.body;

  if (!roomName || !identity) {
    return res.status(400).json({ error: 'roomName i identity su obavezni' });
  }

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: identity,
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt(); // ← async!

    return res.json({ token: token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));