import { getAlive } from '../core/gameState.js';
import { areAllied, distXY, getEffectiveStats } from '../core/utils.js';

// Combat owns the update/lifecycle; all HP and shield changes use the existing event pipeline.
export function updateClassSkills({ bus, state, config }, dt) {
  if (!config.skills.enabled) return;
  for (const player of getAlive(state)) {
    if (state.phase !== 'BATTLE' && state.phase !== 'FINAL') break;
    if (player.status !== 'alive') continue;
    player.mana = Math.min(player.maxMana, player.mana + player.maxMana * dt / config.skills.fillSec);
    if (player.mana < player.maxMana - 1e-8) continue;
    const skill = config.skills[player.classId];
    const enemies = getAlive(state).filter((other) => state.mode !== 'raid' && other.id !== player.id &&
      (config.alliance.friendlyFire || !areAllied(player, other)));
    const candidates = state.boss ? [...enemies, state.boss] : enemies;
    const inRange = candidates.filter((other) => distXY(player.x, player.y, other.x, other.y) <= skill.range);
    const target = inRange.find((other) => other.id === player.targetId) ??
      inRange.sort((a, b) => distXY(player.x, player.y, a.x, a.y) - distXY(player.x, player.y, b.x, b.y))[0];
    if (!target) { player.mana = player.maxMana; continue; }
    player.mana = 0;
    const centered = player.classId === 'swordsman' || player.classId === 'tank';
    const x = centered ? player.x : target.x, y = centered ? player.y : target.y;
    bus.emit('skill:cast', { playerId: player.id, classId: player.classId, x: player.x, y: player.y, targetX: x, targetY: y, radius: skill.radius });
    if (player.classId === 'tank') {
      bus.emit('buff:apply', { playerId: player.id, type: 'shield', durationMs: skill.durationMs, value: skill.shield });
      bus.emit('heal:request', { targetId: player.id, sourceId: player.id, amount: player.maxHp * skill.healPercent });
      continue;
    }
    const damage = getEffectiveStats(player, config, state.time * 1000).atk * skill.damageMult;
    const victims = player.classId === 'archer' ? [target] :
      candidates.filter((other) => distXY(x, y, other.x, other.y) <= skill.radius);
    for (let shot = 0; shot < (skill.shots ?? 1); shot++) {
      for (const victim of victims) {
        if (player.status !== 'alive' || (state.phase !== 'BATTLE' && state.phase !== 'FINAL')) break;
        if (victim === state.boss || state.players.get(victim.id)?.status === 'alive') {
          bus.emit('damage:request', { targetId: victim.id, sourceId: player.id, amount: damage, cause: 'skill' });
        }
      }
    }
  }
}
