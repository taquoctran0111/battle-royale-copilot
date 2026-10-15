// client/net/wsClient.js — nhận { type, payload } từ server và bus.emit(type, payload).
// Tự reconnect (backoff + jitter). ?local=1 => sinh sự kiện giả ngay trong trình duyệt.
import { pick, randInt, randRange } from '../core/utils.js';

export async function resolveBackendUrl({ location, config, fetchImpl = globalThis.fetch }) {
  const server = new URLSearchParams(location.search).get('server');
  if (server) return new URL(server, location.href);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.net.backendProbeTimeoutMs);
  try {
    const response = await fetchImpl(new URL('/health', location.origin), { signal: controller.signal });
    if (response.ok) {
      const health = await response.json();
      if (health.ok === true && typeof health.mock === 'boolean' && typeof health.clients === 'number') {
        return new URL(location.origin);
      }
    }
  } catch {
    // Static previews do not expose the game backend's health endpoint.
  } finally {
    clearTimeout(timeout);
  }
  return new URL(`${location.protocol}//${location.hostname}:${config.net.backendPort}`);
}

const FAKE_NAMES = ['Minh Anh', 'Đức Huy', 'Thảo Nguyên', 'Quốc Bảo', 'Ngọc Lan', 'Hoàng Long', 'Phương Linh',
  'Tuấn Kiệt', 'Bích Ngọc', 'Gia Hân', 'Văn Toàn', 'Khánh Vy', 'Thành Đạt', 'Mỹ Duyên', 'Trung Hiếu',
  'Hải Yến', 'Đình Phúc', 'Lan Chi', 'Việt Hùng', 'Thu Hà', 'Nhật Nam', 'Cẩm Tú', 'Bảo Châu', 'Anh Tuấn',
  'Kim Ngân', 'Hữu Nghĩa', 'Diễm My', 'Tấn Phát'];
const FAKE_GIFTS = [
  { giftId: 1, giftName: 'Rose', unit: 1 }, { giftId: 2, giftName: 'Heart', unit: 5 },
  { giftId: 3, giftName: 'Perfume', unit: 20 }, { giftId: 4, giftName: 'Galaxy', unit: 100 },
  { giftId: 5, giftName: 'Lion', unit: 500 }, { giftId: 6, giftName: 'Universe', unit: 1000 },
];

/**
 * @param {{bus, config, url?:string, local?:boolean}} opts
 * @returns {{connect(), send(type,payload), update(dt), dispose(), isLocal:boolean}}
 */
