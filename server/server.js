// server/server.js
// Express (static client/) + WebSocket (cùng port) + API leaderboard + điều khiển mock.
// Mọi sự kiện từ adapter được broadcast tới mọi client dạng JSON: { type, payload }.

import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createTikTokAdapter } from './tiktokAdapter.js';
import { createMockAdapter } from './mockAdapter.js';
import { getTop, addRoundResult } from './leaderboardStore.js';
import config from '../client/core/config.js';

// ---------- cấu hình ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const PORT = Number(process.env.PORT) || 3000;
const USERNAME = (process.env.TIKTOK_USERNAME || '').trim().replace(/^@/, '');
const LIKE_WINDOW_MS = 250; // gộp like trong cửa sổ này
const HEARTBEAT_MS = 30000;
const MAX_WS_BUFFER = 1_000_000; // bỏ qua client bị nghẽn (bytes)

let useMock = String(process.env.USE_MOCK).toLowerCase() === 'true';
const tiktokChatDiagnostics = { callbacks: 0, forwarded: 0, dropped: 0, last: null };
if (!useMock && !USERNAME) {
  console.warn('[server] Thiếu TIKTOK_USERNAME -> tự chuyển sang MOCK.');
  useMock = true;
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: config.leaderboard.bodyLimit }));
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin) {
    try {
      const url = new URL(origin);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
      }
    } catch {
      // Origin không hợp lệ sẽ không được cấp quyền CORS.
    }
  }
  next();
});

const hasIndex = fs.existsSync(path.join(CLIENT_DIR, 'index.html'));
if (!hasIndex) app.get('/', (_req, res) => res.redirect('/test.html')); // chưa có game -> mở trang test
app.use(express.static(CLIENT_DIR));

app.get('/health', (_req, res) => res.json({ ok: true, mock: useMock, clients: wss.clients.size }));

app.get('/api/diagnostics/tiktok-chat', (_req, res) => res.json(tiktokChatDiagnostics));

app.get('/api/leaderboard', async (req, res) => {
  try {
    res.json(await getTop(req.query));
  } catch (e) {
    if (e.status !== 400) console.error('[api] GET leaderboard lỗi:', e?.message ?? e);
    res.status(e.status === 400 ? 400 : 500).json({ error: e.status === 400 ? e.message : 'leaderboard_failed' });
  }
});

app.post('/api/leaderboard', async (req, res) => {
  try {
    if (!req.body || Array.isArray(req.body) || req.body.roundId === undefined || !Object.hasOwn(req.body, 'winnerId')) {
      return res.status(400).json({ error: 'Expected round:ended payload' });
    }
    res.json(await addRoundResult(req.body));
  } catch (e) {
    if (e.status !== 400) console.error('[api] POST leaderboard lỗi:', e?.message ?? e);
    res.status(e.status === 400 ? 400 : 500).json({ error: e.status === 400 ? e.message : 'leaderboard_failed' });
  }
});

// ---------- HTTP + WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server }); // cùng port, mọi đường dẫn upgrade

let lastStatus = { connected: false };

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_WS_BUFFER) continue;
    try {
      ws.send(msg);
    } catch (e) {
      console.warn('[ws] gửi lỗi:', e?.message ?? e);
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', (e) => console.warn('[ws] client lỗi:', e?.message ?? e));
  // Client mới vào được biết ngay trạng thái kết nối hiện tại
  try {
    ws.send(JSON.stringify({ type: 'live:status', payload: lastStatus }));
  } catch {
    /* bỏ qua */
  }
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* bỏ qua */
    }
  }
}, HEARTBEAT_MS);

// ---------- chống spam like: mỗi 250ms chỉ phát TỐI ĐA 1 sự kiện, cộng dồn likeCount ----------
// userId/nickname lấy của người thả tim gần nhất trong cửa sổ (đúng schema live:like).
let likeAcc = null; // { userId, nickname, likeCount, totalLikeCount }

function bufferLike(p) {
  if (!likeAcc) likeAcc = { ...p };
  else {
    likeAcc.userId = p.userId;
    likeAcc.nickname = p.nickname;
    likeAcc.likeCount += p.likeCount;
    likeAcc.totalLikeCount = Math.max(likeAcc.totalLikeCount, p.totalLikeCount);
  }
}

const likeFlush = setInterval(() => {
  if (!likeAcc) return;
  const out = likeAcc;
  likeAcc = null;
  broadcast('live:like', out);
}, LIKE_WINDOW_MS);

// ---------- nối adapter -> broadcast ----------
function handleEvent(type, payload) {
  if (type === 'live:like') return bufferLike(payload);
  broadcast(type, payload);
}
function handleStatus(payload) {
  lastStatus = payload;
  console.log('[live:status]', JSON.stringify(payload));
  broadcast('live:status', payload);
}

const adapter = useMock
  ? createMockAdapter({
      onEvent: handleEvent,
      onStatus: handleStatus,
      intensity: process.env.MOCK_INTENSITY || 'medium',
    })
  : createTikTokAdapter({
      username: USERNAME,
      onEvent: handleEvent,
      onStatus: handleStatus,
      onChatDiagnostic: (diagnostic) => {
        tiktokChatDiagnostics.callbacks += 1;
        if (diagnostic.accepted) tiktokChatDiagnostics.forwarded += 1;
        else tiktokChatDiagnostics.dropped += 1;
        tiktokChatDiagnostics.last = { ...diagnostic, receivedAt: new Date().toISOString() };
      },
      signApiKey: process.env.TIKTOK_SIGN_API_KEY || undefined,
    });

// ---------- điều khiển mock (chỉ khi USE_MOCK) ----------
const requireMock = (_req, res, next) =>
  useMock ? next() : res.status(404).json({ error: 'mock_disabled', hint: 'Đặt USE_MOCK=true' });

app.get('/mock.html', requireMock, (_req, res) => res.sendFile(path.resolve(__dirname, '..', 'test.html')));

// Body: { type:'live:chat', payload:{...} }  (hoặc phẳng: { type, text, userId, ... })
app.post('/mock/send', requireMock, (req, res) => {
  try {
    const { type, payload, ...rest } = req.body ?? {};
    res.json({ ok: true, sent: adapter.send(type, payload ?? rest) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

// Body: { intensity:'low'|'medium'|'high' }
app.post('/mock/intensity', requireMock, (req, res) => {
  try {
    res.json({ ok: true, intensity: adapter.setIntensity(req.body?.intensity) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get('/mock/status', requireMock, (_req, res) =>
  res.json({ intensity: adapter.getIntensity(), users: adapter.users.length })
);

// Lỗi chung (vd JSON hỏng) -> JSON, không crash
app.use((err, _req, res, _next) => {
  res.status(err?.status || 500).json({ error: err?.message ?? 'server_error' });
});

// ---------- khởi động / tắt ----------
server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  (ws cùng port)  chế độ: ${useMock ? 'MOCK' : `TIKTOK @${USERNAME}`}`);
  if (!hasIndex) console.log(`[server] Trang test: http://localhost:${PORT}/test.html`);
  adapter.connect().catch((e) => console.error('[server] adapter.connect lỗi:', e?.message ?? e));
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n[server] đang tắt...');
  clearInterval(heartbeat);
  clearInterval(likeFlush);
  try {
    await adapter.disconnect();
  } catch {
    /* bỏ qua */
  }
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Không để lỗi lẻ làm sập game
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message ?? e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message ?? e));
