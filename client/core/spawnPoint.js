import { getAlive } from './gameState.js';

export function findOpenSpawn(state, config, radius, excludeId) {
  const marginX = Math.min(radius, state.arena.w / 2);
  const marginY = Math.min(radius, state.arena.h / 2);
  const zoneRadius = Math.max(0, state.zone.radius - radius);
  const occupied = getAlive(state).filter((player) => player.id !== excludeId)
    .map((player) => ({ x: player.x, y: player.y, radius: config.ui.playerRadius }));
  if (state.boss && state.boss.id !== excludeId) occupied.push({
    x: state.boss.x, y: state.boss.y,
    radius: config.ui.bossRadius * (state.boss.type === 'fusion' ? 1.95 : 1),
  });
  const left = Math.max(marginX, state.zone.cx - zoneRadius);
  const right = Math.min(state.arena.w - marginX, state.zone.cx + zoneRadius);
  const top = Math.max(marginY, state.zone.cy - zoneRadius);
  const bottom = Math.min(state.arena.h - marginY, state.zone.cy + zoneRadius);
  let best = null;
  let clearance = -Infinity;
  const fits = state.zone.radius >= radius && state.arena.w >= radius * 2 && state.arena.h >= radius * 2;
  // A bounded grid also finds gaps when repeated random samples miss them.
  for (let row = 0; row <= 16; row++) {
    for (let column = 0; column <= 16; column++) {
      const x = left + (right - left) * column / 16;
      const y = top + (bottom - top) * row / 16;
      if (!fits || left > right || top > bottom) continue;
      if (Math.hypot(x - state.zone.cx, y - state.zone.cy) > zoneRadius) continue;
      const distance = occupied.reduce((min, entity) => Math.min(min, Math.hypot(x - entity.x, y - entity.y) - radius - entity.radius), Infinity);
      if (distance > clearance) { best = { x, y }; clearance = distance; }
    }
  }
  if (!best) {
    console.warn('[spawn] Bo quá nhỏ hoặc ngoài map; không thể chứa trọn nhân vật.');
    best = {
      x: Math.max(marginX, Math.min(state.arena.w - marginX, state.zone.cx)),
      y: Math.max(marginY, Math.min(state.arena.h - marginY, state.zone.cy)),
    };
    clearance = occupied.reduce((min, entity) => Math.min(min, Math.hypot(best.x - entity.x, best.y - entity.y) - radius - entity.radius), Infinity);
  }
  if (clearance < 0) console.warn('[spawn] Không còn vị trí trống trong bo; dùng vị trí ít chồng lấp nhất.');
  return best;
}
