import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../client/core/config.js';
import { createState, resetRound } from '../client/core/gameState.js';
import { createEventBus } from '../client/core/eventBus.js';
import { validateEventPayload } from '../client/core/eventCatalog.js';
import { createPlayer } from '../client/entities/playerFactory.js';
import { createCombatSystem } from '../client/systems/combatSystem.js';
import { createGiftEffectSystem } from '../client/systems/giftEffectSystem.js';
import { createMovementSystem } from '../client/systems/movementSystem.js';
import { createEffects } from '../client/render/effects.js';
import { createRenderer } from '../client/render/renderer.js';

function game(classId = 'swordsman') {
  const cfg = structuredClone(config);
  cfg.combat.critChance = 0;
  const state = createState(cfg), bus = createEventBus(cfg);
  state.phase = 'BATTLE'; state.zone.radius = 10000;
  const gifts = createGiftEffectSystem({ state, bus, config: cfg });
  const combat = createCombatSystem({ state, bus, config: cfg });
  const add = (id, kind, x, y) => {
    const player = createPlayer({ id, name: id }, state, cfg, kind);
    Object.assign(player, { x, prevX: x, y, prevY: y, range: 0 });
    state.players.set(id, player);
    return player;
  };
  const player = add('caster', classId, 500, 900);
  return { cfg, state, bus, player, add, combat, gifts,
    step(dt) { state.time += dt; gifts.update(dt); combat.update(dt); },
    dispose() { combat.dispose(); gifts.dispose(); } };
}

test('mana: battle-only 15 second fill, cap/hold, one cast, death/revival/round reset and disposal', () => {
  const g = game();
  try {
    const { state, player, bus, combat } = g;
    assert.equal(player.mana, 0); assert.equal(player.maxMana, 100);
    for (const phase of ['LOBBY', 'COUNTDOWN', 'RESULT']) {
      state.phase = phase; g.step(5); assert.equal(player.mana, 0);
    }
    state.phase = 'BATTLE';
    g.step(7.5); assert.equal(player.mana, 50);
    g.step(20); assert.equal(player.mana, 100);
    const target = g.add('target', 'tank', 550, 900);
    const casts = [];
    bus.on('skill:cast', (event) => { assert.deepEqual(validateEventPayload('skill:cast', event), []); casts.push(event); });
    g.step(1 / 30);
    assert.equal(casts.length, 1); assert.equal(player.mana, 0);
    g.step(7.5); assert.equal(casts.length, 1); assert.equal(player.mana, 50);
    state.phase = 'FINAL'; target.x = 1000;
    g.step(7.5); assert.equal(player.mana, 100);
    bus.emit('damage:request', { targetId: player.id, sourceId: null, cause: 'zone', amount: 10000 });
    assert.equal(player.status, 'dead'); assert.equal(player.mana, 0);
    g.step(15); assert.equal(player.mana, 0);
    bus.emit('revive:request', { playerId: player.id, byId: null });
    assert.equal(player.mana, 0);
    player.mana = 70; resetRound(state, { keepPlayers: true });
    assert.equal(player.mana, 0);
    player.mana = 25; state.phase = 'BATTLE'; combat.dispose(); g.step(5);
    assert.equal(player.mana, 25);
  } finally { g.dispose(); }
});

