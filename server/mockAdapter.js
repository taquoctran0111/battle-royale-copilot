// server/mockAdapter.js
// Giả lập sự kiện TikTok, CÙNG interface với tiktokAdapter:
//   createMockAdapter({ onEvent, onStatus, intensity }) -> { connect, disconnect, send, setIntensity, getIntensity }
// Payload sinh ra khớp đúng catalog live:*.
import { createMockActions, mockJoinText } from '../client/net/mockActions.js';

const INTENSITY = {
  //        chat (ms)      like (ms)   gift (ms)        social (ms)
  low:    { chat: [1500, 3200], like: 500, gift: [9000, 16000], social: [9000, 18000] },
  medium: { chat: [600, 1400],  like: 200, gift: [4000, 8000],  social: [5000, 11000] },
  high:   { chat: [150, 400],   like: 80,  gift: [1200, 2500],  social: [2500, 6000] },
};

// Quà mock theo tier (tier tính theo TỔNG kim cương = đơn giá * count)
const TIER_RANGE = { 1: [1, 9], 2: [10, 99], 3: [100, 499], 4: [500, Infinity] };
const GIFTS = {
  1: [{ id: 5001, name: 'Rose', unit: 1 }, { id: 5002, name: 'Finger Heart', unit: 5 }],
  2: [{ id: 5101, name: 'Doughnut', unit: 30 }, { id: 5102, name: 'Corgi', unit: 99 }],
  3: [{ id: 5201, name: 'Diamond Ring', unit: 299 }, { id: 5202, name: 'Money Gun', unit: 449 }],
  4: [{ id: 5301, name: 'Galaxy', unit: 1000 }, { id: 5302, name: 'Universe', unit: 34999 }],
};
const TIER_WEIGHTS = [[1, 60], [2, 28], [3, 10], [4, 2]];

const HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Ngô'];
const TEN = ['Minh', 'Lan', 'Hùng', 'Mai', 'Tuấn', 'Linh', 'Dũng', 'Hà', 'Nam', 'Thảo', 'Khoa', 'Vy', 'Long', 'Yến'];
const CHATTER = ['cố lên', 'hay quá', 'vào xem nè', '🔥🔥🔥', 'ai thắng vậy', 'chơi đi admin'];

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const weighted = (pairs) => {
  let r = Math.random() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[0][0];
};

/** Avatar SVG data-URI (không cần mạng). */
function avatarFor(name, i) {
  const ch = encodeURIComponent((name.trim().split(' ').pop() || '?')[0]);
  const hue = (i * 47) % 360;
  return (
    `data:image/svg+xml;utf8,` +
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' rx='32' fill='hsl(${hue},60%25,50%25)'/>` +
    `<text x='32' y='42' font-size='30' text-anchor='middle' fill='white' font-family='sans-serif'>${ch}</text></svg>`
  );
}

const LIVE_TYPES = new Set(['live:status', 'live:chat', 'live:gift', 'live:like', 'live:join', 'live:follow', 'live:share']);

