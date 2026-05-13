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
const LIVEKIT_WS_URL     = process.env.LIVEKIT_WS_URL; // wss://your.livekit.server

// ─── Firebase Admin init ─────────────────────────────────────────────────────
// Render.com: env varijable ne podržavaju dobro višelinijski JSON,
// pa koristimo base64 enkodiran service account.
//
// Lokalno generiši string:
//   base64 -i serviceAccountKey.json | tr -d '\n'
// Pa dodaj kao FIREBASE_SERVICE_ACCOUNT_B64 u Render dashboard.
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
// VAŽNO: data-only (bez "notification" ključa) + priority high
// → garantuje isporuku čak i kada je app ubijen
async function sendCallPush(fcmToken, payload) {
  const message = {
    token: fcmToken,
    data: {
      type:          'incoming_call',
      roomName:      payload.roomName,
      callerName:    payload.callerName,
      callerToken:   payload.callerToken, // LiveKit token za callera (za display)
      receiverToken: payload.receiverToken,
      liveKitUrl:    LIVEKIT_WS_URL,
      callId:        payload.callId,
    },
    android: {
      priority: 'high',
      ttl:      30000, // 30s — ako za 30s nije primljeno, brisati
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'voip', // iOS: mora biti voip za CallKit
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

// Postojeći endpoint — ostavljen nepromijenjen
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
// Body: { callerIdentity, receiverIdentity, receiverFcmToken, callerName }
app.post('/call/initiate', async (req, res) => {
  const { callerIdentity, receiverIdentity, receiverFcmToken, callerName } = req.body;

  if (!callerIdentity || !receiverIdentity || !receiverFcmToken) {
    return res.status(400).json({ error: 'callerIdentity, receiverIdentity i receiverFcmToken su obavezni' });
  }

  try {
    // Oba učesnika dijele istu sobu
    const callId   = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const roomName = `room_${callId}`;

    // Generiši tokene za oba
    const [callerToken, receiverToken] = await Promise.all([
      createToken(roomName, callerIdentity),
      createToken(roomName, receiverIdentity),
    ]);

    // Pošalji push primaocu
    await sendCallPush(receiverFcmToken, {
      callId,
      roomName,
      callerName:    callerName || callerIdentity,
      callerToken,
      receiverToken,
    });

    // Vrati calleru sve što mu treba za ConnectScreen
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

// ─── Novi endpoint: answer / decline (opcionalni signaling) ──────────────────
// Ako koristiš LiveKit Data Channels za signaling, ovi endpointi nisu nužni.
// Korisni su ako trebaš obavijestiti callera server-side (npr. log, timeout).

app.post('/call/answer', async (req, res) => {
  const { callId, receiverIdentity } = req.body;
  // Ovdje možeš: notifikovati callera da je poziv prihvaćen, pokrenuti timer, itd.
  console.log(`Call ${callId} answered by ${receiverIdentity}`);
  return res.json({ status: 'answered', callId });
});

app.post('/call/decline', async (req, res) => {
  const { callId, callerFcmToken } = req.body;

  // Opcionalno: pošalji push calleru da je poziv odbijen
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

  // Render free tier spušta server nakon 15min neaktivnosti.
  // Ovo ga pinga svako 14 minuta da ostane budan.
  // RENDER_EXTERNAL_URL je automatski dostupan na Render platformi.
  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  if (SELF_URL) {
    setInterval(() => {
      fetch(`${SELF_URL}/health`)
        .then(() => console.log('Keep-alive ping sent'))
        .catch(err => console.error('Keep-alive failed:', err));
    }, 14 * 60 * 1000);
  }
});