for (const classId of config.classOrder) {
  test(`skill ${classId}: exact damage/support, range, allies and boss`, () => {
    const g = game(classId);
    try {
      const { player, state, bus, cfg } = g;
      const enemy = g.add('enemy', 'tank', 550, 900);
      const adjacent = g.add('adjacent', 'tank', 590, 900);
      const distant = g.add('distant', 'tank', 1000, 900);
      const ally = g.add('ally', 'tank', 510, 900);
      player.allianceId = ally.id; ally.allianceId = player.id;
      for (const other of [enemy, adjacent, distant, ally]) other.hp = other.maxHp = 1000;
      state.boss = { id: 'boss', x: 580, y: 920, hp: 1000, maxHp: 1000, atk: 0, speed: 0 };
      player.targetId = enemy.id;
      player.hp = player.maxHp - 50;
      const casts = [], damage = [];
      bus.on('skill:cast', (event) => casts.push(event));
      bus.on('damage:request', (event) => {
        assert.deepEqual(validateEventPayload('damage:request', event), []);
        if (event.cause === 'skill') damage.push(event);
      });
      player.mana = player.maxMana;
      g.step(.01);
      assert.equal(casts.length, 1); assert.equal(player.mana, 0);
      assert.equal(ally.hp, 1000); assert.equal(distant.hp, 1000);
      const skill = cfg.skills[classId];
      if (classId === 'tank') {
        assert.equal(player.shield, skill.shield);
        assert.equal(player.hp, player.maxHp - 50 + player.maxHp * skill.healPercent);
        assert.equal(enemy.hp, 1000);
        assert.equal(damage.length, 0);
        g.step(skill.durationMs / 1000);
        assert.equal(player.shield, 0);
      } else {
        const mult = cfg.alliance.buff.atkMult;
        const amount = player.atk * mult * skill.damageMult;
        const shots = skill.shots ?? 1;
        assert.ok(Math.abs(enemy.hp - (1000 - amount * shots)) < 1e-8);
        assert.equal(damage.filter((event) => event.targetId === enemy.id).length, shots);
        if (classId === 'archer') {
          assert.equal(adjacent.hp, 1000); assert.equal(state.boss.hp, 1000);
        } else {
          assert.ok(adjacent.hp < 1000); assert.ok(state.boss.hp < 1000);
        }
        for (const other of [enemy, adjacent, distant, ally]) other.status = 'dead';
        player.allianceId = null; player.targetId = state.boss.id;
        player.mana = player.maxMana;
        const hp = state.boss.hp;
        g.step(.01);
        assert.equal(casts.length, 2); assert.ok(state.boss.hp < hp);
      }
    } finally { g.dispose(); }
  });
}

test('skills: no overkill credit, no duplicate death and friendly-fire guard', () => {
  const g = game('archer');
  try {
    const enemy = g.add('enemy', 'tank', 550, 900);
    enemy.hp = 1;
    let deaths = 0;
    g.bus.on('player:killed', (event) => { assert.deepEqual(validateEventPayload('player:killed', event), []); deaths++; });
    g.player.mana = g.player.maxMana;
    g.step(.01);
    assert.equal(deaths, 1); assert.equal(g.player.damageDealt, 1);
    const ally = g.add('ally', 'tank', 550, 900);
    g.player.allianceId = ally.id; ally.allianceId = g.player.id;
    g.bus.emit('damage:request', { targetId: ally.id, sourceId: g.player.id, amount: 99, cause: 'skill' });
    assert.equal(ally.hp, ally.maxHp);
  } finally { g.dispose(); }
});

test('movement: retreating at all map edges turns inward; combat orbit/patrol never idle or linger at the wall', () => {
  for (const [x, y, ex, ey] of [[23, 900, 80, 900], [1057, 900, 1000, 900], [500, 23, 500, 80], [500, 1897, 500, 1840]]) {
    const g = game('archer');
    const movement = createMovementSystem({ state: g.state, bus: g.bus, config: g.cfg });
    try {
      const player = g.player;
      Object.assign(player, { x, y, prevX: x, prevY: y, range: 320 });
      const enemy = g.add('enemy', 'tank', ex, ey);
      let edgeTicks = 0, stoppedTicks = 0;
      for (let tick = 0; tick < 900; tick++) {
        g.state.time += 1 / 30;
        if (tick === 300) enemy.status = 'dead';
        movement.update(1 / 30);
        if (tick === 0) {
          assert.ok(x !== 23 || player.vx > 0);
          assert.ok(x !== 1057 || player.vx < 0);
          assert.ok(y !== 23 || player.vy > 0);
          assert.ok(y !== 1897 || player.vy < 0);
        }
        if (Math.hypot(player.vx, player.vy) < 5) stoppedTicks++;
        if (player.x < 50 || player.x > 1030 || player.y < 50 || player.y > 1870) edgeTicks++;
      }
      assert.equal(stoppedTicks, 0);
      assert.ok(edgeTicks < 30, `edge occupancy ${(edgeTicks / 900 * 100).toFixed(1)}%`);
      assert.ok(Math.hypot(player.x - x, player.y - y) > 100);
    } finally { movement.dispose(); g.dispose(); }
  }
});

