import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../client/core/config.js';
import { createState, getAlive } from '../client/core/gameState.js';
import { createEventBus } from '../client/core/eventBus.js';
import { validateEventPayload } from '../client/core/eventCatalog.js';
import { createRng, getEffectiveStats } from '../client/core/utils.js';
import { createPlayer } from '../client/entities/playerFactory.js';
import { createRoundManager } from '../client/systems/roundManager.js';
import { createGiftEffectSystem } from '../client/systems/giftEffectSystem.js';
import { createAllianceSystem } from '../client/systems/allianceSystem.js';
import { createZoneSystem } from '../client/systems/zoneSystem.js';
import { createEventSystem } from '../client/systems/eventSystem.js';
import { createMovementSystem } from '../client/systems/movementSystem.js';
import { createCombatSystem } from '../client/systems/combatSystem.js';
import { createEffects } from '../client/render/effects.js';
import { createRenderer } from '../client/render/renderer.js';
import { updateBossSkill } from '../client/systems/bossSkills.js';

function game(roundId = 3, bot = false) {
  const cfg = structuredClone(config);
  Object.assign(cfg.phases.durationSec, { LOBBY: .1, COUNTDOWN: .1, RESULT: .1 });
  cfg.lobby.botFillTo = 1;
  cfg.events.intervalSec = cfg.events.trapSpawnSec = cfg.events.dropSpawnSec = [10000, 10000];
  cfg.combat.critChance = 0;
  const state = createState(cfg);
  state.roundId = roundId;
  const base = createEventBus(cfg), log = [];
  const bus = { ...base, emit(type, payload) {
    assert.deepEqual(validateEventPayload(type, payload), [], type);
    log.push({ type, payload });
    base.emit(type, payload);
  } };
  const add = (id, classId = 'swordsman', isBot = false) => {
    const player = createPlayer({ id, name: id, isBot }, state, cfg, classId);
    state.players.set(id, player);
    return player;
  };
  add(bot ? 'bot_hero' : 'hero', 'swordsman', bot);
  add('second', 'mage');
  const round = createRoundManager({ bus, state, config: cfg, rng: createRng(17).next });
  const gifts = createGiftEffectSystem({ bus, state, config: cfg });
  const alliance = createAllianceSystem({ bus, state, config: cfg });
  const zone = createZoneSystem({ bus, state, config: cfg });
  const events = createEventSystem({ bus, state, config: cfg });
  const movement = createMovementSystem({ bus, state, config: cfg });
  const combat = createCombatSystem({ bus, state, config: cfg });
  const systems = [round, gifts, alliance, zone, events, movement, combat];
  return { cfg, config: cfg, state, bus, log, round, combat, movement, zone, events, add,
    battle() { round.update(.1); round.update(.1); assert.equal(state.phase, 'BATTLE'); },
    tick(dt = 1 / 30) { systems.forEach((system) => system.update(dt)); },
    dispose() { systems.reverse().forEach((system) => system.dispose()); },
  };
}

test('boss variants: random selection reaches all four minor bosses, once per ordinary round', () => {
  const original = Math.random;
  try {
    for (const [index, expected] of config.bosses.minorOrder.entries()) {
      const g = game(1);
      try {
        g.cfg.events.bossMinAlive = 1;
        g.cfg.events.list = [{ ...config.events.list.find((entry) => entry.type === 'boss'), minAliveToSpawn: 1, weight: 1 }];
        g.battle();
        const rng = createRng(100 + index).next;
        let calls = 0;
        Math.random = () => ++calls === 3 ? (index + .1) / 4 : rng();
        g.bus.emit('energy:add', { amount: 100 });
        const boss = g.state.boss;
        assert.equal(boss.type, expected);
        assert.equal(boss.maxHp, g.cfg.events.list[0].hp * g.cfg.bosses[expected].hpMult);
        assert.equal(boss.mana, 0);
        g.bus.emit('damage:request', { targetId: boss.id, sourceId: 'hero', cause: 'attack', amount: 100000 });
        g.bus.emit('energy:add', { amount: 100 });
        assert.equal(g.log.filter(({ type }) => type === 'boss:spawned').length, 1);
        assert.equal(g.state.phase, 'BATTLE');
      } finally { g.dispose(); }
    }
  } finally { Math.random = original; }
});

