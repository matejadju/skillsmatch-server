const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── ENV ────────────────────────────────────────────────────────────────────
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_WS_URL     = process.env.LIVEKIT_WS_URL;

// ─── Firebase Admin init ─────────────────────────────────────────────────────
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ─── Helper: generiši LiveKit token ─────────────────────────────────────────
async function createToken(roomName, identity) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity });
  at.addGrant({
    roomJoin:     true,
    room:         roomName,
    canPublish:   true,
    canSubscribe: true,
  });
  return at.toJwt();
}

// ─── Helper: pošalji FCM data-only push ─────────────────────────────────────
async function sendCallPush(fcmToken, payload) {
  const message = {
    token: fcmToken,
    data: {
      type:          'incoming_call',
      roomName:      payload.roomName,
      callerName:    payload.callerName,
      callerToken:   payload.callerToken,
      receiverToken: payload.receiverToken,
      liveKitUrl:    LIVEKIT_WS_URL,
      callId:        payload.callId,
      isVideoCall:   String(payload.isVideoCall ?? false),
    },
    android: {
      priority: 'high',
      ttl:      30000,
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'voip',
      },
    },
  };

  return admin.messaging().send(message);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    hasKey:    !!LIVEKIT_API_KEY,
    hasSecret: !!LIVEKIT_API_SECRET,
    hasUrl:    !!LIVEKIT_WS_URL,
  });
});

app.post('/token', async (req, res) => {
  const { roomName, identity } = req.body;
  if (!roomName || !identity) {
    return res.status(400).json({ error: 'roomName i identity su obavezni' });
  }
  try {
    const token = await createToken(roomName, identity);
    return res.json({ token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

// ─── Novi endpoint: initiate call ────────────────────────────────────────────
// Body: { callerIdentity, receiverIdentity, receiverFcmToken, callerName, isVideoCall }
app.post('/call/initiate', async (req, res) => {
  // ✅ FIX: čitamo isVideoCall iz request body
  const { callerIdentity, receiverIdentity, receiverFcmToken, callerName, isVideoCall } = req.body;

  if (!callerIdentity || !receiverIdentity || !receiverFcmToken) {
    return res.status(400).json({ error: 'callerIdentity, receiverIdentity i receiverFcmToken su obavezni' });
  }

  try {
    const callId   = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const roomName = `room_${callId}`;

    const [callerToken, receiverToken] = await Promise.all([
      createToken(roomName, callerIdentity),
      createToken(roomName, receiverIdentity),
    ]);

    // ✅ FIX: proslijeđujemo isVideoCall u sendCallPush
    await sendCallPush(receiverFcmToken, {
      callId,
      roomName,
      callerName:  callerName || callerIdentity,
      callerToken,
      receiverToken,
      isVideoCall: isVideoCall ?? true, // default true ako nije poslano
    });

    return res.json({
      callId,
      roomName,
      token:      callerToken,
      liveKitUrl: LIVEKIT_WS_URL,
    });
  } catch (e) {
    console.error('/call/initiate error:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/call/answer', async (req, res) => {
  const { callId, receiverIdentity } = req.body;
  console.log(`Call ${callId} answered by ${receiverIdentity}`);
  return res.json({ status: 'answered', callId });
});

app.post('/call/decline', async (req, res) => {
  const { callId, callerFcmToken } = req.body;

  if (callerFcmToken) {
    await admin.messaging().send({
      token: callerFcmToken,
      data:  { type: 'call_declined', callId },
      android: { priority: 'high' },
    }).catch(err => console.error('Decline push failed:', err));
  }

  console.log(`Call ${callId} declined`);
  return res.json({ status: 'declined', callId });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  if (SELF_URL) {
    setInterval(() => {
      fetch(`${SELF_URL}/health`)
        .then(() => console.log('Keep-alive ping sent'))
        .catch(err => console.error('Keep-alive failed:', err));
    }, 14 * 60 * 1000);
  }
});