test('presentation: skill effects, negative HP text, aura, mana and damage trail are bounded/read-only and expire', () => {
  const g = game();
  const calls = [];
  const ctx = new Proxy({}, {
    get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]),
    set: (target, key, value) => { target[key] = value; calls.push([key, value]); return true; },
  });
  const effects = createEffects({ state: g.state, bus: g.bus, config: g.cfg });
  const renderer = createRenderer({ canvas: { getContext: () => ctx }, state: g.state, bus: g.bus, config: g.cfg });
  try {
    g.player.shield = 35; g.player.mana = 50;
    for (const classId of g.cfg.classOrder) {
      g.bus.emit('skill:cast', { playerId: g.player.id, classId, x: 500, y: 900, targetX: 560, targetY: 900, radius: g.cfg.skills[classId].radius });
    }
    g.player.hp -= 25;
    g.bus.emit('player:damaged', { targetId: g.player.id, amount: 25, sourceId: null, cause: 'skill', crit: false });
    const before = structuredClone(g.state);
    renderer.render(1); effects.render(ctx, 1);
    assert.deepEqual(g.state, before);
    assert.ok(calls.some(([key, text]) => key === 'strokeText' && text === '-25'));
    assert.ok(calls.some(([key, text]) => key === 'fillText' && text === g.cfg.skills.mage.name));
    assert.ok(calls.some(([key, x, y, width, height]) => key === 'fillRect' && height === g.cfg.ui.manaBarHeight && width === g.cfg.ui.hpBarWidth * .5));
    assert.ok(calls.some(([key, x, y, rx, ry]) => key === 'ellipse' && ry > rx));
    const trailIndex = calls.findIndex(([key, value]) => key === 'fillStyle' && value === '#ffbe62');
    assert.ok(trailIndex >= 0);
    const trail = calls[trailIndex + 1];
    assert.equal(trail[0], 'fillRect');
    const trailWidth = g.cfg.ui.hpBarWidth * 25 / g.player.maxHp;
    assert.ok(trail[3] > trailWidth * .9 && trail[3] <= trailWidth);
    renderer.update(1); calls.length = 0; renderer.render(1);
    assert.equal(calls.some(([key, value]) => key === 'fillStyle' && value === '#ffbe62'), false);
    for (let i = 0; i < 1000; i++) g.bus.emit('skill:cast', { playerId: g.player.id, classId: 'mage', x: 500, y: 900, targetX: 560, targetY: 900, radius: 125 });
    assert.ok(effects.particleCount <= g.cfg.ui.maxParticles);
    effects.update(5); assert.equal(effects.particleCount, 0);
    assert.deepEqual(g.state, before);
  } finally { renderer.dispose(); effects.dispose(); g.dispose(); }
  assert.equal(g.bus.listenerCount('skill:cast'), 0);
});

test('movement: low HP flees, healthy fighters seek/orbit and zone safety overrides pursuit', () => {
  const g = game();
  g.cfg.movement.velocitySmoothing = 1;
  g.cfg.movement.separationStrength = 0;
  const movement = createMovementSystem({ state: g.state, bus: g.bus, config: g.cfg });
  try {
    const enemy = g.add('enemy', 'tank', 600, 900);
    g.player.range = 60;
    g.player.hp = g.player.maxHp * .2;
    movement.update(1 / 30);
    assert.ok(g.player.vx < 0);
    g.player.hp = g.player.maxHp;
    movement.update(1 / 30);
    assert.ok(g.player.vx > 0);
    enemy.x = g.player.x + 45; enemy.y = g.player.y;
    movement.update(1 / 30);
    assert.ok(Math.abs(g.player.vy) > 0);
    Object.assign(g.state.zone, { cx: 540, cy: 960, radius: 200 });
    Object.assign(g.player, { x: 730, y: 960 });
    Object.assign(enemy, { x: 900, y: 960 });
    movement.update(1 / 30);
    assert.ok(g.player.vx < 0, 'return toward zone center instead of chasing an unsafe target');
  } finally { movement.dispose(); g.dispose(); }
});