test('raid cycle: fusion spawns immediately only on rounds 3/6, no random weather or shrinking zone', () => {
  const g = game(1), raids = [];
  try {
    for (let roundId = 1; roundId <= 6; roundId++) {
      assert.equal(g.state.roundId, roundId);
      assert.equal(g.state.mode, roundId % 3 === 0 ? 'raid' : 'battle');
      g.battle();
      if (roundId % 3 === 0) {
        raids.push(roundId);
        assert.equal(g.state.boss.type, 'fusion');
        assert.ok(g.state.boss.maxHp > config.events.list.find((event) => event.type === 'boss').hp * 4);
        const boss = g.state.boss, radius = g.state.zone.radius;
        g.bus.emit('energy:add', { amount: 1000 });
        g.state.time += 200;
        g.zone.update(200);
        g.events.update(200);
        assert.equal(g.state.zone.radius, radius);
        assert.equal(g.state.boss, boss);
        assert.equal(g.state.traps.length, 0);
        g.round.update(g.cfg.bosses.raidDurationSec);
        assert.equal(g.state.raidOutcome, 'defeat');
      } else {
        for (const player of getAlive(g.state).slice(1)) {
          g.bus.emit('damage:request', { targetId: player.id, sourceId: null, cause: 'zone', amount: 10000 });
        }
        g.round.update(.01);
      }
      assert.equal(g.state.phase, 'RESULT');
      g.round.update(.1);
    }
    assert.deepEqual(raids, [3, 6]);
  } finally { g.dispose(); }
});

test('raid cooperation: target boss only; attacks, skills, betrayal and ultimate cannot hurt teammates', () => {
  const g = game();
  try {
    g.cfg.alliance.friendlyFire = true;
    g.battle();
    const hero = g.state.players.get('hero'), second = g.state.players.get('second'), boss = g.state.boss;
    hero.x = second.x = 500; hero.y = second.y = 900;
    boss.x = 550; boss.y = 900; boss.speed = 0;
    hero.targetId = second.id; hero.mana = 100;
    const hp = second.hp;
    for (const cause of ['attack', 'skill', 'betray', 'ultimate']) {
      g.bus.emit('damage:request', { targetId: second.id, sourceId: hero.id, cause, amount: 10000 });
    }
    hero.allianceId = second.id; second.allianceId = hero.id;
    g.state.alliances.set('hero|second', { aId: hero.id, bId: second.id, formedAt: -100000 });
    g.bus.emit('cmd:betray', { playerId: hero.id });
    assert.equal(hero.allianceId, second.id);
    g.movement.update(1 / 30);
    assert.equal(hero.targetId, boss.id);
    assert.equal(second.targetId, boss.id);
    g.combat.update(1 / 30);
    assert.equal(second.hp, hp);
    assert.ok(boss.hp < boss.maxHp);
    const hpBeforeUltimate = boss.hp;
    g.bus.emit('ultimate:fire', { byId: hero.id });
    assert.ok(boss.hp < hpBeforeUltimate);
    assert.equal(second.hp, hp);
  } finally { g.dispose(); }
});

