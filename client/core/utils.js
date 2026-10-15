// client/core/utils.js — tiện ích dùng chung (không phụ thuộc module nào khác)

/** Bỏ dấu tiếng Việt, lowercase, trim, gộp khoảng trắng. "ĐÁNH " -> "danh" */
export function normalizeText(str) {
  return String(str ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // xóa dấu tổ hợp
    .replace(/đ/g, 'd')              // đ không tách được bằng NFD
    .replace(/\s+/g, ' ')
    .trim();
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const distXY = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);
export const areAllied = (player, other) => Boolean(player.allianceId &&
  (player.allianceId === other.id || other.allianceId === player.id || player.allianceId === other.allianceId));

export function getEffectiveStats(player, config, nowMs, { dodging = false } = {}) {
  const buffs = player.buffs.filter((buff) => buff.until > nowMs);
  const attackBonus = buffs.filter((buff) => buff.type === 'weapon' || buff.type === 'rage')
    .reduce((total, buff) => total + Math.max(0, buff.value - 1), 0) +
    clamp(player.weaponLevel, 0, config.combat.maxWeaponLevel) * config.combat.weaponLevelAtkBonus +
    (player.allianceId ? config.alliance.buff.atkMult - 1 : 0);
  const speedMult = buffs.filter((buff) => buff.type === 'speed').reduce((total, buff) => total * buff.value, 1) *
    (dodging ? config.combat.dodge.speedMult : 1) * (player.allianceId ? config.alliance.buff.speedMult : 1);
  return {
    atk: player.atk * (1 + clamp(attackBonus, 0, config.gifts.buffCaps.attackBonus)),
    def: player.def * (player.allianceId ? config.alliance.buff.defMult : 1),
    speed: player.speed * clamp(speedMult, 1, config.gifts.buffCaps.speedMult) *
      (player.bossSlowUntil > nowMs / 1000 ? player.bossSlowMult : 1),
    range: player.range,
    attackInterval: player.attackInterval,
  };
}

/** Số thực ngẫu nhiên trong [min, max). rng mặc định Math.random */
export const randRange = (min, max, rng = Math.random) => min + (max - min) * rng();
/** Số nguyên ngẫu nhiên trong [min, max] */
export const randInt = (min, max, rng = Math.random) => Math.floor(randRange(min, max + 1, rng));
/** Chọn phần tử ngẫu nhiên; mảng rỗng -> undefined */
export const pick = (arr, rng = Math.random) => (arr && arr.length ? arr[Math.floor(rng() * arr.length)] : undefined);

/** RNG có seed (mulberry32) để tái lập ván đấu / test. */
export function createRng(seed = Date.now()) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (a, b) => randRange(a, b, next),
    int: (a, b) => randInt(a, b, next),
    pick: (arr) => pick(arr, next),
  };
}

/** Bộ sinh id tăng dần: const gen = createIdGenerator('drop'); gen() -> "drop_1" */
export function createIdGenerator(prefix = 'id') {
  let n = 0;
  return () => `${prefix}_${++n}`;
}
let _uid = 0;
/** Id duy nhất toàn cục (drop, trap, effect...) */
export const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}${(++_uid).toString(36)}`;
/** ID bot theo hợp đồng: bắt đầu bằng "bot_" */
export const botId = (n) => `bot_${n}`;
export const isBotId = (id) => typeof id === 'string' && id.startsWith('bot_');

/**
 * Tìm tier quà theo tổng kim cương. tiers = config.gifts.tiers.
 * Trả về object tier ({tier,min,max,...}) hoặc null nếu diamonds < 1.
 */
export function getGiftTier(tiers, diamonds) {
  const d = Number(diamonds) || 0;
  for (const t of tiers) if (d >= t.min && d <= t.max) return t;
  return null;
}
