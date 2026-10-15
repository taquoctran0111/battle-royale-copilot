import { clamp, distXY, areAllied, getEffectiveStats } from '../core/utils.js';
import { getAlive } from '../core/gameState.js';

export function createMovementSystem({ bus, state, config }) {
  const off = [];
  const dodgeUntil = new Map();
  const betrayedTargets = new Map();
  let disposed = false;
  const nowMs = () => state.time * 1000;
  const active = () => state.phase === 'BATTLE' || state.phase === 'FINAL';

  off.push(bus.on('cmd:dodge', (payload) => {
    const player = state.players.get(String(payload?.playerId));
    if (!active() || !player || player.status !== 'alive' || player.cooldowns.dodge > nowMs()) return;
    player.cooldowns.dodge = nowMs() + config.combat.cooldownMs.dodge;
    dodgeUntil.set(player.id, nowMs() + config.combat.dodge.durationMs);
    player.intent = 'dodging';
  }));
  off.push(bus.on('ally:betrayed', (payload) => {
    if (!payload?.betrayerId || !payload.victimId) return;
    const until = nowMs() + config.movement.betrayPriorityDurationMs;
    betrayedTargets.set(String(payload.betrayerId), { id: String(payload.victimId), until });
    betrayedTargets.set(String(payload.victimId), { id: String(payload.betrayerId), until });
  }));
  off.push(bus.on('round:phase', (payload) => {
    if (payload?.phase === 'LOBBY' || payload?.phase === 'RESULT') {
      dodgeUntil.clear();
      betrayedTargets.clear();
    }
  }));

  function collectDrop(player, drop) {
    const index = state.drops.indexOf(drop);
    if (index === -1) return;
    const rewards = Object.entries(config.gifts.dropRewards).filter(([, weight]) => weight > 0);
    if (!rewards.length) return;
    let roll = Math.random() * rewards.reduce((sum, [, weight]) => sum + weight, 0);
    let reward = rewards[0][0];
    for (const [name, weight] of rewards) {
      roll -= weight;
      if (roll <= 0) { reward = name; break; }
    }
    state.drops.splice(index, 1);
    bus.emit('drop:collected', { id: drop.id, playerId: player.id, reward });
  }

  function update(dt) {
    if (disposed || !active() || !Number.isFinite(dt) || dt <= 0) return;
    const alive = getAlive(state);
    const positions = new Map(alive.map((player) => [player.id, { x: player.x, y: player.y }]));
    const now = nowMs();
    for (const [id, until] of dodgeUntil) if (until <= now) dodgeUntil.delete(id);
    for (const [id, target] of betrayedTargets) if (target.until <= now) betrayedTargets.delete(id);

    for (const player of alive) {
      if (player.status !== 'alive') continue;
      const origin = positions.get(player.id);
      player.prevX = origin.x;
      player.prevY = origin.y;
      const dodging = (dodgeUntil.get(player.id) ?? 0) > now;
      if (player.intent === 'dodging' && !dodging) player.intent = 'normal';
      let target = null;
      let nearestEnemy = null;
      let nearestDistance = Infinity;
      let bestScore = Infinity;
      const betrayed = betrayedTargets.get(player.id);
      for (const candidate of alive) {
        if (state.mode === 'raid') break;
        if (candidate.id === player.id || candidate.status !== 'alive') continue;
        if (!config.alliance.friendlyFire && areAllied(player, candidate) && candidate.id !== betrayed?.id) continue;
        const position = positions.get(candidate.id);
        const distance = distXY(origin.x, origin.y, position.x, position.y);
        if (distance < nearestDistance) { nearestEnemy = candidate; nearestDistance = distance; }
        const score = candidate.id === betrayed?.id ? 0 : distance / (candidate.id === state.bountyId ? config.movement.bountyWeight : 1);
        if (score < bestScore) { target = candidate; bestScore = score; }
      }
      const selectedPosition = target ? positions.get(target.id) : null;
      const selectedDistance = selectedPosition ? distXY(origin.x, origin.y, selectedPosition.x, selectedPosition.y) : Infinity;
      const bossDistance = state.boss ? distXY(origin.x, origin.y, state.boss.x, state.boss.y) : Infinity;
      if (state.boss && bossDistance < selectedDistance && !(betrayed && target?.id === betrayed.id)) target = state.boss;
      const dodgeTarget = bossDistance < nearestDistance ? state.boss : nearestEnemy ? positions.get(nearestEnemy.id) : null;
      player.targetId = target?.id ?? null;
      const targetPosition = target ? positions.get(target.id) ?? target : null;
      let dx = 0;
      let dy = 0;
      const outsideZone = distXY(origin.x, origin.y, state.zone.cx, state.zone.cy) > Math.max(0, state.zone.radius - config.movement.zoneInset);
      const drop = state.drops.filter((item) => (state.mode !== 'raid' || player.hp < player.maxHp * .5) && distXY(origin.x, origin.y, item.x, item.y) <= config.movement.dropPriorityRadius)
        .sort((first, second) => distXY(origin.x, origin.y, first.x, first.y) - distXY(origin.x, origin.y, second.x, second.y))[0];

      // Zone safety takes precedence over dodging, supplies and pursuit.
      const bossCast = state.boss?.casting;
      const bossSkill = config.bosses[state.boss?.type]?.skill;
      if (bossCast && bossSkill && distXY(origin.x, origin.y, bossCast.x, bossCast.y) <= bossSkill.radius + 30) {
        dx = origin.x - bossCast.x;
        dy = origin.y - bossCast.y;
        if (!dx && !dy) { dx = Math.cos(player.facing); dy = Math.sin(player.facing); }
      } else if (outsideZone) {
        dx = state.zone.cx - origin.x;
        dy = state.zone.cy - origin.y;
      } else if (dodging && dodgeTarget) {
        dx = origin.x - dodgeTarget.x;
        dy = origin.y - dodgeTarget.y;
        if (!dx && !dy) { dx = Math.cos(player.facing + Math.PI); dy = Math.sin(player.facing + Math.PI); }
      } else if (drop) {
        dx = drop.x - origin.x;
        dy = drop.y - origin.y;
      } else if (targetPosition) {
        const distance = distXY(origin.x, origin.y, targetPosition.x, targetPosition.y);
        const weak = player.hp / player.maxHp < config.movement.fleeHpRatio;
        if (weak && distance < Math.max(160, player.range)) {
          dx = origin.x - targetPosition.x;
          dy = origin.y - targetPosition.y;
        } else if (distance > player.range * config.movement.arriveDistance) {
          dx = targetPosition.x - origin.x;
          dy = targetPosition.y - origin.y;
        } else if (config.movement.rangedClasses.includes(player.classId) && distance < player.range * config.movement.retreatRangeRatio) {
          dx = origin.x - targetPosition.x;
          dy = origin.y - targetPosition.y;
        } else {
          const turn = Array.from(player.id).reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 2 ? 1 : -1;
          dx = -(targetPosition.y - origin.y) * turn;
          dy = (targetPosition.x - origin.x) * turn;
        }
      }

      if (!dx && !dy) {
        const angle = state.time * .45 + Array.from(player.id).reduce((sum, ch) => sum + ch.codePointAt(0), 0);
        dx = state.zone.cx + Math.cos(angle) * Math.min(180, state.zone.radius * .45) - origin.x;
        dy = state.zone.cy + Math.sin(angle) * Math.min(180, state.zone.radius * .45) - origin.y;
        if (Math.hypot(dx, dy) < 1) { dx = Math.cos(angle + Math.PI / 2); dy = Math.sin(angle + Math.PI / 2); }
      }
      const length = Math.hypot(dx, dy);
      let directionX = length ? dx / length : 0;
      let directionY = length ? dy / length : 0;
      const separationRadius = config.ui.playerRadius * 2 + config.movement.separationPadding;
      for (const other of alive) {
        if (other.id === player.id) continue;
        const position = positions.get(other.id);
        const distance = distXY(origin.x, origin.y, position.x, position.y);
        if (distance >= separationRadius) continue;
        const angle = player.id.localeCompare(other.id) < 0 ? 0 : Math.PI;
        const strength = (1 - distance / separationRadius) * config.movement.separationStrength;
        directionX += (distance ? (origin.x - position.x) / distance : Math.cos(angle)) * strength;
        directionY += (distance ? (origin.y - position.y) / distance : Math.sin(angle)) * strength;
      }
      // Replace outward steering near the map/zone edge, rather than clamping a runner against it.
      const inset = Math.min(config.movement.edgeInset, state.arena.w * .2, state.arena.h * .2);
      if (origin.x < inset) directionX = Math.max(.65, directionX);
      if (origin.x > state.arena.w - inset) directionX = Math.min(-.65, directionX);
      if (origin.y < inset) directionY = Math.max(.65, directionY);
      if (origin.y > state.arena.h - inset) directionY = Math.min(-.65, directionY);
      const zx = origin.x - state.zone.cx, zy = origin.y - state.zone.cy;
      const zoneDistance = Math.hypot(zx, zy);
      const comfortRadius = Math.max(0, state.zone.radius - config.movement.zoneInset * 2);
      if (zoneDistance > comfortRadius && zoneDistance > 0) {
        const outward = (directionX * zx + directionY * zy) / zoneDistance;
        if (outward > -.35) {
          directionX -= zx / zoneDistance * (outward + .65);
          directionY -= zy / zoneDistance * (outward + .65);
        }
      }
      if (Math.hypot(directionX, directionY) < .1) {
        directionX = Math.cos(player.facing + .7);
        directionY = Math.sin(player.facing + .7);
      }
      const directionLength = Math.max(1, Math.hypot(directionX, directionY));
      const { speed } = getEffectiveStats(player, config, now, { dodging });
      const smoothing = config.movement.velocitySmoothing;
      player.vx += (directionX / directionLength * speed - player.vx) * smoothing;
      player.vy += (directionY / directionLength * speed - player.vy) * smoothing;
      if (Math.hypot(player.vx, player.vy) < speed * .08) {
        player.vx = directionX / directionLength * speed * .25;
        player.vy = directionY / directionLength * speed * .25;
      }
      const margin = Math.min(config.ui.playerRadius, state.arena.w / 2, state.arena.h / 2);
      player.x = clamp(origin.x + player.vx * dt, margin, state.arena.w - margin);
      player.y = clamp(origin.y + player.vy * dt, margin, state.arena.h - margin);
      player.facing = Math.atan2(player.vy, player.vx);
      for (const item of state.drops.slice()) {
        if (distXY(player.x, player.y, item.x, item.y) <= config.events.dropRadius) collectDrop(player, item);
      }
    }
  }

  return { update, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); dodgeUntil.clear(); betrayedTargets.clear(); } };
}
