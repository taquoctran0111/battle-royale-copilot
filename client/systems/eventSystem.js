import { getAlive } from '../core/gameState.js';
import { areAllied, clamp, distXY, randRange, uid } from '../core/utils.js';

export function createEventSystem({ bus, state, config }) {
  const off = [];
  let nextEventAt = Infinity;
  let nextTrapAt = Infinity;
  let nextDropAt = Infinity;
  let bossSpawned = false;
  let bossRewarded = false;
  let triggering = false;
  let disposed = false;
  const dropExpires = new Map();
  const nowMs = () => state.time * 1000;
  const active = () => !disposed && (state.phase === 'BATTLE' || state.phase === 'FINAL');

  function scheduleEvent() {
    nextEventAt = state.time + randRange(...config.events.intervalSec);
  }

  function randomPoint() {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * Math.max(0, state.zone.radius);
    return {
      x: clamp(state.zone.cx + Math.cos(angle) * radius, 0, state.arena.w),
      y: clamp(state.zone.cy + Math.sin(angle) * radius, 0, state.arena.h),
    };
  }

  function hotspot() {
    const players = getAlive(state);
    if (!players.length) return randomPoint();
    const weights = players.map((player) => players.filter((other) => distXY(player.x, player.y, other.x, other.y) <= config.events.hotspotRadius).length);
    let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
    let center = players[0];
    for (let index = 0; index < players.length; index += 1) {
      roll -= weights[index];
      if (roll <= 0) { center = players[index]; break; }
    }
    return { x: clamp(center.x + randRange(-config.events.hotspotScatterRadius, config.events.hotspotScatterRadius), 0, state.arena.w),
      y: clamp(center.y + randRange(-config.events.hotspotScatterRadius, config.events.hotspotScatterRadius), 0, state.arena.h) };
  }

  function spawnTrap(kind, point, overrides = {}) {
    if (!active()) return null;
    const id = uid('trap');
    const trapConfig = { ...config.events.traps[kind], ...overrides };
    const trap = { id, ...point, kind, damage: trapConfig.damage, radius: trapConfig.radius, fuseAt: kind === 'bomb' ? nowMs() + trapConfig.fuseMs : Infinity };
    state.traps.push(trap);
    bus.emit('trap:spawned', { id, x: trap.x, y: trap.y, kind });
    return trap;
  }

  function spawnDrop(tier = config.events.automaticDropTier, x, y) {
    if (!active() || !config.gifts.tiers.some((item) => item.tier === tier)) return null;
    if ((x !== undefined && !Number.isFinite(x)) || (y !== undefined && !Number.isFinite(y))) return null;
    const point = randomPoint();
    const drop = { id: uid('drop'), x: clamp(x ?? point.x, 0, state.arena.w), y: clamp(y ?? point.y, 0, state.arena.h), tier };
    state.drops.push(drop);
    dropExpires.set(drop.id, nowMs() + config.events.dropLifetimeMs);
    bus.emit('drop:spawned', drop);
    return drop;
  }

  function chooseEvent() {
    const alive = getAlive(state).length;
    const eligible = config.events.list.filter((event) => event.weight > 0 && (event.type !== 'boss' ||
      (!bossSpawned && !state.boss && alive >= Math.max(config.events.bossMinAlive, event.minAliveToSpawn ?? config.events.bossMinAlive))));
    const total = eligible.reduce((sum, event) => sum + event.weight, 0);
    let roll = Math.random() * total;
    for (const event of eligible) {
      roll -= event.weight;
      if (roll <= 0) return event;
    }
    return eligible[0];
  }

  function publishEnergy() {
    bus.emit('energy:changed', { value: state.energy.value, max: state.energy.max });
  }

  function triggerRandomEvent(consumeEnergy = false) {
    if (!active() || triggering) return false;
    const event = chooseEvent();
    scheduleEvent();
    if (!event) return false;
    triggering = true;
    try {
      if (consumeEnergy) {
        state.energy.value = config.events.energy.resetAfterTrigger;
        publishEnergy();
      }
      if (event.type === 'boss') bossSpawned = true;
      bus.emit('event:triggered', { type: event.type });
      if (!active()) return true;
      if (event.type === 'bombRain' || event.type === 'meteor') {
        const count = event.type === 'bombRain' ? event.bombs : event.count;
        for (let index = 0; index < count; index += 1) {
          spawnTrap('bomb', randomPoint(), { damage: event.damage, radius: event.radius });
        }
      } else if (event.type === 'boss') {
        const boss = { id: uid('boss'), x: state.zone.cx, y: state.zone.cy, hp: event.hp, maxHp: event.hp, atk: event.atk, speed: event.speed };
        state.boss = boss;
        bus.emit('boss:spawned', { id: boss.id, hp: boss.hp, maxHp: boss.maxHp });
      }
      return true;
    } finally {
      triggering = false;
    }
  }

  function triggerTraps() {
    for (let index = state.traps.length - 1; index >= 0; index -= 1) {
      const trap = state.traps[index];
      const victims = getAlive(state).filter((player) => distXY(player.x, player.y, trap.x, trap.y) <= trap.radius);
      const fuseExpired = trap.kind === 'bomb' && nowMs() >= trap.fuseAt;
      if (!victims.length && !fuseExpired) continue;
      state.traps.splice(index, 1);
      bus.emit('trap:triggered', { id: trap.id, x: trap.x, y: trap.y, victims: victims.map((player) => player.id) });
      for (const player of victims) bus.emit('damage:request', { targetId: player.id, amount: trap.damage, sourceId: null, cause: trap.kind === 'bomb' ? 'bomb' : 'trap' });
    }
  }

  off.push(bus.on('drop:request', (payload) => {
    if (!payload) return;
    spawnDrop(payload.tier, payload.x, payload.y);
  }));
  off.push(bus.on('drop:collected', (payload) => {
    if (!active() || !payload?.id) return;
    const index = state.drops.findIndex((drop) => drop.id === payload.id);
    if (index !== -1) state.drops.splice(index, 1);
    dropExpires.delete(payload.id);
  }));
  off.push(bus.on('energy:add', (payload) => {
    const value = Number(payload?.amount);
    if (!Number.isFinite(value) || value <= 0) return;
    state.energy.value = Math.min(state.energy.max, state.energy.value + value);
    publishEnergy();
    if (state.energy.value >= config.events.energy.triggerThreshold && active()) {
      triggerRandomEvent(true);
    }
  }));
  off.push(bus.on('boss:spawned', () => { if (active()) bossSpawned = true; }));
  off.push(bus.on('boss:defeated', (payload) => {
    if (!active() || !bossSpawned || bossRewarded || !Array.isArray(payload?.topDamagers)) return;
    bossRewarded = true;
    const rewardPercent = config.events.list.find((event) => event.type === 'boss')?.rewardHealPercent ?? config.events.bossRewardHealPercent;
    const winners = payload.topDamagers.slice().sort((a, b) => b.damage - a.damage).slice(0, config.events.bossRewardWinners);
    for (const winner of winners) {
      const player = state.players.get(String(winner.playerId));
      if (!player || player.status !== 'alive' || !Number.isFinite(winner.damage) || winner.damage <= 0) continue;
      bus.emit('heal:request', { targetId: player.id, amount: player.maxHp * rewardPercent, sourceId: null });
      bus.emit('buff:apply', { playerId: player.id, type: 'rage', durationMs: config.gifts.rageBuff.durationMs, value: config.gifts.rageBuff.atkMult });
    }
  }));
  off.push(bus.on('ultimate:fire', (payload) => {
    if (!active()) return;
    const source = state.players.get(String(payload?.byId));
    if (!source) return;
    const ultimate = config.gifts.tiers.find((tier) => tier.tier === 4).ultimate;
    for (const target of getAlive(state)) {
      if (target.id === source.id || areAllied(source, target)) continue;
      bus.emit('damage:request', { targetId: target.id, amount: ultimate.damage, sourceId: source.id, cause: 'ultimate' });
    }
  }));
  off.push(bus.on('round:phase', (payload) => {
    if (payload?.phase === 'BATTLE') {
      scheduleEvent();
      nextTrapAt = state.time + randRange(...config.events.trapSpawnSec);
      nextDropAt = state.time + randRange(...config.events.dropSpawnSec);
    }
    if (payload?.phase === 'LOBBY') {
      state.traps.length = 0;
      state.drops.length = 0;
      state.boss = null;
      dropExpires.clear();
      bossSpawned = false;
      bossRewarded = false;
      nextEventAt = nextTrapAt = nextDropAt = Infinity;
      state.energy.value = config.events.energy.resetAfterTrigger;
      publishEnergy();
    }
  }));

  function update(dt) {
    if (!active() || !Number.isFinite(dt) || dt <= 0) return;
    if (state.energy.value >= config.events.energy.triggerThreshold) {
      triggerRandomEvent(true);
    }
    if (state.time >= nextEventAt) triggerRandomEvent();
    if (state.time >= nextTrapAt) {
      spawnTrap(Math.random() < config.events.spikeChance ? 'spike' : 'bomb', hotspot());
      nextTrapAt = state.time + randRange(...config.events.trapSpawnSec);
    }
    if (state.time >= nextDropAt) {
      spawnDrop();
      nextDropAt = state.time + randRange(...config.events.dropSpawnSec);
    }
    for (let index = state.drops.length - 1; index >= 0; index -= 1) {
      const drop = state.drops[index];
      if ((dropExpires.get(drop.id) ?? Infinity) <= nowMs()) {
        state.drops.splice(index, 1);
        dropExpires.delete(drop.id);
      }
    }
    triggerTraps();
  }

  return { update, spawnDrop, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); dropExpires.clear(); } };
}
