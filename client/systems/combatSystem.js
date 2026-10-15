import { getAlive } from '../core/gameState.js';
import { distXY, areAllied, getEffectiveStats } from '../core/utils.js';
import { findOpenSpawn } from '../core/spawnPoint.js';
import { updateClassSkills } from './classSkills.js';
import { updateBossSkill } from './bossSkills.js';

export function createCombatSystem({ bus, state, config }) {
  const off = [];
  const nextAttackAt = new Map();
  const invulnerableUntil = new Map();
  const bossDamage = new Map();
  const pendingDeaths = new Set();
  const betrayedTargets = new Map();
  let bossId = null;
  let nextBossAttackAt = 0;
  let disposed = false;
  const nowMs = () => state.time * 1000;
  const active = () => state.phase === 'BATTLE' || state.phase === 'FINAL';

  function syncBoss(boss) {
    if (boss.id === bossId) return;
    bossId = boss.id;
    bossDamage.clear();
    nextBossAttackAt = nowMs() + config.events.bossAttackIntervalMs;
  }

  function clearRuntime() {
    nextAttackAt.clear();
    invulnerableUntil.clear();
    bossDamage.clear();
    pendingDeaths.clear();
    betrayedTargets.clear();
    bossId = null;
    nextBossAttackAt = 0;
  }

  function finishPlayer(target, sourceId, cause, amount, crit) {
    const absorbed = Math.min(Math.max(0, target.shield), amount);
    target.shield -= absorbed;
    const hpDamage = Math.min(target.hp, Math.max(0, amount - absorbed));
    target.hp = Math.max(0, target.hp - hpDamage);
    const source = state.players.get(String(sourceId));
    if (source && source.id !== target.id) source.damageDealt += hpDamage;
    const killed = target.hp === 0;
    const killer = killed && source && source.id !== target.id ? source : null;
    if (killed) {
      // Mark death before notifying listeners so nested damage cannot kill twice.
      target.status = 'dead';
      target.mana = 0;
      target.vx = 0;
      target.vy = 0;
      pendingDeaths.add(target.id);
      nextAttackAt.delete(target.id);
      invulnerableUntil.delete(target.id);
      if (killer) killer.kills += 1;
      state.killFeed.unshift({ playerId: target.id, name: target.name, killerId: killer?.id ?? null, cause, at: nowMs() });
      state.killFeed.length = Math.min(state.killFeed.length, config.ui.killFeedMax);
    }
    bus.emit('player:damaged', { targetId: target.id, amount: hpDamage, sourceId: sourceId ?? null, cause, crit });
    if (killed) {
      pendingDeaths.delete(target.id);
      bus.emit('player:killed', { victimId: target.id, killerId: killer?.id ?? null, cause });
    }
  }

  off.push(bus.on('damage:request', (request = {}) => {
    const amountRequested = Number(request?.amount);
    if (!Number.isFinite(amountRequested) || amountRequested <= 0) return;
    if (state.boss && String(request.targetId) === state.boss.id) {
      const boss = state.boss;
      syncBoss(boss);
      const crit = request.cause === 'attack' && Math.random() < config.combat.critChance;
      const damage = Math.min(boss.hp, Math.max(config.combat.minDamage, amountRequested * (crit ? config.combat.critMult : 1)));
      boss.hp = Math.max(0, boss.hp - damage);
      const source = state.players.get(String(request.sourceId));
      if (source) {
        source.damageDealt += damage;
        bossDamage.set(source.id, (bossDamage.get(source.id) ?? 0) + damage);
      }
      const defeated = boss.hp === 0;
      const topDamagers = defeated ? [...bossDamage].map(([playerId, damageDealt]) => ({ playerId, damage: damageDealt })).sort((a, b) => b.damage - a.damage).slice(0, config.events.bossRewardRows) : null;
      if (defeated) state.boss = null;
      bus.emit('boss:damaged', { hp: boss.hp, maxHp: boss.maxHp, byId: request.sourceId ?? null });
      if (defeated) bus.emit('boss:defeated', { topDamagers, killerId: source?.id ?? null, bossType: boss.type ?? '', x: boss.x, y: boss.y });
      return;
    }
    const target = state.players.get(String(request.targetId));
    if (!target || target.status !== 'alive') return;
    if ((invulnerableUntil.get(target.id) ?? 0) > nowMs()) return;
    const cause = request.cause || 'attack';
    const source = state.players.get(String(request.sourceId));
    if (state.mode === 'raid' && source && source.id !== target.id) return;
    const betrayed = betrayedTargets.get(source?.id);
    const isBetrayal = cause === 'betray' || (betrayed?.id === target.id && betrayed.until > nowMs());
    if ((cause === 'attack' || cause === 'skill') && source && !config.alliance.friendlyFire && areAllied(source, target) && !isBetrayal) return;
    const defense = Math.max(0, getEffectiveStats(target, config, nowMs()).def);
    let damage = config.combat.armorCauses.includes(cause) ? amountRequested - defense : amountRequested;
    damage = Math.max(config.combat.minDamage, damage);
    const crit = request.cause === 'attack' && Math.random() < config.combat.critChance;
    if (crit) damage *= config.combat.critMult;
    finishPlayer(target, request.sourceId, cause, Math.max(config.combat.minDamage, damage), crit);
  }));

  off.push(bus.on('heal:request', (payload) => {
    const target = state.players.get(String(payload?.targetId));
    const value = Number(payload?.amount);
    if (!target || target.status !== 'alive' || !Number.isFinite(value) || value <= 0) return;
    target.hp = Math.min(target.maxHp, target.hp + value);
  }));

  off.push(bus.on('revive:request', (payload) => {
    const player = state.players.get(String(payload?.playerId));
    if (!player || player.status !== 'dead' || pendingDeaths.has(player.id)) return;
    player.status = 'alive';
    player.hp = Math.min(player.maxHp, Math.max(config.combat.minDamage, player.maxHp * config.gifts.tiers.find((tier) => tier.tier === 4).reviveHpPercent));
    const point = findOpenSpawn(state, config, config.ui.playerRadius, player.id);
    player.x = player.prevX = point.x;
    player.y = player.prevY = point.y;
    player.vx = 0;
    player.vy = 0;
    player.targetId = null;
    player.intent = 'normal';
    player.mana = 0;
    player.bossSlowUntil = 0;
    player.bossSlowMult = 1;
    invulnerableUntil.set(player.id, nowMs() + config.combat.reviveInvulnMs);
    nextAttackAt.delete(player.id);
    bus.emit('player:revived', { playerId: player.id, byId: payload?.byId ?? null });
  }));

  off.push(bus.on('ally:betrayed', (payload) => {
    if (!payload?.betrayerId || !payload.victimId) return;
    const until = nowMs() + config.movement.betrayPriorityDurationMs;
    betrayedTargets.set(String(payload.betrayerId), { id: String(payload.victimId), until });
    betrayedTargets.set(String(payload.victimId), { id: String(payload.betrayerId), until });
  }));
  off.push(bus.on('boss:spawned', (payload) => {
    bossDamage.clear();
    bossId = payload?.id ?? null;
    nextBossAttackAt = nowMs() + config.events.bossAttackIntervalMs;
  }));
  off.push(bus.on('round:phase', ({ phase } = {}) => {
    if (phase === 'LOBBY') for (const player of state.players.values()) { player.hp = player.maxHp; player.mana = 0; }
    if (phase === 'RESULT' || phase === 'LOBBY') {
      clearRuntime();
    }
  }));

  function updateBoss(dt, now) {
    const boss = state.boss;
    if (!boss) return;
    syncBoss(boss);
    updateBossSkill({ bus, state, config }, dt);
    if (!active() || state.boss !== boss || boss.casting) return;
    const target = getAlive(state).sort((a, b) => distXY(a.x, a.y, boss.x, boss.y) - distXY(b.x, b.y, boss.x, boss.y))[0];
    if (!target) return;
    const dx = target.x - boss.x;
    const dy = target.y - boss.y;
    const distance = Math.hypot(dx, dy);
    const travel = Math.min(boss.speed * dt, Math.max(0, distance - config.events.bossAttackRadius));
    if (distance > 0) { boss.x += dx / distance * travel; boss.y += dy / distance * travel; }
    if (distance - travel <= config.events.bossAttackRadius && now >= nextBossAttackAt) {
      nextBossAttackAt = now + config.events.bossAttackIntervalMs;
      if (config.bosses[boss.type]) bus.emit('boss:attack', { bossId: boss.id, bossType: boss.type, x: boss.x, y: boss.y, targetX: target.x, targetY: target.y });
      bus.emit('damage:request', { targetId: target.id, amount: boss.atk, sourceId: boss.id, cause: 'boss' });
    }
  }

  function update(dt) {
    if (disposed || !active() || !Number.isFinite(dt) || dt <= 0) return;
    const now = nowMs();
    updateClassSkills({ bus, state, config }, dt);
    if (!active()) return;
    for (const [id, target] of betrayedTargets) if (target.until <= now) betrayedTargets.delete(id);
    for (const player of getAlive(state)) {
      if (!active()) break;
      if (player.status !== 'alive') continue;
      if (player.intent !== 'dodging') player.intent = 'normal';
      let target = state.players.get(String(player.targetId));
      if (state.mode === 'raid') target = null;
      const betrayed = betrayedTargets.get(player.id);
      if (target && (!config.alliance.friendlyFire && areAllied(player, target) && target.id !== betrayed?.id)) target = null;
      const distance = target?.status === 'alive' ? distXY(player.x, player.y, target.x, target.y) : Infinity;
      const bossTarget = state.boss && (String(player.targetId) === state.boss.id || distXY(player.x, player.y, state.boss.x, state.boss.y) < distance) ? state.boss : null;
      const targetX = bossTarget?.x ?? target?.x;
      const targetY = bossTarget?.y ?? target?.y;
      if ((!bossTarget && (!target || target.status !== 'alive')) || distXY(player.x, player.y, targetX, targetY) > player.range) continue;
      const dueAt = nextAttackAt.get(player.id) ?? 0;
      if (now < dueAt) continue;
      const stats = getEffectiveStats(player, config, now);
      nextAttackAt.set(player.id, now + stats.attackInterval);
      bus.emit('damage:request', { targetId: bossTarget?.id ?? target.id, amount: stats.atk, sourceId: player.id, cause: 'attack' });
    }
    if (active()) updateBoss(dt, now);
    for (const [playerId, until] of invulnerableUntil) if (until <= now) invulnerableUntil.delete(playerId);
  }

  return { update, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); clearRuntime(); } };
}
