import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../client/core/config.js';
import { createState } from '../client/core/gameState.js';
import { createEventBus } from '../client/core/eventBus.js';
import { createRng } from '../client/core/utils.js';
import { createRoundManager } from '../client/systems/roundManager.js';
import { createEffects } from '../client/render/effects.js';
import { createEventSystem } from '../client/systems/eventSystem.js';
import { createPlayer } from '../client/entities/playerFactory.js';
import { createInputRouter } from '../client/input/inputRouter.js';
import { createGiftEffectSystem } from '../client/systems/giftEffectSystem.js';
import { createCombatSystem } from '../client/systems/combatSystem.js';
import { createRenderer } from '../client/render/renderer.js';
import { findOpenSpawn } from '../client/core/spawnPoint.js';

test('battle spawn: seeded random positions stay inside map and initial zone with separation and synchronized interpolation', () => {
  function spawn(seed, width = 1080, height = 1920) {
    const cfg = structuredClone(config);
    cfg.arena = { w: width, h: height };
    cfg.phases.durationSec.LOBBY = cfg.phases.durationSec.COUNTDOWN = .1;
    cfg.lobby.botFillTo = 40;
    const state = createState(cfg), bus = createEventBus(cfg);
    const round = createRoundManager({ state, bus, config: cfg, rng: createRng(seed).next });
    round.update(.1);
    assert.equal(state.phase, 'COUNTDOWN');
    round.update(.1);
    assert.equal(state.phase, 'BATTLE');
    const points = [...state.players.values()].map((player) => {
      assert.equal(player.x, player.prevX); assert.equal(player.y, player.prevY);
      assert.equal(player.vx, 0); assert.equal(player.vy, 0);
      assert.ok(player.x >= cfg.ui.playerRadius && player.x <= width - cfg.ui.playerRadius);
      assert.ok(player.y >= cfg.ui.playerRadius && player.y <= height - cfg.ui.playerRadius);
      assert.ok(Math.hypot(player.x - state.arena.cx, player.y - state.arena.cy) <= cfg.zone.initialRadius - cfg.ui.playerRadius);
      return { x: player.x, y: player.y };
    });
    round.dispose();
    return points;
  }
  for (const [width, height] of [[1080, 1920], [1920, 1080]]) {
    const points = spawn(17, width, height);
    assert.deepEqual(points, spawn(17, width, height));
    assert.notDeepEqual(points, spawn(42, width, height));
    for (let i = 0; i < points.length; i++) for (let j = 0; j < i; j++) {
      assert.ok(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) >= config.spawn.minDistance);
    }
    assert.ok(new Set(points.map((point) => Math.round(Math.hypot(point.x - width / 2, point.y - height / 2)))).size > 20);
  }
});

