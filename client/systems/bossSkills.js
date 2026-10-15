import { getAlive } from '../core/gameState.js';
import { clamp, distXY } from '../core/utils.js';

export function updateBossSkill({ bus, state, config }, dt) {
  const boss = state.boss;
  const definition = config.bosses[boss?.type];
  if (!boss || !definition) return;
  const skill = definition.skill;
  if (boss.casting) {
    const cast = boss.casting;
    if (state.time < cast.hitsAt) return;
    boss.casting = null;
    bus.emit('boss:skill', { bossId: boss.id, bossType: boss.type, stage: 'impact', x: cast.x, y: cast.y, radius: skill.radius });
    if (skill.healPercent) boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp * skill.healPercent);
    for (const player of getAlive(state)) {
      if (distXY(player.x, player.y, cast.x, cast.y) <= skill.radius) {
        bus.emit('damage:request', { targetId: player.id, sourceId: boss.id, amount: skill.damage, cause: 'boss' });
        if (player.status !== 'alive') continue;
        if (skill.slowMult) {
          player.bossSlowUntil = state.time + skill.slowSec;
          player.bossSlowMult = skill.slowMult;
        }
        if (skill.pull) {
          const dx = cast.x - player.x, dy = cast.y - player.y;
          const distance = Math.hypot(dx, dy);
          const travel = Math.min(distance, skill.pull);
          if (distance > 0) {
            player.x = player.prevX = clamp(player.x + dx / distance * travel, config.ui.playerRadius, state.arena.w - config.ui.playerRadius);
            player.y = player.prevY = clamp(player.y + dy / distance * travel, config.ui.playerRadius, state.arena.h - config.ui.playerRadius);
          }
        }
      }
    }
    return;
  }
  boss.mana = Math.min(boss.maxMana, boss.mana + boss.maxMana * dt / definition.fillSec);
  if (boss.mana < boss.maxMana - 1e-8) return;
  const nearest = getAlive(state).sort((a, b) => distXY(a.x, a.y, boss.x, boss.y) - distXY(b.x, b.y, boss.x, boss.y))[0];
  if (!nearest) return;
  const center = skill.targeted ? nearest : boss;
  boss.mana = 0;
  boss.casting = { x: center.x, y: center.y, hitsAt: state.time + skill.warningSec };
  bus.emit('boss:skill', { bossId: boss.id, bossType: boss.type, stage: 'warning', x: center.x, y: center.y, radius: skill.radius });
}
