import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../client/core/config.js';
import { createState } from '../client/core/gameState.js';
import { createEventBus } from '../client/core/eventBus.js';
import { validateEventPayload } from '../client/core/eventCatalog.js';
import { createInputRouter } from '../client/input/inputRouter.js';
import { createRoundManager } from '../client/systems/roundManager.js';
import { createAllianceSystem } from '../client/systems/allianceSystem.js';
import { createMovementSystem } from '../client/systems/movementSystem.js';
import { createCombatSystem } from '../client/systems/combatSystem.js';
import { createMockAdapter } from '../server/mockAdapter.js';
import { createWsClient } from '../client/net/wsClient.js';
import { createMockActions, mockJoinText } from '../client/net/mockActions.js';
import { parse } from '../client/input/commandParser.js';
import { createGiftEffectSystem } from '../client/systems/giftEffectSystem.js';
import { createPlayer } from '../client/entities/playerFactory.js';

function fakeClock(onTime) {
  const original = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now };
  const timers = new Map();
  let time = 0, id = 0;
  const schedule = (fn, delay, interval = false) => {
    const key = ++id;
    timers.set(key, { fn, at: time + delay, interval: interval ? delay : 0 });
    return key;
  };
  globalThis.setTimeout = (fn, delay) => schedule(fn, delay);
  globalThis.setInterval = (fn, delay) => schedule(fn, delay, true);
  globalThis.clearTimeout = globalThis.clearInterval = (key) => timers.delete(key);
  Date.now = () => time;
  return {
    advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, timer] = next;
        time = timer.at; onTime(time);
        if (timer.interval) timer.at += timer.interval; else timers.delete(key);
        timer.fn();
      }
      time = end; onTime(time);
    },
    get size() { return timers.size; },
    restore() {
      Object.assign(globalThis, { setTimeout: original.setTimeout, clearTimeout: original.clearTimeout,
        setInterval: original.setInterval, clearInterval: original.clearInterval });
      Date.now = original.now;
    },
  };
}

for (const mode of ['server', 'local']) {
  test(`mock ${mode}: real mutual alliance, dodge and delayed betrayal; valid payloads and timer cleanup`, async () => {
    const cfg = structuredClone(config), state = createState(cfg), bus = createEventBus(cfg);
    const clock = fakeClock((time) => { state.time = time / 1000; });
    const systems = [
      createInputRouter({ bus, state, config: cfg }),
      createRoundManager({ bus, state, config: cfg }),
      createAllianceSystem({ bus, state, config: cfg }),
      createMovementSystem({ bus, state, config: cfg }),
      createCombatSystem({ bus, state, config: cfg }),
    ];
    const comments = [], formations = [], betrayals = [], dodges = [], rescues = [];
    bus.on('live:chat', (event) => comments.push(event));
    bus.on('ally:formed', (event) => formations.push({ ...event, at: state.time }));
    bus.on('ally:betrayed', (event) => betrayals.push({ ...event, at: state.time }));
    bus.on('cmd:dodge', (event) => dodges.push(event));
    bus.on('cmd:giftTarget', (event) => rescues.push(event));
    const emit = (type, payload) => {
      assert.deepEqual(validateEventPayload(type, payload), [], type);
      bus.emit(type, payload);
    };
    let source;
    try {
      if (mode === 'server') {
        source = createMockAdapter({ onEvent: emit, intensity: 'high' });
        assert.equal(new Set(source.users.map((user) => user.nickname)).size, source.users.length);
        await source.connect();
      } else {
        source = createWsClient({ bus: { ...bus, emit }, config: cfg, local: true });
        source.connect();
      }
      clock.advance(10000);
      assert.ok(comments.some(({ text }) => text === 'JOIN'));
      for (const [index, classId] of cfg.classOrder.entries()) {
        const choice = comments.find(({ text }) => text === mockJoinText(index + 1, cfg));
        assert.ok(choice, `mock emits a real JOIN comment for ${classId}`);
        assert.equal(state.players.get(choice.userId)?.classId, classId);
      }
      assert.ok(formations.length > 0, 'reciprocal comments form an actual alliance, not just an invitation');
      state.phase = 'BATTLE';
      clock.advance(30000);
      assert.ok(dodges.length > 0);
      assert.ok([...state.players.values()].some((player) => player.intent === 'dodging'));
      assert.ok(betrayals.length > 0, 'betrayal passes game phase and wait requirements');
      assert.ok(rescues.length > 0, 'coordinated rescue comments reach the input router');
      for (const event of betrayals) {
        const formed = formations.find((pair) => [pair.aId, pair.bId].includes(event.betrayerId) && [pair.aId, pair.bId].includes(event.victimId));
        assert.ok(formed && event.at - formed.at >= cfg.alliance.betrayWaitMs / 1000);
      }

      assert.equal(comments.some(({ text }) => /^(đánh|attack|tấn công)$/iu.test(text)), false);
      if (mode === 'server') assert.equal(source.send('live:chat').payload.text, 'NÉ');
      if (mode === 'server') await source.disconnect(); else source.dispose();
      assert.equal(clock.size, 0);
      const count = comments.length;
      clock.advance(60000);
      assert.equal(comments.length, count);
    } finally {
      if (mode === 'server') await source?.disconnect(); else source?.dispose();
      systems.reverse().forEach((system) => system.dispose());
      clock.restore();
    }
  });
}

