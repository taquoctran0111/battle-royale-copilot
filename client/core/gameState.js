// client/core/gameState.js — nguồn sự thật duy nhất. Chỉ chứa dữ liệu + vài hàm truy vấn/reset.
import { normalizeText } from './utils.js';

/** Tạo state mới theo config. */
export function createState(config) {
  const { w, h } = config.arena;
  const cx = w / 2, cy = h / 2;
  const state = {
    phase: 'LOBBY',
    roundId: 0,
    phaseEndsAt: 0,
    time: 0,                                   // giây trôi qua trong ván (dùng cho cooldown...)
    arena: { w, h, cx, cy },
    players: new Map(),
    zone: { cx, cy, radius: config.zone.initialRadius, targetRadius: config.zone.initialRadius },
    drops: [],
    traps: [],
    boss: null,
    mode: 'battle',
    raidOutcome: null,
    nextRoundReward: null,
    alliances: new Map(),
    giftTargets: new Map(),
    energy: { value: 0, max: config.events.energy.max },
    killFeed: [],
    bountyId: null,
  };
  // Giữ config không enumerable để state vẫn đúng cấu trúc hợp đồng khi log/serialize.
  Object.defineProperty(state, '_config', { value: config, enumerable: false });
  return state;
}

/** Đưa người chơi về trạng thái đầu ván (giữ id/name/avatar/class). */
function resetPlayerForRound(p) {
  Object.assign(p, {
    vx: 0, vy: 0,
    mana: 0,
    bossSlowUntil: 0, bossSlowMult: 1,
    shield: 0, weaponLevel: 0, buffs: [],
    status: 'alive',
    kills: 0, streak: 0, damageDealt: 0, giftValue: 0, placement: 0,
    targetId: null, intent: 'normal',
    cooldowns: { dodge: 0, ally: 0, betray: 0 },
  });
}

/**
 * Reset dữ liệu theo ván. Thay đổi TẠI CHỖ (các system đang giữ tham chiếu state).
 * KHÔNG đổi phase/roundId — việc đó thuộc RoundManager.
 * @param {{keepPlayers?:boolean}} opts keepPlayers=true: giữ người thật (xóa bot, reset chỉ số); mặc định xóa hết.
 */
export function resetRound(state, { keepPlayers = false } = {}) {
  const config = state._config;
  state.time = 0;
  state.phaseEndsAt = 0;
  state.zone.cx = state.arena.cx;
  state.zone.cy = state.arena.cy;
  state.zone.radius = state.zone.targetRadius = config.zone.initialRadius;
  state.drops.length = 0;
  state.traps.length = 0;
  state.boss = null;
  state.mode = 'battle';
  state.raidOutcome = null;
  state.nextRoundReward = null;
  state.alliances.clear();
  state.giftTargets.clear();
  state.energy.value = 0;
  state.killFeed.length = 0;
  state.bountyId = null;

  if (!keepPlayers) {
    state.players.clear();
  } else {
    for (const [id, p] of state.players) {
      if (p.isBot && p.bossSlayerRound !== state.roundId + 1) state.players.delete(id);
      else resetPlayerForRound(p);
    }
  }
}

/** Danh sách người chơi còn sống. */
export function getAlive(state) {
  const out = [];
  for (const p of state.players.values()) if (p.status === 'alive') out.push(p);
  return out;
}

/**
 * Tìm người chơi theo tên (bỏ dấu, không phân biệt hoa thường).
 * Ưu tiên: khớp chính xác > bắt đầu bằng > chứa; trong cùng mức ưu tiên người đang sống được chọn trước.
 * @returns {object|null}
 */
export function getPlayerByName(state, name, { aliveOnly = false } = {}) {
  const q = normalizeText(name);
  if (!q) return null;
  let best = null, bestScore = 0;
  for (const p of state.players.values()) {
    if (aliveOnly && p.status !== 'alive') continue;
    const n = normalizeText(p.name);
    let score = 0;
    if (n === q) score = 3;
    else if (n.startsWith(q)) score = 2;
    else if (n.includes(q)) score = 1;
    if (!score) continue;
    if (p.status === 'alive') score += 0.5;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}
