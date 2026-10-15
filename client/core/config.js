// client/core/config.js — MỌI hằng số cân bằng/thời gian/từ khóa nằm ở đây.
// Đơn vị: thời gian "Sec" = giây, "Ms" = mili-giây; khoảng cách = pixel; speed = px/giây.

const config = {
  // ---- Chung ----
  debug: false,                       // true: EventBus log mọi event
  arena: { w: 1080, h: 1920 },        // độ phân giải Browser Source (đổi được)
  tickRate: 30,                       // logic tick/giây (render chạy 60fps riêng)
  runtime: { maxFrameDeltaMs: 100, maxStepsPerFrame: 5, systemErrorLimit: 3, maxArenaDimension: 4096, clockDriftToleranceMs: 250 },
  botNames: ['Gà Né Đòn', 'Ốc Tăng Tốc', 'Vua Chạy Bộ', 'Kiếm Sĩ Ngủ Gật', 'Pháp Sư Hết Mana', 'Tank Sợ Đau', 'Cung Thủ Cận Thị', 'Bánh Mì Bất Bại'],

  // ---- Mạng ----
  net: {
    backendPort: 3000,
    backendProbeTimeoutMs: 1500,
    wsPath: '/ws',                    // URL = ws(s)://<host><wsPath>, ghi đè bằng ?ws=ws://...
    reconnectMinMs: 1000,
    reconnectMaxMs: 15000,
    backoffFactor: 1.7,
    // Chế độ offline (?local=1): tự sinh sự kiện giả
    local: {
      userPool: 28,                   // số người xem giả
      joinIntervalMs: 700,            // nhịp "join" lần lượt
      eventIntervalMs: 450,           // nhịp sự kiện giả sau khi join
      giftChance: 0.12,
      likeChance: 0.25,
      followChance: 0.03,
      shareChance: 0.03,
    },
  },

  // ---- Vòng đời ván ----
  phases: {
    durationSec: { LOBBY: 45, COUNTDOWN: 5, BATTLE: 150, FINAL: 45, RESULT: 10 },
    finalThresholdAlive: 5,           // còn <= 5 người sống -> vào FINAL
  },

  lobby: {
    minPlayers: 2,                    // dưới ngưỡng này sẽ bù bot
    botFillTo: 20,                    // bù bot cho đủ số người
    maxPlayers: 40,
  },

  // ---- Class nhân vật ----
  classes: {
    swordsman: { id: 'swordsman', name: 'Kiếm sĩ',  color: '#ff7043', hp: 120, atk: 18, def: 8,  speed: 130, range: 60,  attackInterval: 800 },
    archer:    { id: 'archer',    name: 'Cung thủ', color: '#66bb6a', hp: 90,  atk: 14, def: 4,  speed: 145, range: 320, attackInterval: 1000 },
    mage:      { id: 'mage',      name: 'Pháp sư',  color: '#ab47bc', hp: 80,  atk: 22, def: 3,  speed: 120, range: 260, attackInterval: 1400 },
    tank:      { id: 'tank',      name: 'Tank',     color: '#42a5f5', hp: 200, atk: 21, def: 18, speed: 100, range: 55,  attackInterval: 1000 },
  },
  classOrder: ['swordsman', 'archer', 'mage', 'tank'],   // thứ tự random/gán class

  // ---- Chiến đấu ----
  combat: {
    critChance: 0.1,
    critMult: 1.5,
    armorCauses: ['attack', 'boss', 'betray'], // môi trường gây sát thương trực tiếp
    minDamage: 1,
    attackBoostMult: 1.6,             // lệnh "đánh": tăng sát thương/tốc đánh tạm thời
    attackBoostSpeedMult: 1.6,
    attackBoostDurationMs: 3000,
    dodge: { durationMs: 700, speedMult: 1.5, damageReduction: 0.8 },
    cooldownMs: { attack: 4000, dodge: 6000, ally: 8000, betray: 10000 },  // theo từng lệnh
    maxWeaponLevel: 5,
    weaponLevelAtkBonus: 0.12,        // +12% atk mỗi cấp vũ khí
    reviveInvulnMs: 2000,
    targetScanIntervalMs: 350,
  },
  movement: {
    arriveDistance: 0.9, velocitySmoothing: 0.18,
    bountyWeight: 1.6, dropPriorityRadius: 220,
    rangedClasses: ['archer', 'mage'], retreatRangeRatio: 0.55,
    separationPadding: 6, separationStrength: 0.8,
    zoneInset: 30, betrayPriorityDurationMs: 2000,
  },

  // ---- Vùng thu hẹp (mốc tính từ lúc BATTLE bắt đầu, gồm cả giai đoạn FINAL) ----
  zone: {
    initialRadius: 900,
    stages: [
      { atSec: 30,  radius: 700, shrinkSec: 10, dps: 3 },
      { atSec: 60,  radius: 520, shrinkSec: 10, dps: 5 },
      { atSec: 90,  radius: 360, shrinkSec: 10, dps: 8 },
      { atSec: 120, radius: 240, shrinkSec: 10, dps: 12 },
      { atSec: 150, radius: 140, shrinkSec: 8,  dps: 16 },
      { atSec: 175, radius: 60,  shrinkSec: 8,  dps: 22 },
    ],
    baseDps: 2,                       // sát thương/giây ngoài vùng trước mốc đầu tiên
    damageTickMs: 1000,
  },

  // ---- Sự kiện ngẫu nhiên & năng lượng ----
  events: {
    intervalSec: [25, 40],            // chu kỳ ngẫu nhiên [min, max]
    energy: {
      max: 100,
      triggerThreshold: 100,          // đầy năng lượng -> kích hoạt sự kiện
      perLike: 0.05,
      perFollow: 3,
      perShare: 5,
      perDiamond: 0.1,
      perChat: 0.02,
      resetAfterTrigger: 0,
    },
    list: [
      { type: 'storm',    weight: 3, durationSec: 12, dps: 6 },
      { type: 'bombRain', weight: 3, durationSec: 10, bombs: 14, damage: 35, radius: 90 },
      { type: 'meteor',   weight: 2, durationSec: 6,  count: 5,  damage: 60, radius: 120 },
      { type: 'boss',     weight: 1, hp: 1500, atk: 25, speed: 90, minAliveToSpawn: 6, rewardHealPercent: 0.5 },
    ],
    trapSpawnSec: [10, 20],           // chu kỳ đặt bẫy
    dropSpawnSec: [12, 20],
    dropLifetimeMs: 18000,
    automaticDropTier: 1,
    hotspotRadius: 180,
    hotspotScatterRadius: 60,
    spikeChance: 0.65,
    bossMinAlive: 4,
    bossRewardWinners: 1,
    bossRewardHealPercent: 0.5,
    traps: { spike: { damage: 25, radius: 40 }, bomb: { damage: 45, radius: 100, fuseMs: 1500 } },
    dropRadius: 30,
    bossAttackRadius: 90,
    bossAttackIntervalMs: 1800,
    bossRewardRows: 3,
  },

  // ---- Quà tặng ----
  gifts: {
    giftTargetTtlMs: 30000,           // "CỨU [tên]" có hiệu lực 30s
    maxRevivesPerRound: 2,
    maxHealCount: 5,
    blockBountyGiftShield: true,
    supplyScatterRadius: 70,
    maxBuffDurationMs: 30000,
    buffCaps: { shield: 100, speedMult: 2, attackBonus: 2, perType: 4 },
    dropHealPercent: 0.25,
    tiers: [
      { tier: 1, min: 1,   max: 9,   healAmount: 20, speedBuff: { mult: 1.3, durationMs: 4000 } },
      { tier: 2, min: 10,  max: 99,  shield: { amount: 40, durationMs: 6000 }, weaponLevelUp: 1 },
      { tier: 3, min: 100, max: 499, supplyDrops: 3, dropTier: 3 },
      { tier: 4, min: 500, max: Number.POSITIVE_INFINITY, reviveHpPercent: 0.6,
        ultimate: { damage: 40, radius: 1200 } },  // chiêu cuối khi không ai để hồi sinh
    ],
    dropRewards: { weapon: 3, shield: 3, heal: 3, rage: 1 },   // trọng số phần thưởng rơi
    rageBuff: { atkMult: 1.5, durationMs: 6000 },
  },

  // ---- Liên minh ----
  alliance: {
    buff: { atkMult: 1.1, defMult: 1.1, speedMult: 1.05 },
    inviteTtlMs: 15000,
    formationBuff: { type: 'shield', durationMs: 5000, value: 12 },
    botAcceptChance: 0.65,
    botProposeChance: 0.2,
    botProposeIntervalSec: [12, 20],
    finalBreakReason: 'roundEnd',
    betrayWaitMs: 15000,              // phải liên minh đủ lâu mới được phản bội
    backstabMult: 2.5,                // sát thương đâm lén = atk * hệ số
    friendlyFire: false,
    maxAllies: 1,
  },

  // ---- Truy nã ----
  bounty: {
    streakToBounty: 3,                // 3 mạng liên tiếp -> "Kẻ hủy diệt"
    title: 'Kẻ hủy diệt',
    killerRewardHealPercent: 0.3,
    killerRewardBuff: { type: 'rage', durationMs: 6000, value: 1.3 },
  },

  // ---- UI ----
  ui: {
    killFeedMax: 6, killFeedTtlMs: 6000, leaderboardRows: 5,
    maxParticles: 240, particleLifeMs: 650, particleSpeed: 260, particleRadius: 5,
    damageParticleCount: 2, killParticleCount: 12, giftParticleCount: 10, trapParticleCount: 8, particleDrag: 0.96,
    ultimateParticleCount: 24,
    effectPopupLifeMs: 1400, effectWaveLifeMs: 1000, effectBeamLifeMs: 1200,
    effectPopupRise: 55, effectPopupFontSize: 22, damageFontSize: 26, critFontSize: 40,
    effectRingRadius: 90, effectBeamHeight: 180, effectHeartSize: 26, effectTextWidth: 240,
    avatarCacheMax: 80, avatarLoadTimeoutMs: 5000, avatarResolution: 2,
    avatarInitialFontSize: 24, classIconSize: 18, classIconOffset: 36, classIconOffsetY: 23, nameMaxWidth: 130,
    canvasFont: '"Trebuchet MS", sans-serif',
    classIcons: { swordsman: '\u2694', archer: '\u27B6', mage: '\u2726', tank: '\u25C6' },
    finalZoomMax: 3, cameraPadding: 60, cameraSmoothing: 0.08,
    cameraReferenceFps: 60, cameraMaxDeltaSec: 0.1,
    shakeDurationMs: 450, bossShake: 10, ultimateShake: 16,
    deathVisibleMs: 1800, deathAlpha: 0.45,
    allyLineWidth: 1.5, rageLineWidth: 3, bountyLineWidth: 4, bountyHaloGap: 12,
    renderColors: {
      backgroundTop: '#10171c', backgroundBottom: '#182127', grid: 'rgba(180,210,210,0.08)',
      outside: 'rgba(210,45,55,0.2)', zone: '#d8f2d0', text: '#f0f4ee', fallback: '#dce8e2',
      shield: '#8ce5dc', rage: '#f36b67', ally: 'rgba(131,220,190,0.65)',
      hpTrack: '#432e31', hp: '#7bc77c', boss: '#c84b46', bossHp: '#e87864',
      bomb: '#ef5d47', spike: '#dfb64f', damage: '#ff806b', crit: '#ffd166',
      revive: '#a9f2c3', supply: '#f0be63', grave: '#9fa8aa',
    },
    gridSize: 90, gridLineWidth: 1, zoneLineWidth: 5, zoneDash: [18, 12],
    playerRadius: 22, shieldLineWidth: 4, shieldGap: 6, nameFontSize: 18, nameOffset: 34,
    hpBarWidth: 48, hpBarHeight: 6, hpBarOffset: 13, dropSize: 18, trapRadius: 14,
    bossRadius: 42, bossBarWidth: 90, bossBarHeight: 8, bossBarOffset: 55,
    noticeDurationMs: 4500, eventLabelDurationMs: 5000,
    hud: {
      designWidth: 1080, designHeight: 1920,
      safeArea: { top: 0.06, right: 0.14, bottom: 0.15, left: 0.06 },
      feedRows: 5, feedTtlMs: 9000, popupQueueMax: 8, popupDurationMs: 3000,
      popupNameChars: 20, popupGiftChars: 20,
      refreshMs: 200, recentAvatars: 12, bannerDurationMs: 4000,
      battleFlashMs: 750, zoneWarningLeadMs: 10000, zoneWarningDurationMs: 5000,
      dailyRefreshMs: 2000, dailyTimeoutMs: 4000, showConnection: true,
      commandIcons: { join: '\u2795', attack: '\u2694', dodge: '\u27B6', ally: '\u2665', betray: '\u26A1', rescue: '\u271A' },
      giftIcons: ['\u271A', '\u25C7', '\u25A3', '\u2726'],
      giftLabels: ['Hồi máu + tốc độ', 'Khiên + vũ khí', 'Hàng tiếp tế', 'Hồi sinh / chiêu cuối'],
    },
    tierColors: { 1: '#7fd89b', 2: '#72cee0', 3: '#f0be63', 4: '#ef7474' },
    phaseNames: { LOBBY: 'SẢNH CHỜ', COUNTDOWN: 'CHUẨN BỊ', BATTLE: 'GIAO TRANH', FINAL: 'CHUNG KẾT', RESULT: 'KẾT QUẢ' },
    eventNames: { storm: 'BÃO ĐANG TỚI', bombRain: 'MƯA BOM', boss: 'BOSS XUẤT HIỆN', meteor: 'MƯA THIÊN THẠCH' },
  },
  leaderboard: {
    filePath: 'data/leaderboard.json', bodyLimit: '100kb',
    defaultPeriod: 'day', defaultMetric: 'wins', defaultLimit: 5, maxLimit: 100,
    maxRankingRows: 1000, maxProcessedRounds: 10000,
    maxIdLength: 128, maxNameLength: 128, maxAvatarLength: 8192,
    requestTimeoutMs: 5000,
  },
  audio: {
    volume: 0.08, minimumVolume: 0.001, noteGain: 0.35,
    maxVoices: 10, eventMinIntervalMs: 80, noteSpacingMs: 65,
    sounds: {
      hit: { notes: [150], durationMs: 70, waveform: 'triangle' },
      kill: { notes: [220, 150], durationMs: 180, waveform: 'sawtooth' },
      gift: { notes: [660, 880], durationMs: 180, waveform: 'sine' },
      boss: { notes: [110, 82], durationMs: 350, waveform: 'sawtooth' },
      ultimate: { notes: [180, 360, 720], durationMs: 280, waveform: 'triangle' },
      countdown: { notes: [520], durationMs: 110, waveform: 'sine' },
      battle: { notes: [520, 780], durationMs: 160, waveform: 'triangle' },
      win: { notes: [440, 554, 659, 880], durationMs: 240, waveform: 'sine' },
    },
  },

  // ---- Từ khóa lệnh (so khớp đã bỏ dấu + không phân biệt hoa thường) ----
  commands: {
    join:   ['join', 'tham gia', 'vao'],
    attack: ['đánh', 'tấn công', 'attack'],
    dodge:  ['né', 'chạy'],
    ally:   ['hợp tác'],
    betray: ['phản bội'],
    rescue: ['cứu'],
  },
  input: {
    tokenCapacity: 30,
    tokenRefillPerSec: 10,
    commandCooldownMs: { join: 0, attack: 4000, dodge: 6000, ally: 8000, betray: 10000, giftTarget: 2000 },
  },
};

export default config;
export { config };