test('join class: localized names, optional random class, lobby/countdown changes and combat lock', () => {
  const cfg = structuredClone(config), state = createState(cfg), bus = createEventBus(cfg);
  const systems = [createInputRouter({ bus, state, config: cfg }), createRoundManager({ bus, state, config: cfg })];
  const events = [];
  bus.on('cmd:join', (event) => {
    assert.deepEqual(validateEventPayload('cmd:join', event), []);
    events.push(event);
  });
  const chat = (id, text) => {
    state.time += 1;
    bus.emit('live:chat', { userId: id, uniqueId: id, nickname: id, avatarUrl: '', text });
  };
  try {
    assert.deepEqual(parse('JOIN', cfg), { cmd: 'join', arg: '' });
    for (const [id, name] of Object.entries({ swordsman: 'KIẾM SĨ', archer: 'cung thu', mage: 'Pháp sư', tank: 'TANK' })) {
      for (const keyword of ['JOIN', 'tham gia', 'vao']) {
        assert.deepEqual(parse(`  ${keyword} ${name}!!! `, cfg), { cmd: 'join', arg: id });
      }
      assert.deepEqual(parse(`join ${id}`, cfg), { cmd: 'join', arg: id });
      chat(id, `JOIN ${name}`);
      const player = state.players.get(id), base = cfg.classes[id];
      assert.equal(player.classId, id);
      for (const key of ['hp', 'atk', 'def', 'speed', 'range', 'attackInterval']) assert.equal(player[key], base[key]);
    }
    for (const text of ['join ninja', 'join mage please', 'please join tank']) {
      assert.equal(parse(text, cfg), null);
      chat('invalid', text);
      assert.equal(state.players.has('invalid'), false);
    }
    const randoms = cfg.classOrder.map((_, i) => {
      const id = `random-${i}`;
      chat(id, 'JOIN');
      return state.players.get(id);
    });
    assert.deepEqual(new Set(randoms.map((player) => player.classId)), new Set(cfg.classOrder), 'plain JOIN retains random balanced assignment');
    const originalClass = randoms[0].classId;
    chat(randoms[0].id, 'JOIN');
    assert.equal(randoms[0].classId, originalClass, 'duplicate JOIN does not reroll');
    bus.emit('live:join', { userId: 'auto', uniqueId: 'auto', nickname: 'Auto', avatarUrl: '' });
    const auto = state.players.get('auto');
    auto.giftValue = 99;
    const position = { x: auto.x, y: auto.y };
    chat('auto', 'JOIN Tank');
    assert.equal(auto.classId, 'tank', 'auto-joined viewers can select a class');
    assert.equal(auto.giftValue, 99);
    assert.deepEqual({ x: auto.x, y: auto.y }, position);
    state.phase = 'COUNTDOWN';
    chat('auto', 'JOIN Pháp sư');
    assert.equal(auto.classId, 'mage');
    assert.equal(auto.hp, cfg.classes.mage.hp);
    assert.equal(auto.maxHp, cfg.classes.mage.hp);
    assert.equal(auto.mana, 0);
    for (const phase of ['BATTLE', 'FINAL', 'RESULT']) {
      state.phase = phase;
      auto.hp = 42;
      chat('auto', 'JOIN Tank');
      assert.equal(auto.classId, 'mage');
      assert.equal(auto.hp, 42, 'locked class selection cannot heal');
    }
    state.phase = 'BATTLE';
    chat('late', 'JOIN Cung thủ');
    assert.equal(state.players.get('late').status, 'spectator');
    assert.equal(state.players.get('late').classId, 'archer', 'late viewer retains class for the next round');
    assert.ok(events.length > 0);
  } finally { systems.reverse().forEach((system) => system.dispose()); }
});

