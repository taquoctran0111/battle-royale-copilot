import { parse } from './commandParser.js';
import { getGiftTier } from '../core/utils.js';
import { getPlayerByName } from '../core/gameState.js';

export function createInputRouter({ bus, state, config }) {
  const unsubscribers = [];
  const listen = (event, handler) => unsubscribers.push(bus.on(event, handler));
  const capacity = config.input.tokenCapacity;
  const refillPerSec = config.input.tokenRefillPerSec;
  let tokens = capacity;
  let lastRefill = state.time;
  const extraCooldowns = new Map();

  const nowMs = () => state.time * 1000;
  const allowComment = () => {
    if (state.time < lastRefill) {
      tokens = capacity;
      lastRefill = state.time;
    } else {
      tokens = Math.min(capacity, tokens + (state.time - lastRefill) * refillPerSec);
      lastRefill = state.time;
    }
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
  const emitJoin = (user, classId) => {
    if (!user?.userId) return;
    const id = String(user.userId);
    if (state.players.has(id) && !classId) return;
    bus.emit('cmd:join', { player: { id, name: user.nickname || user.uniqueId || id, avatar: user.avatarUrl || '', ...(classId ? { classId } : {}) } });
  };
  const addEnergy = (amount) => {
    if (Number.isFinite(amount) && amount > 0) bus.emit('energy:add', { amount });
  };
  const energyConfig = config.events.energy;
  const energyPerLike = energyConfig.perLike ?? config.events.energyPerLike ?? 0;
  const cooldownFor = (cmd) => config.input.commandCooldownMs[cmd] ?? config.combat.cooldownMs[cmd] ?? 0;

  function routeCommand(event) {
    if (!event?.userId || !allowComment()) return;
    const parsed = parse(event.text, config);
    if (!parsed) return;
    const playerId = String(event.userId);
    let player = state.players.get(playerId);
    if (parsed.cmd === 'join') {
      emitJoin(event, parsed.arg);
      return;
    }
    if (!player) return;
    if (player.status === 'dead' && parsed.cmd !== 'giftTarget') return;
    if (player.status === 'spectator') return;

    const cooldownKey = parsed.cmd;
    const cooldownStore = cooldownKey === 'giftTarget' ? extraCooldowns : null;
    const cooldownUntil = cooldownStore?.get(playerId) ?? player.cooldowns?.[cooldownKey] ?? 0;
    if (cooldownUntil > nowMs()) return;

    if (parsed.cmd === 'giftTarget') {
      const target = getPlayerByName(state, parsed.arg);
      if (!target) return;
      state.giftTargets.set(playerId, { targetId: target.id, expiresAt: nowMs() + config.gifts.giftTargetTtlMs });
      bus.emit('cmd:giftTarget', { playerId, targetName: parsed.arg });
    } else if (parsed.cmd === 'dodge') bus.emit('cmd:dodge', { playerId });
    else if (parsed.cmd === 'ally') bus.emit('cmd:ally', { playerId, targetName: parsed.arg });
    else if (parsed.cmd === 'betray') bus.emit('cmd:betray', { playerId });

    const cooldown = cooldownFor(parsed.cmd);
    if (cooldown > 0) {
      const expiresAt = nowMs() + cooldown;
      if (cooldownStore) cooldownStore.set(playerId, expiresAt);
      else if (player.cooldowns && cooldownKey in player.cooldowns) player.cooldowns[cooldownKey] = Math.max(player.cooldowns[cooldownKey] ?? 0, expiresAt);
    }
  }

  listen('live:join', emitJoin);
  listen('round:phase', ({ phase } = {}) => {
    if (phase !== 'LOBBY') return;
    tokens = capacity;
    lastRefill = state.time;
    extraCooldowns.clear();
  });
  listen('live:chat', routeCommand);
  listen('live:gift', (event) => {
    const fromId = String(event?.userId ?? '');
    if (!fromId) return;
    if (!state.players.has(fromId)) emitJoin(event);
    const diamonds = Number(event.diamonds) || 0;
    const giftTier = getGiftTier(config.gifts.tiers, diamonds);
    const target = state.giftTargets.get(fromId);
    const toId = target && target.expiresAt > nowMs() && state.players.has(target.targetId) ? target.targetId : fromId;
    if (target) state.giftTargets.delete(fromId);
    if (giftTier) {
      bus.emit('gift:effect', {
        fromId, toId, tier: giftTier.tier, diamonds,
        giftName: String(event.giftName ?? ''), count: Math.max(1, Number(event.count) || 1),
      });
    }
    addEnergy(diamonds * (energyConfig.perDiamond ?? 0));
  });
  listen('live:like', (event) => addEnergy((Number(event?.likeCount) || 0) * energyPerLike));
  listen('live:follow', () => addEnergy(energyConfig.perFollow ?? 0));
  listen('live:share', () => addEnergy(energyConfig.perShare ?? 0));

  return {
    update() {
      for (const [playerId, target] of state.giftTargets) if (target.expiresAt <= nowMs()) state.giftTargets.delete(playerId);
      for (const [playerId, expiresAt] of extraCooldowns) if (expiresAt <= nowMs() || !state.players.has(playerId)) extraCooldowns.delete(playerId);
    },
    dispose() { unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe()); extraCooldowns.clear(); },
  };
}
