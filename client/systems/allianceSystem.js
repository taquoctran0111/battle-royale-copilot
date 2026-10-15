import { getAlive, getPlayerByName } from '../core/gameState.js';
import { pick, randRange } from '../core/utils.js';

export function createAllianceSystem({ bus, state, config }) {
  const off = [];
  const invitations = new Map();
  const breakingPairs = new Set();
  const killedThisLife = new Set();
  let disposed = false;
  let nextBotProposalAt = state.time + config.alliance.botProposeIntervalSec[0];
  const nowMs = () => state.time * 1000;
  const keyOf = (aId, bId) => [String(aId), String(bId)].sort().join('|');
  const canAlly = () => !disposed && ['LOBBY', 'COUNTDOWN', 'BATTLE'].includes(state.phase);
  const canFight = () => !disposed && state.mode !== 'raid' && (state.phase === 'BATTLE' || state.phase === 'FINAL');

  function clearInvitations(playerId) {
    invitations.delete(playerId);
    for (const [id, invitation] of invitations) if (invitation.targetId === playerId) invitations.delete(id);
  }

  function validPair(a, b) {
    return a && b && a.id !== b.id && a.status === 'alive' && b.status === 'alive' && !a.allianceId && !b.allianceId;
  }

  function formPair(a, b) {
    if (!canAlly() || !validPair(a, b)) return;
    a.allianceId = b.id;
    b.allianceId = a.id;
    state.alliances.set(keyOf(a.id, b.id), { aId: a.id, bId: b.id, formedAt: nowMs() });
    clearInvitations(a.id);
    clearInvitations(b.id);
    bus.emit('ally:formed', { aId: a.id, bId: b.id });
    const buff = config.alliance.formationBuff;
    for (const player of [a, b]) {
      if (player.status === 'alive' && player.allianceId) bus.emit('buff:apply', { playerId: player.id, type: buff.type, durationMs: buff.durationMs, value: buff.value });
    }
  }

  function clearPair(aId, bId, reason, announce = true) {
    const key = keyOf(aId, bId);
    if (!state.alliances.has(key)) return;
    state.alliances.delete(key);
    const a = state.players.get(String(aId));
    const b = state.players.get(String(bId));
    if (a?.allianceId === String(bId)) a.allianceId = null;
    if (b?.allianceId === String(aId)) b.allianceId = null;
    if (announce) bus.emit('ally:broken', { aId: String(aId), bId: String(bId), reason });
  }

  function propose(player, target) {
    if (!canAlly() || !validPair(player, target) || player.cooldowns.ally > nowMs()) return;
    player.cooldowns.ally = nowMs() + config.combat.cooldownMs.ally;
    const reverse = invitations.get(target.id);
    if (reverse?.targetId === player.id && reverse.expiresAt > nowMs()) {
      formPair(player, target);
      return;
    }
    invitations.set(player.id, { targetId: target.id, expiresAt: nowMs() + config.alliance.inviteTtlMs });
    if (target.isBot && Math.random() < config.alliance.botAcceptChance) formPair(player, target);
  }

  off.push(bus.on('cmd:ally', (payload) => {
    if (!canAlly()) return;
    const player = state.players.get(String(payload?.playerId));
    const target = getPlayerByName(state, payload?.targetName, { aliveOnly: true });
    propose(player, target);
  }));

  off.push(bus.on('cmd:betray', (payload) => {
    if (!canFight()) return;
    const player = state.players.get(String(payload?.playerId));
    const partner = player?.allianceId ? state.players.get(player.allianceId) : null;
    if (!player || player.status !== 'alive' || partner?.status !== 'alive' || player.cooldowns.betray > nowMs()) return;
    const key = keyOf(player.id, partner.id);
    const alliance = state.alliances.get(key);
    if (!alliance || breakingPairs.has(key) || nowMs() - alliance.formedAt < config.alliance.betrayWaitMs) return;
    player.cooldowns.betray = nowMs() + config.combat.cooldownMs.betray;
    breakingPairs.add(key);
    try {
      bus.emit('ally:betrayed', { betrayerId: player.id, victimId: partner.id });
      bus.emit('damage:request', { targetId: partner.id, amount: player.atk * config.alliance.backstabMult, sourceId: player.id, cause: 'betray' });
      clearPair(player.id, partner.id, 'betray');
    } finally {
      breakingPairs.delete(key);
    }
  }));

  function selectBounty() {
    const candidates = getAlive(state).filter((player) => player.streak >= config.bounty.streakToBounty);
    const current = state.players.get(state.bountyId);
    let best = candidates.includes(current) ? current : null;
    for (const player of candidates) if (!best || player.streak > best.streak) best = player;
    const nextId = best?.id ?? null;
    if (nextId === state.bountyId) return;
    state.bountyId = nextId;
    if (nextId) bus.emit('bounty:set', { playerId: nextId });
  }

  off.push(bus.on('player:killed', (payload) => {
    const player = state.players.get(String(payload?.victimId));
    if (!player || player.status !== 'dead' || killedThisLife.has(player.id)) return;
    killedThisLife.add(player.id);
    clearInvitations(player.id);
    player.streak = 0;
    bus.emit('streak:updated', { playerId: player.id, streak: 0 });
    const killer = state.players.get(String(payload?.killerId));
    const validKiller = killer && killer.id !== player.id && killer.status === 'alive';
    if (state.bountyId === player.id) {
      state.bountyId = null;
      if (validKiller) {
        bus.emit('bounty:claimed', { victimId: player.id, killerId: killer.id });
        bus.emit('heal:request', { targetId: killer.id, amount: killer.maxHp * config.bounty.killerRewardHealPercent, sourceId: null });
        const buff = config.bounty.killerRewardBuff;
        bus.emit('buff:apply', { playerId: killer.id, type: buff.type, durationMs: buff.durationMs, value: buff.value });
      }
    }
    if (validKiller) {
      killer.streak += 1;
      bus.emit('streak:updated', { playerId: killer.id, streak: killer.streak });
    }
    selectBounty();
    if (player.allianceId && !breakingPairs.has(keyOf(player.id, player.allianceId))) clearPair(player.id, player.allianceId, 'death');
  }));
  off.push(bus.on('player:revived', (payload) => {
    const player = state.players.get(String(payload?.playerId));
    if (player?.status === 'alive') killedThisLife.delete(player.id);
  }));
  off.push(bus.on('round:phase', (payload) => {
    if (payload?.phase === 'LOBBY' || payload?.phase === 'RESULT') {
      invitations.clear();
      for (const alliance of [...state.alliances.values()]) clearPair(alliance.aId, alliance.bId, 'roundEnd');
    }
    if (payload?.phase === 'LOBBY') {
      killedThisLife.clear();
      breakingPairs.clear();
      state.bountyId = null;
      for (const player of state.players.values()) {
        player.allianceId = null;
        player.streak = 0;
        bus.emit('streak:updated', { playerId: player.id, streak: 0 });
      }
      nextBotProposalAt = state.time + config.alliance.botProposeIntervalSec[0];
    }
  }));
  off.push(bus.on('ally:broken', (payload) => clearPair(payload?.aId, payload?.bId, payload?.reason ?? 'roundEnd', false)));

  function update(dt) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    for (const [id, invitation] of invitations) {
      const player = state.players.get(id);
      const target = state.players.get(invitation.targetId);
      if (invitation.expiresAt <= nowMs() || !validPair(player, target)) invitations.delete(id);
    }
    // FINAL's last allied pair must duel; the configured reason is explicit.
    if (state.phase === 'FINAL' && state.mode !== 'raid') {
      const alive = getAlive(state);
      if (alive.length === 2 && alive[0].allianceId === alive[1].id && alive[1].allianceId === alive[0].id) {
        clearPair(alive[0].id, alive[1].id, config.alliance.finalBreakReason);
      }
    }
    if (!canAlly() || state.time < nextBotProposalAt) return;
    const available = getAlive(state).filter((player) => !player.allianceId && player.cooldowns.ally <= nowMs());
    const bots = available.filter((player) => player.isBot);
    const humans = available.filter((player) => !player.isBot);
    if (!bots.length || !humans.length) {
      nextBotProposalAt = state.time + config.alliance.botProposeIntervalSec[0];
      return;
    }
    nextBotProposalAt = state.time + randRange(...config.alliance.botProposeIntervalSec);
    if (bots.length && humans.length && Math.random() < config.alliance.botProposeChance) {
      const bot = pick(bots);
      const target = pick(humans);
      bus.emit('cmd:ally', { playerId: bot.id, targetName: target.name });
    }
  }

  return { update, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); invitations.clear(); breakingPairs.clear(); killedThisLife.clear(); for (const alliance of [...state.alliances.values()]) clearPair(alliance.aId, alliance.bId, 'roundEnd'); } };
}