test('mock rescue: paired gift heals and revives the chosen target once per cycle', () => {
  const cfg = structuredClone(config), state = createState(cfg), bus = createEventBus(cfg);
  state.phase = 'BATTLE';
  const systems = [
    createInputRouter({ bus, state, config: cfg }),
    createGiftEffectSystem({ bus, state, config: cfg }),
    createCombatSystem({ bus, state, config: cfg }),
  ];
  const users = Array.from({ length: 4 }, (_, i) => ({
    userId: `rescue-${i}`, uniqueId: `rescue_${i}`, nickname: `Rescue ${i}`, avatarUrl: '',
  }));
  for (const user of users) {
    const player = createPlayer({ id: user.userId, name: user.nickname }, state, cfg, 'swordsman');
    state.players.set(player.id, player);
  }
  const firstTarget = state.players.get(users[1].userId);
  firstTarget.hp = 100;
  const otherDead = state.players.get(users[0].userId);
  const secondTarget = state.players.get(users[3].userId);
  const events = [], effects = [];
  bus.on('gift:effect', (event) => effects.push(event));
  let time = 0;
  const actions = createMockActions({ config: cfg, getUsers: () => users, now: () => time, emit(type, payload) {
    assert.deepEqual(validateEventPayload(type, payload), [], type);
    events.push({ type, payload });
    bus.emit(type, payload);
  } });
  const advance = (ms) => { time = ms; state.time = ms / 1000; actions.update(); };
  try {
    advance(0);
    advance(19000);
    const heal = cfg.gifts.tiers.find((tier) => tier.tier === 1);
    assert.equal(firstTarget.hp, 100 + heal.healAmount);
    assert.equal(effects[0].toId, firstTarget.id);
    assert.equal(effects[0].fromId, users[0].userId);
    assert.equal(state.giftTargets.has(users[0].userId), false);
    advance(20000);
    assert.equal(effects.length, 1, 'rescue is emitted only once per cycle');
    advance(28000);
    otherDead.status = secondTarget.status = 'dead';
    otherDead.hp = secondTarget.hp = 0;
    advance(47000);
    assert.equal(effects[1].tier, 4);
    assert.equal(effects[1].toId, secondTarget.id);
    assert.equal(secondTarget.status, 'alive');
    assert.equal(secondTarget.hp, secondTarget.maxHp * cfg.gifts.tiers.find((tier) => tier.tier === 4).reviveHpPercent);
    assert.equal(otherDead.status, 'dead', 'revival honors rescue target instead of picking the first dead player');
    for (let i = 0; i < events.length; i++) {
      if (events[i].type !== 'live:gift') continue;
      const previous = events[i - 1];
      assert.equal(previous.type, 'live:chat');
      assert.ok(previous.payload.text.startsWith(`${cfg.commands.rescue[0]} `));
      assert.equal(previous.payload.userId, events[i].payload.userId);
    }
  } finally { systems.reverse().forEach((system) => system.dispose()); }
});
