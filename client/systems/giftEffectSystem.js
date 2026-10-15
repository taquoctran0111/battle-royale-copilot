import { clamp, getGiftTier, randRange } from '../core/utils.js';

export function createGiftEffectSystem({ bus, state, config }) {
  const off = [];
  const revivedPlayers = new Set();
  const pendingRevives = new Set();
  const collectedDrops = new Set();
  let revivedThisRound = 0;
  let disposed = false;
  const nowMs = () => state.time * 1000;
  const active = () => !disposed && (state.phase === 'BATTLE' || state.phase === 'FINAL');

  function pruneBuffs(player) {
    const shields = player.buffs.filter((buff) => buff.type === 'shield').sort((a, b) => a.until - b.until);
    let consumed = Math.max(0, shields.reduce((sum, buff) => sum + buff.value, 0) - player.shield);
    // Combat consumes the oldest shield first; expiry removes only its remainder.
    for (const buff of shields) {
      const amount = Math.min(consumed, buff.value);
      buff.value -= amount;
      consumed -= amount;
    }
    const expiredShield = shields.filter((buff) => buff.until <= nowMs()).reduce((sum, buff) => sum + buff.value, 0);
    player.shield = Math.max(0, player.shield - expiredShield);
    player.buffs = player.buffs.filter((buff) => buff.until > nowMs() && (buff.type !== 'shield' || buff.value > 0));
  }

  function emitBuff(player, type, durationMs, value) {
    bus.emit('buff:apply', { playerId: player.id, type, durationMs, value });
  }

  function applyGiftEffect(gift, tier) {
    const { fromId, toId, count } = gift;
    const receiver = state.players.get(String(toId));
    const ignore = (reason) => bus.emit('gift:ignored', { ...gift, reason });
    if (!active()) { ignore('inactive_phase'); return; }
    if (!receiver || receiver.status === 'spectator') {
      if (tier.tier === 4) bus.emit('ultimate:fire', { byId: fromId });
      else ignore(receiver ? 'spectator' : 'missing_player');
      return;
    }
    if (tier.tier !== 4 && receiver.status !== 'alive') { ignore('dead'); return; }
    if (tier.tier === 1) {
      bus.emit('heal:request', { targetId: receiver.id, amount: tier.healAmount * Math.min(count, config.gifts.maxHealCount), sourceId: fromId });
      emitBuff(receiver, 'speed', tier.speedBuff.durationMs, tier.speedBuff.mult);
    } else if (tier.tier === 2) {
      if (!(config.gifts.blockBountyGiftShield && state.bountyId === receiver.id)) emitBuff(receiver, 'shield', tier.shield.durationMs, tier.shield.amount);
      receiver.weaponLevel = clamp(receiver.weaponLevel + tier.weaponLevelUp, 0, config.combat.maxWeaponLevel);
      emitBuff(receiver, 'weapon', 0, tier.weaponLevelUp);
    } else if (tier.tier === 3) {
      for (let index = 0; index < tier.supplyDrops; index += 1) {
        const angle = randRange(0, Math.PI * 2);
        const radius = randRange(0, config.gifts.supplyScatterRadius);
        bus.emit('drop:request', { tier: tier.dropTier,
          x: clamp(receiver.x + Math.cos(angle) * radius, 0, state.arena.w),
          y: clamp(receiver.y + Math.sin(angle) * radius, 0, state.arena.h) });
      }
    } else if (tier.tier === 4) {
      const dead = receiver.status === 'dead' ? receiver : [...state.players.values()].find((player) => player.status === 'dead' && !revivedPlayers.has(player.id));
      if (dead && !revivedPlayers.has(dead.id) && !pendingRevives.has(dead.id) && revivedThisRound + pendingRevives.size < config.gifts.maxRevivesPerRound) {
        pendingRevives.add(dead.id);
        try { bus.emit('revive:request', { playerId: dead.id, byId: fromId }); }
        finally { pendingRevives.delete(dead.id); }
      } else {
        bus.emit('ultimate:fire', { byId: fromId });
      }
    }
  }

  off.push(bus.on('gift:effect', (gift) => {
    if (disposed || !gift?.fromId || !gift.toId) return;
    const diamonds = Number(gift.diamonds);
    const count = Number(gift.count ?? 1);
    if (!Number.isFinite(diamonds) || diamonds <= 0 || !Number.isFinite(count) || count <= 0) return;
    const tier = config.gifts.tiers.find((item) => item.tier === Number(gift.tier)) ?? getGiftTier(config.gifts.tiers, diamonds);
    if (!tier) return;
    const sender = state.players.get(String(gift.fromId));
    if (sender) sender.giftValue += diamonds;
    const normalized = {
      fromId: String(gift.fromId), toId: String(gift.toId), tier: tier.tier,
      diamonds, giftName: String(gift.giftName ?? ''), count: Math.max(1, Math.floor(count)),
    };
    if (!sender) { bus.emit('gift:ignored', { ...normalized, reason: 'unknown_sender' }); return; }
    applyGiftEffect(normalized, tier);
  }));

  off.push(bus.on('buff:apply', (payload) => {
    if (disposed || !payload) return;
    const { type } = payload;
    const player = state.players.get(String(payload.playerId));
    if (!player || player.status !== 'alive' || !['shield', 'speed', 'weapon', 'rage'].includes(type)) return;
    const duration = Number(payload.durationMs);
    const strength = Number(payload.value);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(strength) || strength <= 0) return;
    pruneBuffs(player);
    const until = nowMs() + Math.min(duration, config.gifts.maxBuffDurationMs);
    const existing = player.buffs.filter((buff) => buff.type === type);
    if (type === 'shield') {
      const amount = Math.max(0, Math.min(strength, config.gifts.buffCaps.shield - player.shield));
      if (!amount || existing.length >= config.gifts.buffCaps.perType) return;
      player.shield += amount;
      player.buffs.push({ type, value: amount, until });
    } else {
      const value = clamp(strength, 1, type === 'speed' ? config.gifts.buffCaps.speedMult : 1 + config.gifts.buffCaps.attackBonus);
      if (existing.length >= config.gifts.buffCaps.perType) {
        const weakest = existing.reduce((best, buff) => buff.value < best.value ? buff : best);
        weakest.value = Math.max(weakest.value, value);
        weakest.until = Math.max(weakest.until, until);
      } else player.buffs.push({ type, value, until });
    }
  }));

  off.push(bus.on('player:revived', (payload) => {
    const player = state.players.get(String(payload?.playerId));
    if (player?.status !== 'alive' || revivedPlayers.has(player.id)) return;
    pendingRevives.delete(player.id);
    revivedPlayers.add(player.id);
    revivedThisRound += 1;
  }));
  off.push(bus.on('drop:collected', (payload) => {
    if (!active() || !payload?.id || collectedDrops.has(payload.id)) return;
    const { reward } = payload;
    const player = state.players.get(String(payload.playerId));
    if (!player || player.status !== 'alive' || !Object.hasOwn(config.gifts.dropRewards, reward)) return;
    collectedDrops.add(payload.id);
    if (reward === 'heal') bus.emit('heal:request', { targetId: player.id, amount: Math.ceil(player.maxHp * config.gifts.dropHealPercent), sourceId: null });
    else if (reward === 'shield') {
      const tier = config.gifts.tiers.find((item) => item.tier === 2);
      emitBuff(player, 'shield', tier.shield.durationMs, tier.shield.amount);
    } else if (reward === 'weapon') {
      player.weaponLevel = clamp(player.weaponLevel + 1, 0, config.combat.maxWeaponLevel);
      emitBuff(player, 'weapon', 0, 1);
    }
    else if (reward === 'rage') emitBuff(player, 'rage', config.gifts.rageBuff.durationMs, config.gifts.rageBuff.atkMult);
  }));

  off.push(bus.on('round:phase', (payload) => {
    if (payload?.phase !== 'LOBBY') return;
    revivedThisRound = 0;
    state.giftTargets.clear();
    revivedPlayers.clear();
    pendingRevives.clear();
    collectedDrops.clear();
    for (const player of state.players.values()) { player.buffs.length = 0; player.shield = 0; }
  }));

  function update(dt) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    for (const player of state.players.values()) pruneBuffs(player);
    for (const [playerId, target] of state.giftTargets) {
      if (target.expiresAt <= nowMs()) state.giftTargets.delete(playerId);
    }
  }

  return { update, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); revivedPlayers.clear(); pendingRevives.clear(); collectedDrops.clear(); } };
}