for (const bot of [false, true]) {
  test(`raid reward: last hit beats top damage, buff and crown last exactly next round (${bot ? 'bot' : 'viewer'})`, () => {
    const g = game(3, bot);
    try {
      g.battle();
      const hero = g.state.players.get(bot ? 'bot_hero' : 'hero'), second = g.state.players.get('second'), boss = g.state.boss;
      g.bus.emit('damage:request', { targetId: boss.id, sourceId: second.id, cause: 'skill', amount: boss.hp - 1 });
      g.bus.emit('damage:request', { targetId: boss.id, sourceId: hero.id, cause: 'skill', amount: 1 });
      assert.equal(g.state.phase, 'RESULT');
      assert.equal(g.state.raidOutcome, 'victory');
      const result = g.log.find(({ type }) => type === 'round:ended').payload;
      assert.equal(result.winnerId, hero.id);
      assert.equal(result.ranking[0].playerId, hero.id);
      assert.ok(result.ranking[1].damage > result.ranking[0].damage);
      g.bus.emit('damage:request', { targetId: boss.id, sourceId: hero.id, cause: 'skill', amount: 1 });
      assert.equal(g.log.filter(({ type }) => type === 'round:ended').length, 1);
      g.round.update(.1);
      assert.equal(g.state.roundId, 4);
      assert.equal(g.state.players.get(hero.id), hero, 'rewarded bots are kept for their reward round');
      assert.equal(hero.status, 'alive');
      assert.equal(hero.bossSlayerRound, 4);
      assert.equal(hero.maxHp, g.cfg.classes.swordsman.hp * 1.25);
      assert.equal(hero.atk, g.cfg.classes.swordsman.atk * 1.2);
      if (!bot) {
        g.bus.emit('cmd:join', { player: { id: hero.id, name: hero.name, avatar: '', classId: 'tank' } });
        assert.equal(hero.maxHp, g.cfg.classes.tank.hp * 1.25, 'class selection preserves reward without stacking');
        assert.equal(hero.atk, g.cfg.classes.tank.atk * 1.2);
      }
      g.battle();
      for (const player of getAlive(g.state).filter((player) => player !== hero)) {
        g.bus.emit('damage:request', { targetId: player.id, sourceId: null, cause: 'zone', amount: 10000 });
      }
      g.round.update(.01);
      g.round.update(.1);
      assert.equal(g.state.roundId, 5);
      if (bot) assert.equal(g.state.players.has(hero.id), false);
      else {
        assert.equal(hero.maxHp, g.cfg.classes.tank.hp);
        assert.equal(hero.atk, g.cfg.classes.tank.atk);
        assert.notEqual(hero.bossSlayerRound, g.state.roundId);
      }
    } finally { g.dispose(); }
  });
}

test('raid failure: one survivor keeps fighting; timeout or team wipe has no winner or reward', () => {
  for (const wipe of [false, true]) {
    const g = game();
    try {
      g.battle();
      const players = getAlive(g.state);
      g.bus.emit('damage:request', { targetId: players[1].id, sourceId: g.state.boss.id, cause: 'boss', amount: 10000 });
      g.round.update(.01);
      assert.equal(g.state.phase, 'BATTLE');
      if (wipe) g.bus.emit('damage:request', { targetId: players[0].id, sourceId: g.state.boss.id, cause: 'boss', amount: 10000 });
      g.round.update(wipe ? .01 : g.cfg.bosses.raidDurationSec);
      assert.equal(g.state.phase, 'RESULT');
      assert.equal(g.state.raidOutcome, 'defeat');
      assert.equal(g.state.nextRoundReward, null);
      assert.equal(g.log.find(({ type }) => type === 'round:ended').payload.winnerId, null);
    } finally { g.dispose(); }
  }
});

