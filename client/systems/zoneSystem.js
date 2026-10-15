import { getAlive } from '../core/gameState.js';
import { clamp, distXY } from '../core/utils.js';

export function createZoneSystem({ bus, state, config }) {
  const off = [];
  let battleStartedAt = null;
  let battleStartedAtMs = 0;
  let stageIndex = -1;
  let nextDamageAt = Infinity;
  let stormStartedAt = Infinity;
  let stormUntil = 0;
  let stormDps = 0;
  let disposed = false;
  const active = () => state.phase === 'BATTLE' || state.phase === 'FINAL';

  function reset() {
    battleStartedAt = null;
    stageIndex = -1;
    nextDamageAt = Infinity;
    stormUntil = 0;
    stormStartedAt = Infinity;
    stormDps = 0;
    Object.assign(state.zone, { cx: state.arena.cx, cy: state.arena.cy, radius: config.zone.initialRadius, targetRadius: config.zone.initialRadius });
  }

  // Sample configured timestamps, not the tick which first notices a stage.
  function sample(elapsed) {
    let radius = config.zone.initialRadius;
    let dps = config.zone.baseDps;
    for (let index = 0; index < config.zone.stages.length; index += 1) {
      const stage = config.zone.stages[index];
      if (elapsed < stage.atSec) break;
      const end = Math.min(elapsed, config.zone.stages[index + 1]?.atSec ?? elapsed);
      const progress = stage.shrinkSec > 0 ? clamp((end - stage.atSec) / stage.shrinkSec, 0, 1) : 1;
      radius += (stage.radius - radius) * progress;
      dps = stage.dps;
    }
    return { radius, dps };
  }

  function announce(nextRadius, atSec) {
    bus.emit('zone:update', { cx: state.zone.cx, cy: state.zone.cy, radius: state.zone.radius, nextRadius, shrinkAtMs: battleStartedAtMs + atSec * 1000 });
  }

  off.push(bus.on('round:phase', (payload) => {
    if (payload?.phase === 'BATTLE') {
      reset();
      battleStartedAt = state.time;
      battleStartedAtMs = Date.now();
      nextDamageAt = state.time + config.zone.damageTickMs / 1000;
      const first = config.zone.stages[0];
      announce(first?.radius ?? state.zone.radius, first?.atSec ?? 0);
    }
    if (payload?.phase === 'LOBBY') reset();
    if (payload?.phase === 'RESULT') { battleStartedAt = null; stormUntil = 0; }
  }));
  off.push(bus.on('event:triggered', (payload) => {
    if (!active() || payload?.type !== 'storm') return;
    const storm = config.events.list.find((event) => event.type === 'storm');
    if (!storm) return;
    stormStartedAt = state.time;
    stormUntil = state.time + storm.durationSec;
    stormDps = storm.dps;
  }));

  function update(dt) {
    if (disposed || state.mode === 'raid' || battleStartedAt === null || !active() || !Number.isFinite(dt) || dt <= 0) return;
    const elapsed = state.time - battleStartedAt;
    const stages = config.zone.stages;
    const duration = config.phases.durationSec.BATTLE + (state.phase === 'FINAL' ? config.phases.durationSec.FINAL : 0);
    const ownerClock = state.phaseEndsAt - duration * 1000;
    const clockShifted = state.phaseEndsAt > 0 && Math.abs(ownerClock - battleStartedAtMs) > config.runtime.clockDriftToleranceMs;
    if (clockShifted) battleStartedAtMs = ownerClock;
    while (stageIndex + 1 < stages.length && elapsed >= stages[stageIndex + 1].atSec) {
      stageIndex += 1;
      const stage = stages[stageIndex];
      state.zone.radius = sample(stage.atSec).radius;
      state.zone.targetRadius = stage.radius;
      announce(stage.radius, stage.atSec);
    }
    state.zone.radius = sample(elapsed).radius;
    if (clockShifted) {
      const current = stages[stageIndex];
      const warning = current && elapsed < current.atSec + current.shrinkSec ? current : stages[stageIndex + 1];
      if (warning) announce(warning.radius, warning.atSec);
    }
    const damageStep = config.zone.damageTickMs / 1000;
    if (damageStep <= 0) return;
    while (nextDamageAt <= state.time) {
      const zone = sample(nextDamageAt - battleStartedAt);
      const dps = zone.dps + (nextDamageAt >= stormStartedAt && nextDamageAt < stormUntil ? stormDps : 0);
      nextDamageAt += damageStep;
      for (const player of getAlive(state)) {
        if (distXY(player.x, player.y, state.zone.cx, state.zone.cy) > zone.radius) {
          bus.emit('damage:request', { targetId: player.id, amount: dps * damageStep, sourceId: null, cause: 'zone' });
        }
      }
    }
  }

  return { update, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); } };
}