export function createWsClient({ bus, config, url, local } = {}) {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const isLocal = local ?? params.get('local') === '1';
  const cfg = config.net;

  let ws = null;
  let attempts = 0;
  let reconnectTimer = null;
  let disposed = false;
  let lastConnected = null;          // trạng thái đã báo gần nhất (tránh spam live:status)
  let lastError;
  const localTimers = [];

  /** Emit an toàn: không để lỗi làm sập client. */
  function safeEmit(type, payload) {
    try { bus.emit(type, payload); } catch (e) { console.error('[ws] emit lỗi', type, e); }
  }
  /** Chỉ phát live:status khi trạng thái đổi. */
  function setStatus(connected, extra = {}) {
    const { force = false, ...details } = extra;
    if (lastConnected === connected && !force) return;
    lastConnected = connected;
    safeEmit('live:status', { connected, ...details });
  }

  function resolveUrl() {
    if (url) return url;
    const override = params.get('ws');
    if (override) return override;
    const loc = globalThis.location;
    if (!loc) return `ws://localhost:3000${cfg.wsPath}`;
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${cfg.wsPath}`;
  }

  // ---------- Chế độ WebSocket thật ----------
  function open() {
    if (disposed) return;
    try {
      ws = new WebSocket(resolveUrl());
    } catch (err) {
      lastError = String(err?.message || err);
      return scheduleReconnect();
    }
    ws.onopen = () => {
      attempts = 0;
      lastError = undefined;
      setStatus(true);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return console.warn('[ws] bỏ qua gói không phải JSON'); }
      if (!msg || typeof msg.type !== 'string') return;
      safeEmit(msg.type, msg.payload);
    };
    ws.onerror = () => { lastError = 'Lỗi kết nối WebSocket'; };
    ws.onclose = () => {
      ws = null;
      if (disposed) return;
      setStatus(false, { error: lastError || 'Mất kết nối server' });
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    const base = Math.min(cfg.reconnectMaxMs, cfg.reconnectMinMs * Math.pow(cfg.backoffFactor, attempts++));
    const delay = base * randRange(0.8, 1.2); // jitter
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, delay);
  }

  // ---------- Chế độ local (sự kiện giả) ----------
  function startLocal() {
    const L = cfg.local;
    const cmd = config.commands;
    const users = FAKE_NAMES.slice(0, L.userPool).map((nickname, i) => ({
      userId: `local_${i + 1}`, uniqueId: `user${i + 1}`, nickname,
      avatarUrl: '', joined: false,
    }));
    let totalLikes = 0, joinIdx = 0;

    setStatus(true, { roomId: 'local', force: true });

    // Lần lượt cho người xem "vào phòng" và comment join
    localTimers.push(setInterval(() => {
      if (joinIdx >= users.length) return;
      const u = users[joinIdx++];
      u.joined = true;
      safeEmit('live:join', { userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname, avatarUrl: u.avatarUrl });
      safeEmit('live:chat', { userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname, avatarUrl: u.avatarUrl, text: cmd.join[0] });
    }, L.joinIntervalMs));

    // Hành động ngẫu nhiên của người đã join
    localTimers.push(setInterval(() => {
      const joined = users.filter((u) => u.joined);
      if (!joined.length) return;
      const u = pick(joined);
      const other = pick(joined.filter((x) => x !== u)) || u;
      const base = { userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname, avatarUrl: u.avatarUrl };
      const r = Math.random();

      if (r < L.giftChance) {
        const g = pick(FAKE_GIFTS);
        const count = g.unit <= 5 ? randInt(1, 5) : 1;
        safeEmit('live:gift', { ...base, giftId: g.giftId, giftName: g.giftName, diamonds: g.unit * count, count });
      } else if (r < L.giftChance + L.likeChance) {
        const likeCount = randInt(1, 15);
        totalLikes += likeCount;
        safeEmit('live:like', { userId: u.userId, nickname: u.nickname, likeCount, totalLikeCount: totalLikes });
      } else if (r < L.giftChance + L.likeChance + L.followChance) {
        safeEmit('live:follow', { userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname });
      } else if (r < L.giftChance + L.likeChance + L.followChance + L.shareChance) {
        safeEmit('live:share', { userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname });
      } else {
        const texts = [
          pick(cmd.attack), pick(cmd.attack), pick(cmd.dodge),
          `${pick(cmd.ally)} ${other.nickname}`, pick(cmd.betray),
          `${pick(cmd.rescue)} ${other.nickname}`, 'cố lên mọi người ơi',
        ];
        safeEmit('live:chat', { ...base, text: pick(texts) });
      }
    }, L.eventIntervalMs));
  }

  // ---------- API ----------
  function connect() {
    if (disposed) return;
    if (isLocal) startLocal(); else open();
  }

  /** Gửi lên server (nếu đang mở). Trả về true nếu gửi được. */
  function send(type, payload) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify({ type, payload })); return true; } catch { return false; }
  }

  /** Gỡ sạch timer/socket. */
  function dispose() {
    disposed = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    localTimers.splice(0).forEach(clearInterval);
    if (ws) { ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null; try { ws.close(); } catch {} ws = null; }
  }

  // update(dt) có mặt cho đúng quy ước module (wsClient không cần tick)
  return { connect, send, update() {}, dispose, isLocal };
}