test('boss skills: each mana bar fills, warns once, damages at impact only, applies distinct effects and expires', () => {
  for (const type of [...config.bosses.minorOrder, 'fusion']) {
    const g = game(1);
    try {
      g.state.phase = 'BATTLE';
      const hero = g.state.players.get('hero'), other = g.state.players.get('second');
      hero.x = 550; hero.y = 900; hero.hp = hero.maxHp = 10000;
      other.x = 1000; other.y = 1600;
      const definition = g.cfg.bosses[type], skill = definition.skill;
      const boss = g.state.boss = { id: 'test-boss', type, x: 500, y: 900, hp: 500, maxHp: 1000, mana: 0, maxMana: 100 };
      const update = (dt) => { g.state.time += dt; updateBossSkill(g, dt); };
      update(definition.fillSec / 2);
      assert.equal(boss.mana, 50);
      update(definition.fillSec / 2);
      assert.equal(boss.mana, 0);
      assert.ok(boss.casting);
      assert.equal(hero.hp, 10000, 'warning must not deal damage');
      const cast = { ...boss.casting };
      update(skill.warningSec / 2);
      assert.equal(g.log.filter(({ type }) => type === 'boss:skill').length, 1);
      assert.equal(hero.hp, 10000);
      update(skill.warningSec / 2 + .001);
      assert.equal(boss.casting, null);
      assert.equal(hero.hp, 10000 - Math.max(1, skill.damage - hero.def));
      assert.equal(other.hp, other.maxHp);
      assert.equal(boss.hp, 500 + (skill.healPercent ?? 0) * boss.maxHp);
      if (skill.slowMult) {
        assert.equal(getEffectiveStats(hero, g.cfg, g.state.time * 1000).speed, hero.speed * skill.slowMult);
        assert.equal(getEffectiveStats(hero, g.cfg, (g.state.time + skill.slowSec) * 1000).speed, hero.speed);
      }
      if (skill.pull) assert.ok(Math.hypot(hero.x - cast.x, hero.y - cast.y) <= 50);
      hero.x = cast.x + skill.radius + 1; hero.y = cast.y;
      assert.equal(g.log.filter(({ type }) => type === 'boss:skill').length, 2);
    } finally { g.dispose(); }
  }
});

test('boss presentation: all variants render mana, warnings, skill impacts and slayer badge read-only with bounded effects', () => {
  const g = game();
  const calls = [];
  const ctx = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
  const canvas = { getContext: () => ctx };
  const effects = createEffects(g), renderer = createRenderer({ ...g, canvas });
  try {
    g.battle();
    g.state.players.get('hero').bossSlayerRound = g.state.roundId;
    for (const type of [...config.bosses.minorOrder, 'fusion']) {
      Object.assign(g.state.boss, { type, mana: 50, casting: { x: 500, y: 900, hitsAt: g.state.time + 2 } });
      const before = structuredClone(g.state);
      for (let i = 0; i < 100; i++) g.bus.emit('boss:skill', { bossId: g.state.boss.id, bossType: type, stage: 'impact', x: 500, y: 900, radius: g.cfg.bosses[type].skill.radius });
      assert.ok(effects.particleCount <= g.cfg.ui.maxParticles);
      renderer.render(); effects.update(.1); effects.render(ctx);
      assert.deepEqual(g.state, before);
      assert.ok(calls.some(([method, text]) => method === 'fillText' && text === g.cfg.bosses[type].name));
      assert.ok(calls.some(([method, text]) => method === 'fillText' && text === '♛ DIỆT BOSS'));
    }
    effects.update(10);
    assert.equal(effects.particleCount, 0);
  } finally { renderer.dispose(); effects.dispose(); g.dispose(); }
});

test('boss attack sprites: real attack timing emits directed frames, renders cached atlas and expires without state mutation', () => {
  const g = game();
  const calls = [];
  const ctx = new Proxy({}, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
  const document = { createElement: () => ({ getContext: () => ctx }) };
  const effects = createEffects({ ...g, document });
  try {
    g.battle();
    const boss = g.state.boss, hero = g.state.players.get('hero');
    Object.assign(hero, { x: boss.x + 30, y: boss.y, targetId: null });
    g.state.time += g.cfg.events.bossAttackIntervalMs / 1000;
    g.combat.update(.01);
    const attacks = g.log.filter(({ type }) => type === 'boss:attack');
    assert.equal(attacks.length, 1);
    assert.equal(attacks[0].payload.bossType, 'fusion');
    assert.equal(attacks[0].payload.targetX, hero.x);
    g.combat.update(.01);
    assert.equal(g.log.filter(({ type }) => type === 'boss:attack').length, 1);
    const before = structuredClone(g.state);
    effects.update(.15); effects.render(ctx);
    assert.ok(calls.some(([method, , sourceX]) => method === 'drawImage' && sourceX > 0), 'attack advances atlas frame');
    assert.deepEqual(g.state, before);
    effects.update(10);
    assert.equal(effects.particleCount, 0);
  } finally { effects.dispose(); g.dispose(); }
});