export function createMockAdapter({ onEvent, onStatus, intensity = 'medium' } = {}) {
  let level = INTENSITY[intensity] ? intensity : 'medium';
  let running = false;
  const timers = new Set();
  let totalLikes = 0;

  // 30–60 người dùng ảo (ID số dạng chuỗi như TikTok userId)
  const users = Array.from({ length: randInt(30, 60) }, (_, i) => {
    const nickname = `${pick(HO)} ${pick(TEN)} ${i + 1}`;
    return {
      userId: String(7000000000000 + i),
      uniqueId: `user_${i + 1}`,
      nickname,
      avatarUrl: avatarFor(nickname, i),
    };
  });

  const emit = (type, payload) => {
    try {
      onEvent?.(type, payload);
    } catch (e) {
      console.error(`[mock] onEvent(${type}) lỗi:`, e?.message ?? e);
    }
  };
  const status = (payload) => {
    try {
      onStatus?.(payload);
    } catch (e) {
      console.error('[mock] onStatus lỗi:', e?.message ?? e);
    }
  };

  /** Lặp một tác vụ với độ trễ ngẫu nhiên lấy từ cấu hình cường độ hiện tại. */
  function loop(getDelay, fn) {
    const tick = () => {
      if (!running) return;
      try {
        fn();
      } catch (e) {
        console.error('[mock] lỗi sinh sự kiện:', e?.message ?? e);
      }
      schedule();
    };
    const schedule = () => {
      const t = setTimeout(() => {
        timers.delete(t);
        tick();
      }, getDelay());
      timers.add(t);
    };
    schedule();
  }

  // --- bộ sinh payload ---
  const userFields = (u) => ({ userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname, avatarUrl: u.avatarUrl });

  function genChat() {
    const u = pick(users);
    const other = pick(users.filter((x) => x !== u));
    const text = weighted([
      ['NÉ', 45],
      [mockJoinText(users.indexOf(u)), 10],
      [`CỨU ${other.nickname}`, 12],
      [pick(CHATTER), 15],
    ]);
    return ['live:chat', { ...userFields(u), text }];
  }

  function genGift(tier = weighted(TIER_WEIGHTS)) {
    const u = pick(users);
    const g = pick(GIFTS[tier]);
    const [lo, hi] = TIER_RANGE[tier];
    // count sao cho tổng vẫn nằm trong tier
    const maxCount = Number.isFinite(hi) ? Math.max(1, Math.floor(hi / g.unit)) : 2;
    const count = 1 + Math.floor(Math.random() * maxCount);
    let diamonds = g.unit * count;
    if (diamonds < lo || diamonds > hi) diamonds = g.unit; // an toàn
    return ['live:gift', { ...userFields(u), giftId: g.id, giftName: g.name, diamonds, count: diamonds === g.unit ? 1 : count }];
  }

  function genLike() {
    const u = pick(users);
    const likeCount = randInt(1, 5);
    totalLikes += likeCount;
    return ['live:like', { userId: u.userId, nickname: u.nickname, likeCount, totalLikeCount: totalLikes }];
  }

  const genJoin = () => ['live:join', userFields(pick(users))];
  const genSocial = () => {
    const u = pick(users);
    return [Math.random() < 0.6 ? 'live:follow' : 'live:share', { userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname }];
  };

  const emitGen = (gen) => {
    const [t, p] = gen();
    emit(t, p);
  };

  /**
   * Gửi tay 1 sự kiện (phục vụ POST /mock/send). Trường thiếu được điền tự động.
   * Ném Error nếu type không hợp lệ.
   */
  function send(type, payload = {}) {
    if (!LIVE_TYPES.has(type) || type === 'live:status') {
      throw new Error(`type không hợp lệ: ${type}. Hợp lệ: ${[...LIVE_TYPES].filter((t) => t !== 'live:status').join(', ')}`);
    }
    const p = payload && typeof payload === 'object' ? payload : {};
    const found = users.find((x) => x.userId === String(p.userId) || x.uniqueId === p.uniqueId || x.nickname === p.nickname);
    const base = found ?? pick(users);
    const user = {
      userId: String(p.userId ?? base.userId),
      uniqueId: String(p.uniqueId ?? base.uniqueId),
      nickname: String(p.nickname ?? base.nickname),
      avatarUrl: String(p.avatarUrl ?? base.avatarUrl),
    };

    let out;
    switch (type) {
      case 'live:chat':
        out = { ...user, text: String(p.text ?? 'NÉ') };
        break;
      case 'live:gift': {
        const count = Math.max(1, Number(p.count) || 1);
        const diamonds = Number(p.diamonds) > 0 ? Number(p.diamonds) : (Number(p.unitDiamonds) || 1) * count;
        out = { ...user, giftId: Number(p.giftId) || 9999, giftName: String(p.giftName ?? 'ManualGift'), diamonds, count };
        break;
      }
      case 'live:like': {
        const likeCount = Math.max(1, Number(p.likeCount) || 1);
        totalLikes += likeCount;
        out = { userId: user.userId, nickname: user.nickname, likeCount, totalLikeCount: Number(p.totalLikeCount) || totalLikes };
        break;
      }
      case 'live:join':
        out = user;
        break;
      default: // follow | share
        out = { userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname };
    }
    emit(type, out);
    return { type, payload: out };
  }

  return {
    async connect() {
      if (running) return;
      running = true;
      status({ connected: true, roomId: 'mock_room' });

      // Người xem lần lượt vào phòng trong vài giây đầu
      users.forEach((u, i) => {
        const t = setTimeout(() => {
          timers.delete(t);
          if (running) {
            emit('live:join', userFields(u));
            emit('live:chat', { ...userFields(u), text: mockJoinText(i) });
          }
        }, 200 + i * 80);
        timers.add(t);
      });

      const cfg = () => INTENSITY[level];
      const actions = createMockActions({ emit, getUsers: () => users });
      loop(() => 1000, () => actions.update());
      loop(() => rand(...cfg().chat), () => emitGen(genChat));
      loop(() => cfg().like * rand(0.6, 1.4), () => emitGen(genLike));
      loop(() => rand(...cfg().gift), () => emitGen(genGift));
      loop(() => rand(...cfg().social), () => emitGen(Math.random() < 0.5 ? genJoin : genSocial));
    },

    async disconnect() {
      running = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      status({ connected: false });
    },

    send,
    users, // để test/debug
    getIntensity: () => level,
    setIntensity(next) {
      if (!INTENSITY[next]) throw new Error(`intensity không hợp lệ: ${next}. Hợp lệ: low | medium | high`);
      level = next;
      return level;
    },
  };
}