test('weather effects: storm expires, meteor warning matches impact radius, effects stop at results without mutating state', () => {
  const cfg = structuredClone(config);
  cfg.events.list = [{ ...cfg.events.list.find((event) => event.type === 'meteor'), weight: 1 }, { type: 'storm', weight: 0, durationSec: 12, dps: 6 }];
  const state = createState(cfg), bus = createEventBus(cfg);
  state.phase = 'BATTLE';
  const effects = createEffects({ state, bus, config: cfg });
  const events = createEventSystem({ state, bus, config: cfg });
  const calls = [];
  const ctx = new Proxy({}, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
  bus.emit('event:triggered', { type: 'storm' });
  const before = structuredClone(state);
  effects.update(.05); effects.render(ctx);
  assert.deepEqual(state, before);
  assert.ok(calls.filter(([method]) => method === 'lineTo').length >= 90);
  state.time = 12;
  calls.length = 0; effects.render(ctx);
  assert.equal(calls.length, 0);
  bus.emit('round:phase', { phase: 'BATTLE' });
  bus.emit('energy:add', { amount: 100 });
  const meteor = state.traps[0];
  calls.length = 0; effects.render(ctx);
  assert.ok(calls.some(([method, x, y, radius]) => method === 'arc' && x === meteor.x && y === meteor.y && radius === meteor.radius));
  state.time = meteor.fuseAt / 1000;
  events.update(.01);
  assert.ok(effects.particleCount > 0);
  state.phase = 'RESULT'; bus.emit('round:phase', { phase: 'RESULT' });
  calls.length = 0; effects.render(ctx);
  assert.equal(effects.particleCount, 0);
  assert.equal(calls.length, 0);
  effects.dispose(); events.dispose();
  assert.equal(bus.listenerCount('event:triggered'), 0);
});

test('boss: one Tier 4 gift revives an existing player and spawns only a boss at a separate open position', () => {
  for (const bossFirst of [false, true]) {
    const cfg = structuredClone(config);
    cfg.events.list = [{ ...cfg.events.list.find((event) => event.type === 'boss'), weight: 1 }];
    const state = createState(cfg), bus = createEventBus(cfg);
    const systems = [
      createInputRouter({ state, bus, config: cfg }),
      createRoundManager({ state, bus, config: cfg }),
      createGiftEffectSystem({ state, bus, config: cfg }),
      createEventSystem({ state, bus, config: cfg }),
      createCombatSystem({ state, bus, config: cfg }),
    ];
    state.phase = 'BATTLE';
    for (let i = 0; i < 8; i++) {
      const player = createPlayer({ id: `boss-viewer-${i}`, name: `Viewer ${i}` }, state, cfg);
      state.players.set(player.id, player);
    }
    const revived = state.players.get('boss-viewer-1');
    revived.status = 'dead'; revived.hp = 0;
    const ids = [...state.players.keys()];
    let joined = 0, revivedCount = 0, spawned = 0;
    bus.on('player:joined', () => joined++);
    bus.on('player:revived', () => revivedCount++);
    bus.on('boss:spawned', () => spawned++);
    if (bossFirst) bus.emit('energy:add', { amount: 100 });
    bus.emit('live:gift', { userId: 'boss-viewer-0', nickname: 'Viewer 0', diamonds: 1000, count: 1, giftName: 'Galaxy' });
    assert.deepEqual([...state.players.keys()], ids);
    assert.equal(joined, 0);
    assert.equal(spawned, 1);
    assert.equal(revivedCount, 1);
    assert.equal(revived.status, 'alive');
    assert.equal(revived.x, revived.prevX); assert.equal(revived.y, revived.prevY);
    for (const player of state.players.values()) {
      assert.ok(Math.hypot(player.x - state.boss.x, player.y - state.boss.y) >= cfg.ui.playerRadius + cfg.ui.bossRadius);
    }
    assert.ok(Math.hypot(state.boss.x - state.zone.cx, state.boss.y - state.zone.cy) <= state.zone.radius - cfg.ui.bossRadius);
    systems.reverse().forEach((system) => system.dispose());
  }
});

test('open spawn: respects small/off-center zones and reports unavoidable overlap without looping', () => {
  const cfg = structuredClone(config), state = createState(cfg);
  state.zone = { cx: 320, cy: 740, radius: 60 };
  const point = findOpenSpawn(state, cfg, cfg.ui.playerRadius);
  assert.ok(Math.hypot(point.x - 320, point.y - 740) <= 60 - cfg.ui.playerRadius);
  state.arena = { w: 30, h: 30, cx: 15, cy: 15 };
  state.zone = { cx: 15, cy: 15, radius: 10 };
  const player = createPlayer({ id: 'crowded' }, state, cfg);
  state.players.set(player.id, player);
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    assert.deepEqual(findOpenSpawn(state, cfg, cfg.ui.bossRadius), { x: 15, y: 15 });
    assert.ok(warnings.length >= 1);
  } finally { console.warn = warn; }
});

test('boss renderer: attacks animate on real boss damage, expire and never create or mutate players', () => {
  const cfg = structuredClone(config), state = createState(cfg), bus = createEventBus(cfg);
  state.phase = 'BATTLE';
  const target = createPlayer({ id: 'boss-target' }, state, cfg);
  target.x = 700; target.y = 900;
  state.players.set(target.id, target);
  state.boss = { id: 'fighting-boss', x: 600, y: 900, hp: 1500, maxHp: 1500 };
  const calls = [];
  const ctx = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, {
    get: (object, key) => key in object ? object[key] : (...args) => calls.push([key, ...args]),
  });
  const canvas = { getContext: () => ctx, ownerDocument: { createElement: () => ({ getContext: () => ctx }) } };
  const renderer = createRenderer({ canvas, state, bus, config: cfg });
  const before = structuredClone(state);
  renderer.render(1);
  calls.length = 0;
  bus.emit('player:damaged', { targetId: target.id, sourceId: state.boss.id, cause: 'boss', amount: 25 });
  renderer.update(.1); renderer.render(1);
  const swingRadius = cfg.ui.bossRadius + 18;
  assert.ok(calls.some(([method, , , radius]) => method === 'arc' && radius === swingRadius));
  assert.ok(calls.some(([method, x]) => method === 'translate' && x > state.boss.x));
  renderer.update(1);
  calls.length = 0; renderer.render(1);
  assert.equal(calls.some(([method, , , radius]) => method === 'arc' && radius === swingRadius), false);
  assert.deepEqual(state, before);
  renderer.dispose();
  assert.equal(bus.listenerCount('player:damaged'), 0);
});
