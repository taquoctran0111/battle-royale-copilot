import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import config from '../client/core/config.js';
import { createEventBus } from '../client/core/eventBus.js';
import { createGameLoop } from '../client/core/gameLoop.js';
import { eventCatalog, validateEventPayload } from '../client/core/eventCatalog.js';
import { createState, getPlayerByName } from '../client/core/gameState.js';
import { normalizeText, createRng, getEffectiveStats } from '../client/core/utils.js';
import { createInputRouter } from '../client/input/inputRouter.js';
import { parse } from '../client/input/commandParser.js';
import { createMockAdapter } from '../server/mockAdapter.js';
import { createTikTokAdapter } from '../server/tiktokAdapter.js';
import { createWsClient, resolveBackendUrl } from '../client/net/wsClient.js';
import { createLeaderboardClient } from '../client/net/leaderboardClient.js';
import { createRoundManager } from '../client/systems/roundManager.js';
import { createBot, createPlayer } from '../client/entities/playerFactory.js';
import { createGiftEffectSystem } from '../client/systems/giftEffectSystem.js';
import { createAllianceSystem } from '../client/systems/allianceSystem.js';
import { createZoneSystem } from '../client/systems/zoneSystem.js';
import { createEventSystem } from '../client/systems/eventSystem.js';
import { createMovementSystem } from '../client/systems/movementSystem.js';
import { createCombatSystem } from '../client/systems/combatSystem.js';
import { createEffects } from '../client/render/effects.js';
import { createRenderer } from '../client/render/renderer.js';
import { createAudio } from '../client/ui/audio.js';
import { createHud } from '../client/ui/hud.js';
import { createLeaderboardStore } from '../server/leaderboardStore.js';

function testConfig() {
  const value = structuredClone(config);
  value.phases.durationSec = { LOBBY: 0.1, COUNTDOWN: 0.05, BATTLE: 0.2, FINAL: 0.1, RESULT: 0.05 };
  value.phases.finalThresholdAlive = 1;
  value.lobby = { minPlayers: 1, botFillTo: 3, maxPlayers: 50 };
  value.zone.initialRadius = 10000;
  value.zone.stages = [];
  value.events.intervalSec = [1000, 1000];
  value.events.trapSpawnSec = [1000, 1000];
  value.events.list = [{ type: 'boss', weight: 1, hp: 50, atk: 1, speed: 1, minAliveToSpawn: 1 }];
  return value;
}

function createGame(overrides = {}) {
  const cfg = { ...testConfig(), ...overrides };
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const input = createInputRouter({ bus, state, config: cfg });
  const systems = [
    createRoundManager({ bus, state, config: cfg }),
    createGiftEffectSystem({ bus, state, config: cfg }),
    createAllianceSystem({ bus, state, config: cfg }),
    createZoneSystem({ bus, state, config: cfg }),
    createEventSystem({ bus, state, config: cfg }),
    createMovementSystem({ bus, state, config: cfg }),
    createCombatSystem({ bus, state, config: cfg }),
  ];
  const mock = createMockAdapter({ onEvent: (type, payload) => bus.emit(type, payload), onStatus: (payload) => bus.emit('live:status', payload), intensity: 'low' });
  return {
    cfg, state, bus, systems, input, mock,
    step(dt) { for (const system of systems) system.update(dt); },
    dispose() { [...systems].reverse().forEach((system) => system.dispose()); input.dispose(); bus.clear(); },
  };
}

function addMockViewer(game, id, nickname) {
  game.mock.send('live:join', { userId: id, uniqueId: id, nickname });
  return game.state.players.get(id);
}

test('main composition: constructor order, canvas/HUD and safe URL dimensions match the contract', () => {
  const source = readFileSync('client/main.js', 'utf8');
  const anchors = ['const config =', 'const state = createState', 'const bus = createEventBus', 'const wsClient = createWsClient', 'const inputRouter = createInputRouter', 'const roundManager = createRoundManager', 'const movementSystem = createMovementSystem', 'const combatSystem = createCombatSystem', 'const zoneSystem = createZoneSystem', 'const eventSystem = createEventSystem', 'const allianceSystem = createAllianceSystem', 'const giftEffectSystem = createGiftEffectSystem', 'const renderer = createRenderer', 'const hud = createHud', 'const audio = createAudio', 'leaderboardClient = createLeaderboardClient'];
  const positions = anchors.map((anchor) => source.indexOf(anchor));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  assert.ok(source.includes('Number.isSafeInteger'));
  assert.ok(source.includes('maxArenaDimension'));
  const html = readFileSync('client/index.html', 'utf8');
  assert.equal((html.match(/<canvas\b/g) ?? []).length, 1);
  assert.equal((html.match(/id="hud"/g) ?? []).length, 1);
  assert.ok(html.includes('.transparent #hud::before { background: transparent; }'));
});

test('main loop: fixed order, 30Hz interpolation, hidden-tab clamp and per-system recovery', () => {
  const cfg = testConfig();
  const order = [];
  const names = ['roundManager', 'giftEffectSystem', 'allianceSystem', 'zoneSystem', 'eventSystem', 'movementSystem', 'combatSystem'];
  const systems = names.map((name) => [name, { update(dt) { assert.equal(dt, 1 / cfg.tickRate); order.push(name); } }]);
  let hidden = false;
  let renders = 0;
  const loop = createGameLoop({ systems, inputRouter: { update() { order.push('inputRouter'); } }, renderer: { render(alpha) { renders += 1; assert.ok(alpha >= 0 && alpha < 1); } }, config: cfg, isHidden: () => hidden });
  loop.advance(0); loop.advance(1000 / 60); loop.advance(1000 / 30);
  assert.deepEqual(order, ['inputRouter', ...names]);
  hidden = true; loop.advance(600000);
  hidden = false; loop.advance(600010);
  assert.equal(order.length, 8);
  loop.advance(601010);
  assert.ok(order.length <= 8 * (1 + cfg.runtime.maxStepsPerFrame));
  assert.equal(renders, 5);
  loop.dispose();
  let failures = 0, good = 0;
  const recovery = createGameLoop({ systems: [['broken', { update() { failures += 1; throw new Error('probe'); } }], ['good', { update() { good += 1; } }]], renderer: { render() {} }, config: cfg, isHidden: () => false, log() {} });
  for (let frame = 0; frame < 10; frame += 1) recovery.advance(frame * 100);
  assert.equal(failures, cfg.runtime.systemErrorLimit);
  assert.ok(good > failures);
  assert.deepEqual(recovery.disabledSystems, ['broken']);
  recovery.dispose();
});

test('main clock: long suspension keeps phase deadline and zone warning ahead without advancing game time', () => {
  const original = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  try {
    const cfg = testConfig();
    cfg.phases.durationSec = { LOBBY: 1, COUNTDOWN: 0.1, BATTLE: 20, FINAL: 10, RESULT: 1 };
    cfg.zone = { ...cfg.zone, initialRadius: 100, stages: [{ atSec: 3, radius: 50, shrinkSec: 1, dps: 4 }] };
    const state = createState(cfg);
    const bus = createEventBus(cfg);
    const round = createRoundManager({ bus, state, config: cfg });
    const zone = createZoneSystem({ bus, state, config: cfg });
    const warnings = [];
    bus.on('zone:update', (event) => warnings.push(event));
    clock += 1000; round.update(1); zone.update(1);
    clock += 100; round.update(0.1); zone.update(0.1);
    assert.equal(state.phase, 'BATTLE');
    const before = state.time;
    clock += 60000;
    round.update(1 / cfg.tickRate); zone.update(1 / cfg.tickRate);
    assert.equal(state.phase, 'BATTLE');
    assert.ok(Math.abs(state.time - before - 1 / cfg.tickRate) < 1e-8);
    assert.ok(state.phaseEndsAt > clock);
    assert.ok(warnings.at(-1).shrinkAtMs > clock);
    assert.equal(state.zone.radius, 100);
    round.dispose(); zone.dispose();
  } finally { Date.now = original; }
});

test('hud: phases, bounded priority popups, event feed, boss and daily leaderboard are read-only', async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.style = { setProperty() {} }; this._text = ''; this.hidden = false; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this._text = ''; }
  }
  const nodes = new Map();
  const listeners = new Map();
  const doc = { createElement: () => new Element(), defaultView: { innerWidth: 390, innerHeight: 844, addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type) { listeners.delete(type); } } };
  const root = new Element(); root.ownerDocument = doc;
  root.querySelector = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const cfg = testConfig();
  const state = createState(cfg);
  state.roundId = 1;
  const first = createPlayer({ id: 'hud-a', name: 'Alpha' }, state, cfg);
  const second = createPlayer({ id: 'hud-b', name: 'Beta' }, state, cfg);
  state.players.set(first.id, first); state.players.set(second.id, second);
  state.phaseEndsAt = 5000;
  const bus = createEventBus(cfg);
  let time = 0;
  const before = structuredClone(state);
  const hud = createHud({ root, bus, state, config: cfg, now: () => time, serverUrl: 'http://localhost:3102', fetchImpl: async (url) => { assert.equal(url, 'http://localhost:3102/api/leaderboard'); return { ok: true, json: async () => [{ playerId: first.id, name: 'Alpha', wins: 1, kills: 4, damage: 500 }] }; } });
  assert.equal(root.dataset.phase, 'LOBBY');
  assert.equal(nodes.get('#command-guide').children.length, 6);
  assert.equal(nodes.get('#gift-guide').children.length, 4);
  for (let index = 0; index < 30; index += 1) bus.emit('gift:effect', { fromId: first.id, toId: first.id, tier: 1, giftName: `Rose ${index}`, diamonds: 1, count: 1 });
  hud.update();
  assert.equal(hud.popupCount, cfg.ui.hud.popupQueueMax);
  assert.ok(nodes.get('#gift-thanks').textContent.includes('Rose 0'));
  bus.emit('gift:effect', { fromId: first.id, toId: first.id, tier: 4, giftName: 'Galaxy', diamonds: 1000, count: 1 });
  assert.equal(hud.popupCount, cfg.ui.hud.popupQueueMax);
  time += cfg.ui.hud.popupDurationMs;
  hud.update();
  assert.ok(nodes.get('#gift-thanks').textContent.includes('Galaxy'));
  assert.deepEqual(state, before);
  state.phase = 'COUNTDOWN'; state.phaseEndsAt = time + 5000;
  bus.emit('round:phase', { phase: state.phase }); hud.update();
  assert.equal(nodes.get('#countdown-number').textContent, '5');
  assert.equal(nodes.get('#countdown-screen').hidden, false);
  state.phase = 'BATTLE'; bus.emit('round:phase', { phase: state.phase });
  for (let index = 0; index < 10; index += 1) bus.emit('player:killed', { victimId: second.id, killerId: first.id });
  bus.emit('ally:betrayed', { betrayerId: first.id, victimId: second.id });
  bus.emit('player:revived', { playerId: second.id });
  bus.emit('bounty:claimed', { victimId: second.id, killerId: first.id });
  bus.emit('bounty:set', { playerId: first.id });
  bus.emit('energy:changed', { value: 65, max: 100 });
  bus.emit('boss:spawned', { id: 'boss', hp: 500, maxHp: 1000 });
  bus.emit('zone:update', { cx: 540, cy: 960, radius: 500, nextRadius: 300, shrinkAtMs: time + 2000 });
  hud.update();
  assert.equal(nodes.get('#kill-feed').children.length, 5);
  assert.equal(nodes.get('#energy-meter').value, 65);
  assert.equal(nodes.get('#boss-meter').value, 500);
  assert.equal(nodes.get('#bounty-banner').hidden, false);
  assert.equal(nodes.get('#zone-warning').hidden, false);
  assert.equal(nodes.get('#countdown-number').textContent, 'CHIẾN!');
  state.phase = 'RESULT'; bus.emit('round:phase', { phase: state.phase });
  bus.emit('round:ended', { roundId: 1, winnerId: first.id, ranking: [{ playerId: first.id, name: first.name, kills: 4, damage: 500, placement: 1 }, { playerId: second.id, name: second.name, kills: 1, damage: 100, placement: 2 }] });
  hud.update();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes.get('#result-screen').hidden, false);
  assert.equal(nodes.get('#champion-name').textContent, first.name);
  assert.equal(nodes.get('#round-ranking').children.length, 2);
  assert.equal(nodes.get('#daily-ranking').children.length, 1);
  bus.emit('round:ended', { roundId: 1, winnerId: null, ranking: [] });
  hud.update();
  assert.equal(nodes.get('#champion-name').textContent, 'Hòa trận');
  assert.equal(nodes.get('#champion-heading').textContent, 'KHÔNG CÓ NHÀ VÔ ĐỊCH');
  state.arena.w = 720; state.arena.h = 1280;
  hud.resize();
  assert.equal(root.style.width, `${cfg.ui.hud.designWidth}px`);
  assert.equal(root.style.height, `${cfg.ui.hud.designHeight}px`);
  hud.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(bus.listenerCount('gift:effect'), 0);
  assert.equal(hud.popupCount, 0);
});

test('leaderboard: three rounds sort every metric, omit bots and survive concurrent writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arena-leaderboard-'));
  const filePath = join(directory, 'data', 'leaderboard.json');
  const first = createLeaderboardStore({ filePath });
  const second = createLeaderboardStore({ filePath });
  const row = (playerId, placement, kills, giftValue) => ({ playerId, name: playerId, avatar: `https://example.test/${playerId}.png`, kills, damage: kills * 20, giftValue, placement });
  try {
    const rounds = [
      { roundId: 1, sessionId: 'metrics', winnerId: 'alice', ranking: [row('alice', 1, 1, 0), row('bob', 2, 5, 10), row('bot_fake', 3, 100, 100000)] },
      { roundId: 2, sessionId: 'metrics', winnerId: 'alice', ranking: [row('bob', 2, 4, 50), row('alice', 1, 2, 5)] },
      { roundId: 3, sessionId: 'metrics', winnerId: 'bob', ranking: [row('alice', 2, 1, 500), row('bob', 1, 2, 0)] },
    ];
    await Promise.all(rounds.map((result, index) => (index % 2 ? second : first).addRoundResult(result)));
    assert.equal((await first.getTop({ metric: 'wins' }))[0].userId, 'alice');
    assert.equal((await first.getTop({ metric: 'kills' }))[0].userId, 'bob');
    assert.equal((await first.getTop({ metric: 'giftValue' }))[0].userId, 'alice');
    const values = await first.getTop({ period: 'all', limit: 10 });
    assert.equal(values.length, 2);
    assert.equal(values.find((player) => player.userId === 'alice').wins, 2);
    assert.equal(values.find((player) => player.userId === 'bob').kills, 11);
    assert.equal(values.find((player) => player.userId === 'alice').giftValue, 505);
    const burst = { sessionId: 'burst', winnerId: 'alice', ranking: [row('alice', 1, 1, 1)] };
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? second : first).addRoundResult({ ...burst, roundId: index + 1 })));
    await Promise.all([first.addRoundResult(rounds[0]), second.addRoundResult(rounds[0])]);
    const reloaded = createLeaderboardStore({ filePath });
    const alice = (await reloaded.getTop({ period: 'all' })).find((player) => player.userId === 'alice');
    assert.equal(alice.rounds, 23);
    assert.equal(alice.avatar, 'https://example.test/alice.png');
    assert.equal(typeof alice.lastSeen, 'string');
    const file = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(file.processedRounds.length, 23);
    assert.equal(Object.hasOwn(file.all, 'bot_fake'), false);
    assert.deepEqual(await readdir(join(directory, 'data')), ['leaderboard.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('leaderboard: invalid inputs and corrupt files fail without overwriting existing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arena-leaderboard-'));
  const filePath = join(directory, 'leaderboard.json');
  const store = createLeaderboardStore({ filePath });
  const row = { playerId: 'valid', name: 'Valid', kills: 1, damage: 10, placement: 1 };
  try {
    await store.addRoundResult([row]);
    const before = await readFile(filePath, 'utf8');
    for (const result of [null, { ranking: [{ ...row, kills: -1 }] }, { ranking: [{ ...row, damage: '10' }] }, { ranking: [{ ...row, avatar: 42 }] }, { winnerId: 'missing', ranking: [row] }, { ranking: [row, row] }]) {
      await assert.rejects(store.addRoundResult(result), (error) => error.status === 400);
    }
    for (const query of [{ period: 'month' }, { metric: 'hp' }, { limit: 0 }, { limit: '1.5' }, { limit: ['5'] }]) await assert.rejects(store.getTop(query), (error) => error.status === 400);
    assert.equal(await readFile(filePath, 'utf8'), before);
    await writeFile(filePath, '{broken', 'utf8');
    await assert.rejects(store.addRoundResult([row]));
    assert.equal(await readFile(filePath, 'utf8'), '{broken');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('leaderboard API: HTTP metrics, bot filtering, validation and body size limit', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arena-api-'));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const filePath = join(directory, 'leaderboard.json');
  const child = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, USE_MOCK: 'true', PORT: String(port), LEADERBOARD_FILE: filePath }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited: ${code}`)));
      child.stdout.on('data', (data) => { if (data.toString().includes('[server] http://')) resolve(); });
    });
    const origin = `http://127.0.0.1:${port}`;
    const post = (data) => fetch(`${origin}/api/leaderboard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const ranking = [
      { playerId: 'api-user', name: 'API User', avatar: 'https://example.test/avatar.png', kills: 3, damage: 150, giftValue: 500, placement: 1 },
      { playerId: 'bot_api', name: 'Bot', kills: 100, damage: 10000, giftValue: 99999, placement: 2 },
    ];
    for (let roundId = 1; roundId <= 3; roundId += 1) assert.equal((await post({ roundId, sessionId: 'http-test', winnerId: 'api-user', ranking })).status, 200);
    const response = await fetch(`${origin}/api/leaderboard?period=week&metric=giftValue&limit=1`);
    assert.equal(response.status, 200);
    const top = await response.json();
    assert.equal(top.length, 1);
    assert.equal(top[0].userId, 'api-user');
    assert.equal(top[0].wins, 3);
    assert.equal(top[0].giftValue, 1500);
    assert.equal((await fetch(`${origin}/api/leaderboard?period=wrong`)).status, 400);
    assert.equal((await post({ roundId: 4, winnerId: 'api-user', ranking: [{ ...ranking[0], kills: -1 }] })).status, 400);
    assert.equal((await post([])).status, 400);
    assert.equal((await post({ padding: 'x'.repeat(110000) })).status, 413);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).all['api-user'].rounds, 3);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test('leaderboard client: POST enriches a snapshot and fetchTop builds queries without mutating game state', async () => {
  const cfg = testConfig();
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const player = createPlayer({ id: 'score-user', name: 'Score', avatar: 'https://example.test/avatar.png' }, state, cfg);
  player.giftValue = 250;
  state.players.set(player.id, player);
  const before = structuredClone(state);
  const requests = [];
  const client = createLeaderboardClient({ bus, state, config: cfg, serverUrl: 'http://localhost:3102', fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => [{ userId: player.id, name: player.name, wins: 1 }] }; } });
  const result = { roundId: 1, winnerId: player.id, ranking: [{ playerId: player.id, name: player.name, kills: 2, damage: 80, placement: 1 }] };
  bus.emit('round:ended', result);
  await new Promise((resolve) => setImmediate(resolve));
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.ranking[0].giftValue, 250);
  assert.equal(body.ranking[0].avatar, player.avatar);
  assert.equal(typeof body.sessionId, 'string');
  assert.equal(result.ranking[0].giftValue, undefined);
  const top = await client.fetchTop({ period: 'week', metric: 'giftValue', limit: 3 });
  assert.equal(top[0].userId, player.id);
  assert.equal(requests[1].url, 'http://localhost:3102/api/leaderboard?period=week&metric=giftValue&limit=3');
  assert.deepEqual(state, before);
  client.dispose();
  assert.equal(bus.listenerCount('round:ended'), 0);
});

test('leaderboard client: network failures are isolated and dispose aborts pending requests', async () => {
  const cfg = testConfig();
  const bus = createEventBus(cfg);
  const warnings = console.warn;
  console.warn = () => {};
  try {
    const offline = createLeaderboardClient({ bus, config: cfg, fetchImpl: async () => { throw new Error('offline'); } });
    bus.emit('round:ended', { roundId: 1, winnerId: null, ranking: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await offline.fetchTop(), []);
    offline.dispose();
    let signal;
    const pending = createLeaderboardClient({ bus, config: cfg, fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { ok: true, json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
    } });
    const request = pending.fetchTop();
    await new Promise((resolve) => setImmediate(resolve));
    pending.dispose();
    assert.equal(signal.aborted, true);
    assert.deepEqual(await request, []);
    assert.equal(bus.listenerCount('round:ended'), 0);
  } finally { console.warn = warnings; }
});

test('leaderboard: day and week roll over while all-time and idempotency survive reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arena-leaderboard-'));
  let time = Date.UTC(2026, 9, 14, 12);
  const filePath = join(directory, 'leaderboard.json');
  const store = createLeaderboardStore({ filePath, now: () => time });
  try {
    const entry = { sessionId: 'day-test', roundId: 1, winnerId: 'day-player', ranking: [{ playerId: 'day-player', name: 'Daily Player', kills: 3, damage: 200, placement: 1 }] };
    await store.addRoundResult(entry);
    assert.equal((await store.getTop())[0].userId, 'day-player');
    time += 24 * 60 * 60 * 1000;
    assert.deepEqual(await store.getTop(), []);
    assert.equal((await store.getTop({ period: 'week' }))[0].rounds, 1);
    const reloaded = createLeaderboardStore({ filePath, now: () => time });
    assert.equal((await reloaded.addRoundResult(entry)).duplicate, true);
    time = Date.UTC(2026, 9, 19, 12);
    assert.deepEqual(await reloaded.getTop({ period: 'week' }), []);
    assert.equal((await reloaded.getTop({ period: 'all' }))[0].rounds, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('audio: blocked autoplay is safe and voice count stays bounded under event spam', async () => {
  const OriginalContext = globalThis.AudioContext;
  const originalWarn = console.warn;
  const created = [];
  let instance;
  class Context {
    constructor() { instance = this; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { const oscillator = { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} }; created.push(oscillator); return oscillator; }
    async resume() { throw new Error('autoplay blocked'); }
    async close() { this.state = 'closed'; }
  }
  globalThis.AudioContext = Context;
  console.warn = () => {};
  try {
    const cfg = testConfig();
    const bus = createEventBus(cfg);
    let time = 0;
    const audio = createAudio({ bus, config: cfg, enabled: true, now: () => time });
    await new Promise((resolve) => setImmediate(resolve));
    bus.emit('gift:effect', {});
    assert.equal(created.length, 0);
    assert.equal(audio.status, 'suspended');
    instance.state = 'running';
    for (let index = 0; index < 100; index += 1) { time += cfg.audio.eventMinIntervalMs; bus.emit('gift:effect', {}); }
    assert.equal(created.length, cfg.audio.maxVoices);
    audio.dispose();
    assert.equal(instance.state, 'closed');
  } finally { console.warn = originalWarn; if (OriginalContext === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = OriginalContext; }
});

test('audio: autoplay unlock, event tones, countdown, mute/volume and disposal', async () => {
  const previous = globalThis.AudioContext;
  const oscillators = [];
  const listeners = new Map();
  let closed = false;
  let resumed = 0;
  const fakeTarget = { addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type) { listeners.delete(type); } };
  const parameter = () => ({ value: 0, setValueAtTime(value) { this.value = value; }, exponentialRampToValueAtTime() {} });
  class FakeAudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; }
    createOscillator() { const oscillator = { frequency: parameter(), connect() {}, disconnect() {}, start() {}, stop() { this.onended?.(); } }; oscillators.push(oscillator); return oscillator; }
    async resume() { resumed += 1; this.state = 'running'; }
    async close() { closed = true; this.state = 'closed'; }
  }
  globalThis.AudioContext = FakeAudioContext;
  try {
    const cfg = testConfig();
    const bus = createEventBus(cfg);
    let time = 1000;
    const button = { ...fakeTarget, ownerDocument: fakeTarget, dataset: {}, setAttribute() {} };
    const slider = { ...fakeTarget, value: '' };
    const audio = createAudio({ bus, button, volumeInput: slider, config: cfg, enabled: true, now: () => time });
    await Promise.resolve();
    assert.equal(resumed, 1);
    for (const [type, payload] of [['player:damaged', { amount: 12 }], ['player:killed', {}], ['gift:effect', {}], ['boss:spawned', {}], ['ultimate:fire', {}], ['round:ended', { winnerId: 'winner' }]]) {
      time += 100;
      const before = oscillators.length;
      bus.emit(type, payload);
      assert.ok(oscillators.length > before, type);
    }
    bus.emit('round:phase', { phase: 'COUNTDOWN', endsAt: time + 5000 });
    audio.update();
    const first = oscillators.length;
    audio.update();
    assert.equal(oscillators.length, first);
    time += 1000;
    audio.update();
    assert.equal(oscillators.length, first + 1);
    audio.setMuted(true);
    const muted = oscillators.length;
    time += 100;
    bus.emit('gift:effect', {});
    assert.equal(oscillators.length, muted);
    audio.setVolume(2);
    assert.equal(audio.volume, 1);
    audio.setMuted(false);
    await Promise.resolve();
    time += 100;
    bus.emit('round:phase', { phase: 'BATTLE' });
    assert.ok(oscillators.length > muted);
    audio.dispose();
    assert.equal(closed, true);
    assert.equal(bus.listenerCount('gift:effect'), 0);
    assert.equal(listeners.size, 0);
  } finally { if (previous === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = previous; }
});

test('renderer: 40 players, avatar fallback, interpolation, resize and hooks leave state unchanged', () => {
  const cfg = testConfig();
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const calls = [];
  const context = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, { get(target, key) { return key in target ? target[key] : (...args) => { calls.push([key, ...args]); }; } });
  const canvas = { getContext: () => context, ownerDocument: { createElement: () => ({ getContext: () => context }) } };
  for (let index = 0; index < 40; index += 1) {
    const player = createPlayer({ id: `render-${index}`, name: `Viewer ${index}`, avatar: 'http://invalid/avatar.png' }, state, cfg);
    Object.assign(player, { prevX: 100 + index, prevY: 200, x: 120 + index, y: 220 });
    if (index === 0) { player.shield = 20; state.bountyId = player.id; player.buffs.push({ type: 'rage', value: 1.5, until: 10000 }); }
    if (index === 39) player.status = 'dead';
    state.players.set(player.id, player);
    Object.freeze(player.cooldowns); Object.freeze(player);
  }
  const before = structuredClone(state);
  const renderer = createRenderer({ canvas, bus, state, config: cfg });
  let frames = 0;
  const unsubscribe = renderer.onFrame(({ alpha, width, height }) => { frames += 1; assert.equal(alpha, 0.5); assert.equal(width, cfg.arena.w); assert.equal(height, cfg.arena.h); });
  renderer.render(0.5);
  assert.equal(frames, 1);
  assert.ok(calls.some(([method, x, y, radius]) => method === 'arc' && x === 110 && y === 210 && radius === cfg.ui.playerRadius));
  assert.ok(calls.some(([method, text]) => method === 'fillText' && text === 'V'));
  assert.equal(renderer.avatarStats.failed, 1);
  unsubscribe();
  renderer.update(cfg.ui.deathVisibleMs / 1000);
  renderer.resize();
  renderer.render(1);
  assert.equal(frames, 1);
  assert.deepEqual(state, before);
  renderer.dispose();
  assert.equal(bus.listenerCount('boss:spawned'), 0);
  renderer.render();
  assert.equal(renderer.avatarStats.cached, 0);
});

test('renderer: FINAL zoom and event shake are local, death markers expire and revive resets them', () => {
  const cfg = testConfig();
  cfg.ui.cameraSmoothing = 1;
  const state = createState(cfg);
  state.phase = 'FINAL';
  state.zone.radius = 120;
  const bus = createEventBus(cfg);
  const calls = [];
  const context = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, { get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]); } });
  const canvas = { getContext: () => context, ownerDocument: { createElement: () => ({ getContext: () => context }) } };
  const player = createPlayer({ id: 'grave-test' }, state, cfg);
  player.status = 'dead';
  state.players.set(player.id, player);
  const before = structuredClone(state);
  const renderer = createRenderer({ canvas, bus, state, config: cfg });
  renderer.render(0.5);
  assert.equal(renderer.camera.zoom, cfg.ui.finalZoomMax);
  assert.ok(calls.some(([method, text]) => method === 'fillText' && text === '+'));
  calls.length = 0;
  renderer.update(cfg.ui.deathVisibleMs / 1000);
  renderer.render(0.5);
  assert.equal(calls.some(([method, text]) => method === 'fillText' && text === '+'), false);
  bus.emit('player:revived', { playerId: player.id });
  bus.emit('player:killed', { victimId: player.id });
  bus.emit('boss:spawned', { id: 'boss' });
  renderer.render(0.5);
  assert.ok(calls.some(([method, text]) => method === 'fillText' && text === '+'));
  const transform = calls.filter(([method, zoom]) => method === 'setTransform' && zoom === cfg.ui.finalZoomMax).at(-1);
  assert.ok(transform[5] !== canvas.width / 2 - state.arena.cx * cfg.ui.finalZoomMax || transform[6] !== canvas.height / 2 - state.arena.cy * cfg.ui.finalZoomMax);
  assert.deepEqual(state, before);
  renderer.dispose();
});

test('effects: every sample event produces bounded effects without mutating GameState', () => {
  const cfg = testConfig();
  const state = createState(cfg);
  state.phase = 'BATTLE';
  const first = createPlayer({ id: 'fx-a', name: 'Alpha' }, state, cfg);
  const second = createPlayer({ id: 'fx-b', name: 'Beta' }, state, cfg);
  state.players.set(first.id, first);
  state.players.set(second.id, second);
  state.boss = { id: 'fx-boss', x: 400, y: 500, hp: 100, maxHp: 100, atk: 20, speed: 10 };
  const before = structuredClone(state);
  const bus = createEventBus(cfg);
  const effects = createEffects({ bus, state, config: cfg });
  const samples = [
    ['player:damaged', { targetId: first.id, amount: 12, crit: false }],
    ['player:damaged', { targetId: first.id, amount: 30, crit: true }],
    ['player:killed', { victimId: second.id, killerId: first.id }],
    ['player:revived', { playerId: second.id }],
    ['buff:apply', { playerId: first.id, type: 'rage', durationMs: 1000 }],
    ['drop:spawned', { id: 'drop', x: 300, y: 400, tier: 3 }],
    ['trap:triggered', { x: 300, y: 400, victims: [first.id] }],
    ['boss:spawned', { id: 'fx-boss', hp: 100, maxHp: 100 }],
    ['boss:defeated', { topDamagers: [{ playerId: first.id, damage: 100 }] }],
    ['ultimate:fire', { byId: first.id }],
    ['ally:formed', { aId: first.id, bId: second.id }],
    ['ally:betrayed', { betrayerId: first.id, victimId: second.id }],
    ['bounty:set', { playerId: first.id }],
  ];
  for (const [type, payload] of samples) {
    bus.emit(type, payload);
    assert.ok(effects.particleCount > 0, type);
    effects.update(10);
    assert.equal(effects.particleCount, 0);
  }
  for (let index = 0; index < 100; index += 1) bus.emit('ultimate:fire', { byId: first.id });
  assert.equal(effects.particleCount, cfg.ui.maxParticles);
  assert.deepEqual(state, before);
  effects.dispose();
  for (const [type] of samples) assert.equal(bus.listenerCount(type), 0);
});

test('gift effects: lobby accounting, capped count heals, weapons, bounty shield and nearby supplies', () => {
  const game = createGame();
  game.mock.send('live:gift', { userId: 'gift-sender', nickname: 'Gift Sender', diamonds: 50, count: 1, giftName: 'Corgi' });
  const sender = game.state.players.get('gift-sender');
  assert.equal(sender.giftValue, 50);
  assert.equal(sender.shield, 0);
  assert.equal(sender.weaponLevel, 0);
  assert.equal(sender.buffs.length, 0);
  const receiver = addMockViewer(game, 'gift-receiver', 'Gift Receiver');
  game.state.phase = 'BATTLE';
  const heals = [];
  game.bus.on('heal:request', (event) => heals.push(event));
  game.bus.emit('damage:request', { targetId: receiver.id, amount: receiver.hp - 10, cause: 'zone' });
  const send = (tier, diamonds, count = 1, toId = receiver.id) => game.bus.emit('gift:effect', { fromId: sender.id, toId, tier, diamonds, count, giftName: 'TestGift' });
  send(1, 9, 9);
  assert.equal(sender.giftValue, 59);
  assert.equal(receiver.giftValue, 0);
  assert.equal(heals[0].amount, game.cfg.gifts.tiers[0].healAmount * game.cfg.gifts.maxHealCount);
  assert.equal(receiver.hp, Math.min(receiver.maxHp, 10 + heals[0].amount));
  assert.ok(receiver.buffs.some((buff) => buff.type === 'speed'));
  send(2, 50);
  assert.equal(receiver.shield, 40);
  assert.equal(receiver.weaponLevel, 1);
  for (let index = 0; index < 10; index += 1) send(2, 50);
  assert.equal(receiver.shield, game.cfg.gifts.buffCaps.shield);
  assert.equal(receiver.weaponLevel, game.cfg.combat.maxWeaponLevel);
  game.state.bountyId = sender.id;
  send(2, 50, 1, sender.id);
  assert.equal(sender.shield, 0);
  assert.equal(sender.weaponLevel, 1);
  game.cfg.gifts.blockBountyGiftShield = false;
  send(2, 50, 1, sender.id);
  assert.equal(sender.shield, 40);
  send(3, 250);
  assert.equal(game.state.drops.length, game.cfg.gifts.tiers[2].supplyDrops);
  for (const drop of game.state.drops) {
    assert.equal(drop.tier, 3);
    assert.ok(Math.hypot(drop.x - receiver.x, drop.y - receiver.y) <= game.cfg.gifts.supplyScatterRadius + 1e-8);
  }
  game.dispose();
});

test('gift effects: shield layers expire independently after damage and all stat buffs are capped', () => {
  const game = createGame();
  const player = addMockViewer(game, 'buff-player', 'Buff Player');
  game.state.phase = 'BATTLE';
  const apply = (type, value, durationMs) => game.bus.emit('buff:apply', { playerId: player.id, type, value, durationMs });
  apply('shield', 40, 1000);
  game.state.time = 0.5;
  apply('shield', 40, 3000);
  game.bus.emit('damage:request', { targetId: player.id, amount: 30, cause: 'zone' });
  assert.equal(player.shield, 50);
  game.state.time = 1;
  game.systems[1].update(0.5);
  assert.equal(player.shield, 40);
  assert.equal(player.hp, player.maxHp);
  for (let index = 0; index < 20; index += 1) {
    apply('speed', 1000, 2000);
    apply('rage', 1000, 2000);
    apply('weapon', 1000, 2000);
  }
  for (const type of ['speed', 'rage', 'weapon']) assert.equal(player.buffs.filter((buff) => buff.type === type).length, game.cfg.gifts.buffCaps.perType);
  const stats = getEffectiveStats(player, game.cfg, 1000, { attackBoost: true, dodging: true });
  assert.equal(stats.atk, player.atk * (1 + game.cfg.gifts.buffCaps.attackBonus));
  assert.equal(stats.speed, player.speed * game.cfg.gifts.buffCaps.speedMult);
  assert.equal(player.atk, game.cfg.classes[player.classId].atk);
  const count = player.buffs.length;
  apply('rage', Infinity, 1000);
  apply('speed', 2, Infinity);
  apply('shield', -1, 1000);
  game.bus.emit('buff:apply', null);
  assert.equal(player.buffs.length, count);
  game.state.time = 2.999;
  game.systems[1].update(1.999);
  assert.ok(player.buffs.some((buff) => buff.type === 'speed'));
  game.state.time = 3;
  game.systems[1].update(0.001);
  assert.equal(player.buffs.filter((buff) => buff.type !== 'shield').length, 0);
  assert.equal(getEffectiveStats(player, game.cfg, 3000).speed, player.speed);
  game.state.time = 3.5;
  game.systems[1].update(0.5);
  assert.equal(player.shield, 0);
  assert.equal(player.buffs.length, 0);
  game.dispose();
});

test('gift effects: one revive per person, per-round limit, ultimate fallback and reset', () => {
  const game = createGame();
  const sender = addMockViewer(game, 'revive-sender', 'Revive Sender');
  const victims = ['revive-a', 'revive-b', 'revive-c'].map((id) => addMockViewer(game, id, id));
  game.state.phase = 'BATTLE';
  for (const victim of victims) game.bus.emit('damage:request', { targetId: victim.id, amount: 10000, cause: 'zone' });
  let ultimates = 0;
  let revived = 0;
  game.bus.on('ultimate:fire', () => { ultimates += 1; });
  game.bus.on('player:revived', () => { revived += 1; });
  const send = (toId) => game.bus.emit('gift:effect', { fromId: sender.id, toId, tier: 4, diamonds: 500, count: 1, giftName: 'Galaxy' });
  send(victims[0].id);
  assert.equal(victims[0].status, 'alive');
  assert.equal(revived, 1);
  game.state.time += game.cfg.combat.reviveInvulnMs / 1000;
  game.bus.emit('damage:request', { targetId: victims[0].id, amount: 10000, cause: 'zone' });
  send(victims[0].id);
  assert.equal(victims[0].status, 'dead');
  assert.equal(ultimates, 1);
  send(victims[1].id);
  assert.equal(victims[1].status, 'alive');
  assert.equal(revived, 2);
  send(victims[2].id);
  assert.equal(victims[2].status, 'dead');
  assert.equal(ultimates, 2);
  assert.equal(revived, game.cfg.gifts.maxRevivesPerRound);
  game.state.phase = 'LOBBY';
  game.bus.emit('round:phase', { phase: 'LOBBY' });
  game.state.phase = 'BATTLE';
  send(victims[0].id);
  assert.equal(victims[0].status, 'alive');
  assert.equal(revived, 3);
  game.dispose();
});

test('gift effects: ignored recipients, no-death ultimate and non-battle phase gates', () => {
  const game = createGame();
  const sender = addMockViewer(game, 'ignore-sender', 'Ignore Sender');
  addMockViewer(game, 'ignore-enemy', 'Ignore Enemy');
  game.state.phase = 'BATTLE';
  const spectator = addMockViewer(game, 'ignore-spectator', 'Ignore Spectator');
  assert.equal(spectator.status, 'spectator');
  const ignored = [];
  let ultimates = 0;
  game.bus.on('gift:ignored', (event) => ignored.push(event));
  game.bus.on('ultimate:fire', () => { ultimates += 1; });
  const send = (tier, toId, diamonds) => game.bus.emit('gift:effect', { fromId: sender.id, toId, tier, diamonds, count: 1, giftName: 'TestGift' });
  send(1, spectator.id, 1);
  send(2, 'missing-player', 50);
  send(3, spectator.id, 100);
  assert.deepEqual(ignored.map((event) => event.reason), ['spectator', 'missing_player', 'spectator']);
  assert.ok(ignored.every((event) => Number.isInteger(event.tier)));
  assert.equal(game.state.drops.length, 0);
  assert.equal(spectator.buffs.length, 0);
  assert.equal(sender.giftValue, 151);
  send(4, sender.id, 500);
  assert.equal(ultimates, 1, 'no dead players activates ultimate');
  send(4, spectator.id, 500);
  assert.equal(ultimates, 2);
  send(4, 'missing-player', 500);
  assert.equal(ultimates, 3);
  for (const phase of ['LOBBY', 'COUNTDOWN', 'RESULT']) {
    game.state.phase = phase;
    const before = sender.giftValue;
    send(4, sender.id, 500);
    assert.equal(sender.giftValue, before + 500);
    assert.equal(ultimates, 3);
    assert.equal(ignored.at(-1).reason, 'inactive_phase');
  }
  game.dispose();
});

test('gift effects: all drop rewards, duplicate collection protection and disposal', () => {
  const game = createGame();
  const player = addMockViewer(game, 'drop-rewards', 'Drop Rewards');
  game.state.phase = 'BATTLE';
  const collect = (reward) => game.bus.emit('drop:collected', { id: `reward-${reward}`, playerId: player.id, reward });
  collect('weapon');
  collect('weapon');
  assert.equal(player.weaponLevel, 1);
  collect('shield');
  assert.equal(player.shield, 40);
  collect('rage');
  assert.ok(player.buffs.some((buff) => buff.type === 'rage'));
  game.bus.emit('damage:request', { targetId: player.id, amount: 10000, cause: 'zone' });
  game.bus.emit('revive:request', { playerId: player.id, byId: player.id });
  const before = player.hp;
  collect('heal');
  assert.equal(player.hp, Math.min(player.maxHp, before + Math.ceil(player.maxHp * game.cfg.gifts.dropHealPercent)));
  const after = player.hp;
  collect('heal');
  assert.equal(player.hp, after);
  game.systems[1].dispose();
  assert.equal(game.bus.listenerCount('gift:effect'), 0);
  assert.equal(game.bus.listenerCount('buff:apply'), 0);
  const shield = player.shield;
  game.state.time += 100;
  game.systems[1].update(100);
  assert.equal(player.shield, shield);
  game.dispose();
});

test('alliance: mutual consent, normalized names, invalid pairs, phase gates and invitation expiry', () => {
  const game = createGame();
  const first = addMockViewer(game, 'consent-a', 'Ngọc Lan');
  const second = addMockViewer(game, 'consent-b', 'Đức Huy');
  const third = addMockViewer(game, 'consent-c', 'Mai');
  const formed = [];
  const buffs = [];
  game.bus.on('ally:formed', (event) => formed.push(event));
  game.bus.on('buff:apply', (event) => buffs.push(event));
  const invite = (player, targetName) => game.bus.emit('cmd:ally', { playerId: player.id, targetName });
  game.bus.emit('cmd:ally', null);
  invite(first, first.name);
  invite(first, 'missing');
  assert.equal(first.cooldowns.ally, 0);
  invite(first, 'DUC HUY');
  assert.equal(first.allianceId, null);
  assert.equal(second.allianceId, null);
  const cooldown = first.cooldowns.ally;
  invite(first, third.name);
  assert.equal(first.cooldowns.ally, cooldown);
  invite(second, 'ngoc lan');
  assert.equal(formed.length, 1);
  assert.equal(first.allianceId, second.id);
  assert.equal(second.allianceId, first.id);
  assert.equal(game.state.alliances.size, 1);
  assert.equal(buffs.length, 2);
  assert.ok(buffs.every((buff) => buff.type === game.cfg.alliance.formationBuff.type && buff.durationMs === game.cfg.alliance.formationBuff.durationMs));
  invite(third, first.name);
  assert.equal(third.allianceId, null);
  assert.equal(third.cooldowns.ally, 0);
  game.state.phase = 'RESULT';
  game.bus.emit('round:phase', { phase: 'RESULT' });
  assert.equal(game.state.alliances.size, 0);
  game.state.time = game.cfg.alliance.inviteTtlMs / 1000;
  for (const phase of ['RESULT', 'FINAL']) {
    game.state.phase = phase;
    invite(first, second.name);
    invite(second, first.name);
    assert.equal(game.state.alliances.size, 0);
  }
  game.state.phase = 'COUNTDOWN';
  invite(first, second.name);
  game.state.time += game.cfg.alliance.inviteTtlMs / 1000;
  invite(second, first.name);
  assert.equal(game.state.alliances.size, 0, 'invitation expires exactly at the TTL boundary');
  invite(first, second.name);
  assert.equal(game.state.alliances.size, 1);
  assert.equal(formed.length, 2);
  game.dispose();
});

test('alliance: bot consent probability and reciprocal consent to bot proposals', () => {
  const game = createGame();
  game.cfg.alliance.botAcceptChance = 0;
  game.cfg.alliance.botProposeChance = 1;
  game.cfg.alliance.botProposeIntervalSec = [1, 1];
  const human = addMockViewer(game, 'human-consent', 'Human Consent');
  const bot = addMockViewer(game, 'bot_consent', 'Bot Consent');
  assert.equal(bot.isBot, true);
  game.bus.emit('cmd:ally', { playerId: human.id, targetName: bot.name });
  assert.equal(human.allianceId, null);
  game.cfg.alliance.botAcceptChance = 1;
  game.state.time = game.cfg.combat.cooldownMs.ally / 1000;
  game.bus.emit('cmd:ally', { playerId: human.id, targetName: bot.name });
  assert.equal(human.allianceId, bot.id);
  game.state.phase = 'RESULT';
  game.bus.emit('round:phase', { phase: 'RESULT' });
  game.state.time += game.cfg.combat.cooldownMs.ally / 1000;
  game.state.phase = 'LOBBY';
  game.bus.emit('round:phase', { phase: 'LOBBY' });
  const proposals = [];
  game.bus.on('cmd:ally', (event) => proposals.push(event));
  game.state.time += 1;
  game.systems[2].update(1);
  assert.deepEqual(proposals, [{ playerId: bot.id, targetName: human.name }]);
  assert.equal(bot.allianceId, null, 'a bot proposal still requires human consent');
  game.bus.emit('cmd:ally', { playerId: human.id, targetName: bot.name });
  assert.equal(bot.allianceId, human.id);
  game.dispose();
});

test('alliance: early betrayal denied and lethal betrayal breaks once after damage', () => {
  const game = createGame();
  const first = addMockViewer(game, 'betray-a', 'Betray A');
  const second = addMockViewer(game, 'betray-b', 'Betray B');
  game.bus.emit('cmd:ally', { playerId: first.id, targetName: second.name });
  game.bus.emit('cmd:ally', { playerId: second.id, targetName: first.name });
  game.state.phase = 'BATTLE';
  const order = [];
  const broken = [];
  game.bus.on('ally:betrayed', () => order.push('betrayed'));
  game.bus.on('damage:request', (event) => { if (event.cause === 'betray') { order.push('damage'); assert.equal(first.allianceId, second.id); } });
  game.bus.on('ally:broken', (event) => { order.push('broken'); broken.push(event); });
  const alliance = [...game.state.alliances.values()][0];
  game.state.time = (alliance.formedAt + game.cfg.alliance.betrayWaitMs - 1) / 1000;
  game.bus.emit('cmd:betray', { playerId: first.id });
  assert.equal(first.allianceId, second.id);
  assert.equal(first.cooldowns.betray, 0);
  assert.deepEqual(order, []);
  second.shield = 0;
  game.bus.emit('damage:request', { targetId: second.id, amount: second.hp - 1, sourceId: null, cause: 'zone' });
  game.state.time = (alliance.formedAt + game.cfg.alliance.betrayWaitMs) / 1000;
  game.bus.emit('cmd:betray', { playerId: first.id });
  assert.equal(second.status, 'dead');
  assert.deepEqual(order, ['betrayed', 'damage', 'broken']);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].reason, 'betray');
  assert.equal(first.allianceId, null);
  assert.equal(second.allianceId, null);
  game.bus.emit('cmd:betray', { playerId: first.id });
  assert.equal(broken.length, 1);
  game.dispose();
});

test('alliance: death, final two-player duel, round cleanup and disposed updates', () => {
  const game = createGame();
  const first = addMockViewer(game, 'break-a', 'Break A');
  const second = addMockViewer(game, 'break-b', 'Break B');
  const third = addMockViewer(game, 'break-c', 'Break C');
  const form = () => {
    game.bus.emit('cmd:ally', { playerId: first.id, targetName: second.name });
    game.bus.emit('cmd:ally', { playerId: second.id, targetName: first.name });
  };
  const broken = [];
  game.bus.on('ally:broken', (event) => broken.push(event));
  form();
  game.state.phase = 'FINAL';
  game.systems[2].update(1 / game.cfg.tickRate);
  assert.equal(game.state.alliances.size, 1, 'three alive do not force a duel');
  game.bus.emit('damage:request', { targetId: third.id, amount: 10000, sourceId: null, cause: 'zone' });
  game.systems[2].update(1 / game.cfg.tickRate);
  assert.equal(game.state.alliances.size, 0);
  assert.equal(broken.at(-1).reason, game.cfg.alliance.finalBreakReason);
  game.state.phase = 'BATTLE';
  game.state.time = game.cfg.combat.cooldownMs.ally / 1000;
  form();
  game.bus.emit('damage:request', { targetId: second.id, amount: 10000, sourceId: null, cause: 'zone' });
  assert.equal(broken.at(-1).reason, 'death');
  assert.equal(first.allianceId, null);
  game.bus.emit('cmd:ally', { playerId: first.id, targetName: second.name });
  assert.equal(first.allianceId, null);
  game.bus.emit('revive:request', { playerId: second.id, byId: first.id });
  game.state.time += game.cfg.combat.cooldownMs.ally / 1000;
  form();
  assert.equal(game.state.alliances.size, 1);
  game.state.phase = 'RESULT';
  game.bus.emit('round:phase', { phase: 'RESULT' });
  assert.equal(broken.at(-1).reason, 'roundEnd');
  assert.equal(first.allianceId, null);
  game.dispose();
  assert.equal(game.bus.listenerCount('cmd:ally'), 0);
  assert.equal(game.bus.listenerCount('player:killed'), 0);
  game.systems[2].update(1);
});

test('alliance: highest-streak bounty wins, ties retain holder and duplicate deaths are ignored', () => {
  const game = createGame();
  const first = addMockViewer(game, 'bounty-first', 'Bounty First');
  const second = addMockViewer(game, 'bounty-second', 'Bounty Second');
  let sequence = 0;
  const kill = (source) => {
    const victim = addMockViewer(game, `bounty-victim-${++sequence}`, `Victim ${sequence}`);
    game.bus.emit('damage:request', { targetId: victim.id, amount: 10000, sourceId: source.id, cause: 'attack' });
    return victim;
  };
  const updates = [];
  game.bus.on('streak:updated', (event) => updates.push(event));
  kill(first); kill(first);
  assert.equal(game.state.bountyId, null);
  const victim = kill(first);
  assert.equal(game.state.bountyId, first.id);
  game.bus.emit('player:killed', { victimId: victim.id, killerId: first.id, cause: 'attack' });
  assert.equal(first.streak, 3);
  kill(second); kill(second); kill(second);
  assert.equal(game.state.bountyId, first.id);
  kill(second);
  assert.equal(game.state.bountyId, second.id);
  kill(first);
  assert.equal(game.state.bountyId, second.id);
  kill(first);
  assert.equal(game.state.bountyId, first.id);
  assert.equal(first.streak, 5);
  assert.equal(second.streak, 4);
  assert.ok(updates.some((event) => event.playerId === victim.id && event.streak === 0));
  game.bus.emit('round:phase', { phase: 'LOBBY' });
  assert.equal(game.state.bountyId, null);
  assert.ok([...game.state.players.values()].every((player) => player.streak === 0));
  game.dispose();
});

test('alliance: claiming bounty heals and buffs once; revived victims can die again', () => {
  const game = createGame();
  const holder = addMockViewer(game, 'reward-holder', 'Reward Holder');
  const hunter = addMockViewer(game, 'reward-hunter', 'Reward Hunter');
  for (let index = 0; index < 3; index += 1) {
    const victim = addMockViewer(game, `reward-victim-${index}`, `Reward Victim ${index}`);
    game.bus.emit('damage:request', { targetId: victim.id, amount: 10000, sourceId: holder.id, cause: 'attack' });
  }
  assert.equal(game.state.bountyId, holder.id);
  const claims = [];
  const buffs = [];
  game.bus.on('bounty:claimed', (event) => claims.push(event));
  game.bus.on('buff:apply', (event) => buffs.push(event));
  game.bus.emit('damage:request', { targetId: hunter.id, amount: hunter.hp - 10, sourceId: null, cause: 'zone' });
  game.bus.emit('damage:request', { targetId: holder.id, amount: 10000, sourceId: hunter.id, cause: 'attack' });
  assert.deepEqual(claims, [{ victimId: holder.id, killerId: hunter.id }]);
  assert.equal(hunter.hp, 10 + hunter.maxHp * game.cfg.bounty.killerRewardHealPercent);
  assert.equal(hunter.streak, 1);
  assert.equal(holder.streak, 0);
  assert.equal(game.state.bountyId, null);
  assert.equal(buffs.length, 1);
  assert.equal(buffs[0].type, game.cfg.bounty.killerRewardBuff.type);
  game.bus.emit('player:killed', { victimId: holder.id, killerId: hunter.id, cause: 'attack' });
  assert.equal(claims.length, 1);
  assert.equal(hunter.streak, 1);
  game.bus.emit('revive:request', { playerId: holder.id, byId: hunter.id });
  game.state.time += game.cfg.combat.reviveInvulnMs / 1000;
  game.bus.emit('damage:request', { targetId: holder.id, amount: 10000, sourceId: hunter.id, cause: 'attack' });
  assert.equal(hunter.streak, 2);
  assert.equal(claims.length, 1);
  game.dispose();
});

test('zone: exact stages, smooth pauses, damage cadence, storm and round reset', () => {
  const cfg = testConfig();
  cfg.zone = { initialRadius: 100, baseDps: 2, damageTickMs: 1000, stages: [
    { atSec: 2, radius: 60, shrinkSec: 2, dps: 4 },
    { atSec: 6, radius: 20, shrinkSec: 2, dps: 8 },
  ] };
  cfg.events.list = [{ type: 'storm', durationSec: 2, dps: 6 }];
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const zone = createZoneSystem({ bus, state, config: cfg });
  state.players.set('inside', { id: 'inside', status: 'alive', x: state.arena.cx, y: state.arena.cy });
  state.players.set('outside', { id: 'outside', status: 'alive', x: state.arena.cx + 110, y: state.arena.cy });
  const warnings = [];
  const damages = [];
  bus.on('zone:update', (event) => warnings.push(event));
  bus.on('damage:request', (event) => damages.push(event));
  const phase = (value) => { state.phase = value; bus.emit('round:phase', { phase: value }); };
  phase('BATTLE');
  assert.equal(state.zone.radius, 100);
  const advance = (time) => { const dt = time - state.time; state.time = time; zone.update(dt); };
  advance(1);
  assert.equal(damages.length, 1);
  assert.equal(damages[0].amount, 2);
  advance(3);
  assert.equal(state.zone.radius, 80);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].nextRadius, 60);
  assert.equal(warnings[1].shrinkAtMs, warnings[0].shrinkAtMs);
  advance(4);
  assert.equal(state.zone.radius, 60);
  advance(5);
  assert.equal(state.zone.radius, 60);
  phase('FINAL');
  advance(7);
  assert.equal(state.zone.radius, 40);
  assert.equal(warnings.length, 3);
  bus.emit('event:triggered', { type: 'storm' });
  advance(8);
  assert.equal(state.zone.radius, 20);
  assert.equal(damages.at(-1).amount, 14);
  advance(10);
  assert.equal(damages.at(-1).amount, 8);
  assert.equal(damages.length, 10);
  assert.ok(damages.every((event) => event.targetId === 'outside' && event.cause === 'zone'));
  phase('RESULT');
  advance(20);
  assert.equal(damages.length, 10);
  phase('LOBBY');
  assert.equal(state.zone.radius, 100);
  assert.equal(state.zone.targetRadius, 100);
  advance(21);
  assert.equal(warnings.length, 3);
  phase('BATTLE');
  advance(22);
  assert.equal(damages.at(-1).amount, 2);
  zone.dispose();
  assert.equal(bus.listenerCount('round:phase'), 0);
  assert.equal(bus.listenerCount('event:triggered'), 0);
});

test('zone: storm catch-up never applies extra damage before storm starts', () => {
  const cfg = testConfig();
  cfg.zone.initialRadius = 100;
  cfg.events.list = [{ type: 'storm', durationSec: 2, dps: 6 }];
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const zone = createZoneSystem({ bus, state, config: cfg });
  state.phase = 'BATTLE';
  state.players.set('outside', { id: 'outside', status: 'alive', x: state.arena.cx + 200, y: state.arena.cy });
  bus.emit('round:phase', { phase: 'BATTLE' });
  const damage = [];
  bus.on('damage:request', ({ amount }) => damage.push(amount));
  state.time = 5;
  bus.emit('event:triggered', { type: 'storm' });
  zone.update(5);
  assert.deepEqual(damage, [2, 2, 2, 2, 8]);
  zone.dispose();
});

test('events: lobby energy is deferred, phase gates and drop request/collection/expiry', () => {
  const cfg = testConfig();
  cfg.events.list = [{ type: 'storm', weight: 1, durationSec: 2, dps: 6 }];
  cfg.events.dropSpawnSec = [1, 1];
  cfg.events.dropLifetimeMs = 500;
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const events = createEventSystem({ bus, state, config: cfg });
  const triggered = [];
  const spawned = [];
  const energy = [];
  const damage = [];
  bus.on('event:triggered', (event) => triggered.push(event));
  bus.on('drop:spawned', (drop) => spawned.push(drop));
  bus.on('energy:changed', (event) => energy.push(event));
  bus.on('damage:request', (event) => damage.push(event));
  bus.emit('energy:add', { amount: 1000 });
  assert.equal(state.energy.value, cfg.events.energy.max);
  bus.emit('drop:request', { tier: 3 });
  bus.emit('ultimate:fire', { byId: 'absent' });
  events.update(5);
  assert.equal(triggered.length, 0);
  assert.equal(spawned.length, 0);
  state.phase = 'BATTLE';
  bus.emit('round:phase', { phase: 'BATTLE' });
  events.update(1 / cfg.tickRate);
  assert.deepEqual(triggered, [{ type: 'storm' }]);
  assert.equal(state.energy.value, 0);
  assert.equal(damage.length, 0, 'storm itself does not damage players');
  assert.equal(energy.at(-1).value, 0);
  bus.emit('drop:request', { tier: 3, x: -10, y: state.arena.h + 10 });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].x, 0);
  assert.equal(spawned[0].y, state.arena.h);
  bus.emit('drop:collected', { id: spawned[0].id, playerId: 'collector', reward: 'heal' });
  assert.equal(state.drops.length, 0);
  bus.emit('drop:request', { tier: 2, x: 50, y: 60 });
  state.time = 0.49;
  events.update(0.49);
  assert.equal(state.drops.length, 1);
  state.time = 0.5;
  events.update(0.01);
  assert.equal(state.drops.length, 0);
  state.time = 1;
  events.update(0.5);
  assert.equal(state.drops.length, 1);
  assert.equal(state.drops[0].tier, cfg.events.automaticDropTier);
  bus.emit('drop:request', null);
  bus.emit('drop:request', { tier: 99 });
  bus.emit('drop:request', { tier: 1, x: NaN });
  bus.emit('energy:add', null);
  assert.equal(state.drops.length, 1);
  state.phase = 'RESULT';
  const before = { spawned: spawned.length, triggered: triggered.length, drops: state.drops.length };
  state.time = 100;
  bus.emit('energy:add', { amount: 100 });
  bus.emit('drop:request', { tier: 3 });
  events.update(99);
  assert.equal(spawned.length, before.spawned);
  assert.equal(triggered.length, before.triggered);
  assert.equal(state.drops.length, before.drops);
  state.phase = 'LOBBY';
  bus.emit('round:phase', { phase: 'LOBBY' });
  assert.equal(state.drops.length, 0);
  assert.equal(state.traps.length, 0);
  events.dispose();
  assert.equal(bus.listenerCount('energy:add'), 0);
  assert.equal(bus.listenerCount('drop:request'), 0);
});

test('events: boss requires four alive, spawns once per round and rewards top damage once', () => {
  const cfg = testConfig();
  cfg.events.trapSpawnSec = [2000, 2000];
  cfg.events.dropSpawnSec = [2000, 2000];
  cfg.events.list = [{ type: 'boss', weight: 1, hp: 100, atk: 25, speed: 90, minAliveToSpawn: 1, rewardHealPercent: 0.5 }];
  cfg.combat.critChance = 0;
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const events = createEventSystem({ bus, state, config: cfg });
  const combat = createCombatSystem({ bus, state, config: cfg });
  const gifts = createGiftEffectSystem({ bus, state, config: cfg });
  state.phase = 'BATTLE';
  bus.emit('round:phase', { phase: 'BATTLE' });
  for (let index = 0; index < 3; index += 1) {
    const player = createPlayer({ id: `boss-player-${index}` }, state, cfg, 'swordsman');
    state.players.set(player.id, player);
  }
  let spawned = 0;
  let rewards = 0;
  bus.on('boss:spawned', () => { spawned += 1; });
  bus.on('buff:apply', ({ type }) => { if (type === 'rage') rewards += 1; });
  bus.emit('energy:add', { amount: 100 });
  assert.equal(state.boss, null);
  assert.equal(spawned, 0);
  const fourth = createPlayer({ id: 'fourth' }, state, cfg, 'swordsman');
  state.players.set(fourth.id, fourth);
  events.update(1 / cfg.tickRate);
  assert.equal(spawned, 1);
  assert.equal(state.energy.value, 0);
  const top = state.players.get('boss-player-0');
  const second = state.players.get('boss-player-1');
  bus.emit('damage:request', { targetId: top.id, amount: 80, cause: 'zone' });
  bus.emit('damage:request', { targetId: second.id, amount: 80, cause: 'zone' });
  const bossId = state.boss.id;
  bus.emit('damage:request', { targetId: bossId, amount: 70, sourceId: top.id, cause: 'attack' });
  bus.emit('damage:request', { targetId: bossId, amount: 30, sourceId: second.id, cause: 'attack' });
  assert.equal(state.boss, null);
  assert.equal(top.hp, 100);
  assert.equal(second.hp, 40);
  assert.equal(rewards, 1);
  assert.ok(top.buffs.some((buff) => buff.type === 'rage'));
  bus.emit('boss:defeated', { topDamagers: [{ playerId: top.id, damage: 70 }] });
  assert.equal(rewards, 1);
  bus.emit('energy:add', { amount: 100 });
  state.time = 1001;
  events.update(1001);
  assert.equal(spawned, 1);
  state.phase = 'LOBBY';
  bus.emit('round:phase', { phase: 'LOBBY' });
  state.phase = 'BATTLE';
  bus.emit('round:phase', { phase: 'BATTLE' });
  bus.emit('energy:add', { amount: 100 });
  assert.equal(spawned, 2);
  gifts.dispose();
  combat.dispose();
  events.dispose();
});

test('events: bomb rain and meteors spawn configured bombs, explode once and stop in RESULT', () => {
  const originalRandom = Math.random;
  try {
    for (const type of ['bombRain', 'meteor']) {
      Math.random = createRng(99).next;
      const cfg = testConfig();
      const event = config.events.list.find((item) => item.type === type);
      cfg.events.list = [{ ...event, weight: 1 }];
      const state = createState(cfg);
      const bus = createEventBus(cfg);
      const events = createEventSystem({ bus, state, config: cfg });
      const combat = createCombatSystem({ bus, state, config: cfg });
      state.phase = 'BATTLE';
      bus.emit('round:phase', { phase: 'BATTLE' });
      const triggers = [];
      const damage = [];
      bus.on('trap:triggered', (payload) => triggers.push(payload));
      bus.on('damage:request', (payload) => damage.push(payload));
      bus.emit('energy:add', { amount: 100 });
      assert.equal(state.traps.length, event.bombs ?? event.count);
      assert.ok(state.traps.every((trap) => trap.kind === 'bomb' && trap.damage === event.damage && trap.radius === event.radius));
      const bomb = state.traps[0];
      const target = createPlayer({ id: 'bomb-target' }, state, cfg, 'swordsman');
      Object.assign(target, { x: bomb.x, y: bomb.y });
      state.players.set(target.id, target);
      state.phase = 'RESULT';
      events.update(1);
      assert.equal(triggers.length, 0);
      state.phase = 'FINAL';
      events.update(1 / cfg.tickRate);
      assert.ok(triggers.length >= 1);
      assert.ok(target.hp < target.maxHp);
      assert.ok(damage.every((request) => request.cause === 'bomb'));
      state.time = cfg.events.traps.bomb.fuseMs / 1000;
      events.update(state.time);
      assert.equal(state.traps.length, 0);
      assert.equal(triggers.length, event.bombs ?? event.count);
      assert.equal(new Set(triggers.map((trap) => trap.id)).size, triggers.length);
      combat.dispose();
      events.dispose();
    }
  } finally {
    Math.random = originalRandom;
  }
});

test('events: hotspot spike damages entrants once, automatic schedules respect phase gates', () => {
  const cfg = testConfig();
  cfg.events.trapSpawnSec = [1, 1];
  cfg.events.spikeChance = 1;
  cfg.events.hotspotScatterRadius = 0;
  cfg.events.intervalSec = [2, 2];
  cfg.events.list = [{ type: 'storm', weight: 1, durationSec: 1, dps: 6 }];
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const events = createEventSystem({ bus, state, config: cfg });
  const player = createPlayer({ id: 'hotspot-player' }, state, cfg);
  state.players.set(player.id, player);
  let triggered = 0;
  let damage = 0;
  bus.on('event:triggered', () => { triggered += 1; });
  bus.on('damage:request', (request) => { assert.equal(request.cause, 'trap'); damage += 1; });
  state.phase = 'BATTLE';
  bus.emit('round:phase', { phase: 'BATTLE' });
  state.time = 1;
  events.update(1);
  assert.equal(damage, 1);
  assert.equal(state.traps.length, 0);
  events.update(1 / cfg.tickRate);
  assert.equal(damage, 1);
  state.time = 2;
  events.update(1);
  assert.equal(triggered, 1);
  assert.equal(damage, 2);
  state.phase = 'RESULT';
  state.time = 100;
  events.update(98);
  assert.equal(triggered, 1);
  assert.equal(damage, 2);
  events.dispose();
});

test('events: ultimate ignores self/allies, damages enemies once and produces active-only effects', () => {
  const cfg = testConfig();
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const events = createEventSystem({ bus, state, config: cfg });
  const combat = createCombatSystem({ bus, state, config: cfg });
  const effects = createEffects({ bus, state, config: cfg });
  for (const id of ['source', 'ally', 'enemy']) state.players.set(id, createPlayer({ id }, state, cfg, 'swordsman'));
  const source = state.players.get('source');
  const ally = state.players.get('ally');
  const enemy = state.players.get('enemy');
  source.allianceId = ally.id;
  ally.allianceId = source.id;
  const fire = () => bus.emit('ultimate:fire', { byId: source.id });
  fire();
  assert.equal(enemy.hp, enemy.maxHp);
  assert.equal(effects.particleCount, 0);
  state.phase = 'BATTLE';
  fire();
  assert.equal(source.hp, source.maxHp);
  assert.equal(ally.hp, ally.maxHp);
  assert.equal(enemy.hp, enemy.maxHp - cfg.gifts.tiers[3].ultimate.damage);
  assert.ok(effects.particleCount >= cfg.ui.ultimateParticleCount);
  effects.update(Math.max(cfg.ui.particleLifeMs, cfg.ui.effectWaveLifeMs, cfg.ui.effectPopupLifeMs) / 1000);
  state.phase = 'RESULT';
  fire();
  assert.equal(enemy.hp, enemy.maxHp - cfg.gifts.tiers[3].ultimate.damage);
  assert.equal(effects.particleCount, 0);
  effects.dispose();
  combat.dispose();
  events.dispose();
});

test('movement: phases, allies, bounty, dodge expiry, separation, zone and supplies', () => {
  const cfg = testConfig();
  cfg.movement.velocitySmoothing = 1;
  cfg.movement.separationStrength = 0;
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const movement = createMovementSystem({ bus, state, config: cfg });
  const makePlayer = (id, x, y) => {
    const player = createPlayer({ id, name: id }, state, cfg, 'swordsman');
    Object.assign(player, { x, y, prevX: x, prevY: y });
    state.players.set(id, player);
    return player;
  };
  const fighter = makePlayer('fighter', 300, 900);
  const ally = makePlayer('ally', 320, 900);
  fighter.allianceId = ally.id;
  ally.allianceId = fighter.id;
  makePlayer('enemy', 450, 900);
  const bounty = makePlayer('bounty', 500, 900);
  state.bountyId = bounty.id;
  movement.update(1 / cfg.tickRate);
  assert.equal(fighter.x, 300);
  bus.emit('cmd:dodge', { playerId: fighter.id });
  assert.equal(fighter.intent, 'normal');
  state.phase = 'BATTLE';
  movement.update(1 / cfg.tickRate);
  assert.equal(fighter.targetId, bounty.id);
  assert.ok(fighter.vx > 0);
  bus.emit('cmd:dodge', { playerId: fighter.id });
  const cooldown = fighter.cooldowns.dodge;
  bus.emit('cmd:dodge', { playerId: fighter.id });
  assert.equal(fighter.cooldowns.dodge, cooldown);
  movement.update(1 / cfg.tickRate);
  assert.ok(fighter.vx < 0);
  assert.ok(Math.abs(Math.hypot(fighter.vx, fighter.vy) - fighter.speed * cfg.combat.dodge.speedMult * cfg.alliance.buff.speedMult) < 1e-8);
  fighter.buffs.push({ type: 'speed', value: 1.3, until: 10000 });
  state.time = cfg.combat.dodge.durationMs / 1000;
  movement.update(1 / cfg.tickRate);
  assert.equal(fighter.intent, 'normal');
  state.zone = { cx: 540, cy: 960, radius: 100, targetRadius: 100 };
  movement.update(1 / cfg.tickRate);
  assert.ok(fighter.vx > 0 && fighter.vy > 0);
  state.zone.radius = 10000;
  let collected = 0;
  bus.on('drop:collected', ({ playerId, reward }) => { collected += 1; assert.equal(playerId, fighter.id); assert.ok(Object.hasOwn(cfg.gifts.dropRewards, reward)); });
  state.drops.push({ id: 'supply', x: fighter.x, y: fighter.y, tier: 1 });
  movement.update(1 / cfg.tickRate);
  movement.update(1 / cfg.tickRate);
  assert.equal(collected, 1);
  assert.equal(state.drops.length, 0);
  state.players.clear();
  fighter.allianceId = null;
  fighter.x = 300; fighter.y = 900; fighter.vx = 0; fighter.vy = 0;
  state.players.set(fighter.id, fighter);
  makePlayer('overlap', 300, 900);
  cfg.movement.separationStrength = 0.8;
  movement.update(1 / cfg.tickRate);
  assert.notEqual(fighter.x, state.players.get('overlap').x);
  fighter.x = -100;
  fighter.y = state.arena.h + 100;
  movement.update(1 / cfg.tickRate);
  assert.ok(fighter.x >= cfg.ui.playerRadius && fighter.y <= state.arena.h - cfg.ui.playerRadius);
  movement.dispose();
  assert.equal(bus.listenerCount('cmd:dodge'), 0);
});

test('movement: ranged spacing, nearby supply priority, nearest boss and betrayal', () => {
  for (const classId of ['archer', 'mage']) {
    const cfg = testConfig();
    cfg.movement.velocitySmoothing = 1;
    cfg.movement.separationStrength = 0;
    const state = createState(cfg);
    state.phase = 'FINAL';
    const bus = createEventBus(cfg);
    const movement = createMovementSystem({ bus, state, config: cfg });
    const source = createPlayer({ id: 'ranged' }, state, cfg, classId);
    const enemy = createPlayer({ id: 'enemy' }, state, cfg, 'tank');
    Object.assign(source, { x: 500, y: 900 });
    Object.assign(enemy, { x: 600, y: 900 });
    state.players.set(source.id, source);
    state.players.set(enemy.id, enemy);
    movement.update(1 / cfg.tickRate);
    assert.ok(source.vx < 0);
    enemy.x = source.x + source.range * 0.7;
    movement.update(1 / cfg.tickRate);
    assert.equal(source.vx, 0);
    enemy.x = source.x + source.range * 1.2;
    movement.update(1 / cfg.tickRate);
    assert.ok(source.vx > 0);
    state.drops.push({ id: 'priority', x: source.x - 100, y: source.y, tier: 1 });
    movement.update(1 / cfg.tickRate);
    assert.ok(source.vx < 0);
    assert.equal(state.drops.length, 1);
    state.drops.length = 0;
    state.boss = { id: 'boss_near', x: source.x - 25, y: source.y, hp: 500, maxHp: 500, speed: 90, atk: 25 };
    movement.update(1 / cfg.tickRate);
    assert.equal(source.targetId, state.boss.id);
    enemy.status = 'dead';
    movement.update(1 / cfg.tickRate);
    assert.equal(source.targetId, state.boss.id);
    enemy.status = 'alive';
    bus.emit('cmd:dodge', { playerId: source.id });
    movement.update(1 / cfg.tickRate);
    assert.ok(source.vx > 0, 'dodge runs away from the closer boss, not the distant player');
    state.boss = null;
    source.allianceId = 'team';
    enemy.allianceId = 'team';
    state.time += cfg.combat.dodge.durationMs / 1000;
    movement.update(1 / cfg.tickRate);
    assert.equal(source.targetId, null);
    bus.emit('ally:betrayed', { betrayerId: source.id, victimId: enemy.id });
    movement.update(1 / cfg.tickRate);
    assert.equal(source.targetId, enemy.id);
    state.time += cfg.movement.betrayPriorityDurationMs / 1000;
    movement.update(1 / cfg.tickRate);
    assert.equal(source.targetId, null);
    movement.dispose();
    const x = source.x;
    movement.update(1 / cfg.tickRate);
    assert.equal(source.x, x);
  }
});

test('combat: exact shield absorption, HP clamps, nested damage and revive lifetimes', () => {
  const cfg = testConfig();
  cfg.combat.critChance = 0;
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const combat = createCombatSystem({ bus, state, config: cfg });
  const source = createPlayer({ id: 'source' }, state, cfg, 'swordsman');
  const target = createPlayer({ id: 'target' }, state, cfg, 'swordsman');
  state.players.set(source.id, source);
  state.players.set(target.id, target);
  target.shield = 20;
  const damaged = [];
  let killed = 0;
  bus.on('player:damaged', (event) => {
    damaged.push(event);
    assert.ok(target.hp >= 0 && target.hp <= target.maxHp);
    if (target.hp === 0) bus.emit('damage:request', { targetId: target.id, amount: 10000, sourceId: source.id, cause: 'attack' });
  });
  bus.on('player:killed', () => { killed += 1; });
  const attack = () => bus.emit('damage:request', { targetId: target.id, amount: 18, sourceId: source.id, cause: 'attack' });
  attack();
  assert.equal(target.shield, 10);
  assert.equal(target.hp, target.maxHp);
  attack();
  assert.equal(target.shield, 0);
  assert.equal(target.hp, target.maxHp);
  attack();
  assert.equal(target.hp, target.maxHp - 10);
  assert.deepEqual(damaged.map((event) => event.amount), [0, 0, 10]);
  assert.equal(source.damageDealt, 10);
  bus.emit('heal:request', { targetId: target.id, amount: 10000, sourceId: source.id });
  assert.equal(target.hp, target.maxHp);
  bus.emit('damage:request', null);
  for (const amount of [NaN, Infinity, -1, 0]) bus.emit('damage:request', { targetId: target.id, amount, cause: 'zone' });
  bus.emit('heal:request', null);
  bus.emit('damage:request', { targetId: target.id, amount: 10000, sourceId: source.id, cause: 'zone' });
  bus.emit('damage:request', { targetId: target.id, amount: 10000, sourceId: source.id, cause: 'zone' });
  assert.equal(killed, 1);
  assert.equal(source.kills, 1);
  assert.equal(source.streak, 0);
  assert.equal(target.hp, 0);
  assert.equal(source.damageDealt, 10 + target.maxHp);
  bus.emit('heal:request', { targetId: target.id, amount: 10 });
  assert.equal(target.hp, 0);
  bus.emit('revive:request', { playerId: target.id, byId: source.id });
  assert.equal(target.hp, target.maxHp * cfg.gifts.tiers[3].reviveHpPercent);
  assert.equal(target.status, 'alive');
  bus.emit('damage:request', { targetId: target.id, amount: 10000, sourceId: source.id, cause: 'zone' });
  assert.equal(killed, 1);
  state.time = cfg.combat.reviveInvulnMs / 1000;
  bus.emit('damage:request', { targetId: target.id, amount: 10000, sourceId: source.id, cause: 'zone' });
  assert.equal(killed, 2);
  combat.dispose();
  assert.equal(bus.listenerCount('damage:request'), 0);
});

test('combat: additive buffs, attack speed boost, expiry, crit and friendly fire', () => {
  const cfg = testConfig();
  cfg.combat.critChance = 0;
  const state = createState(cfg);
  state.phase = 'BATTLE';
  const bus = createEventBus(cfg);
  const combat = createCombatSystem({ bus, state, config: cfg });
  const source = createPlayer({ id: 'source' }, state, cfg, 'swordsman');
  const target = createPlayer({ id: 'target' }, state, cfg, 'tank');
  Object.assign(source, { atk: 30, targetId: target.id, x: 500, y: 900 });
  Object.assign(target, { hp: 1000, maxHp: 1000, def: 5, x: 520, y: 900 });
  state.players.set(source.id, source);
  state.players.set(target.id, target);
  const hits = [];
  bus.on('player:damaged', (event) => { if (event.targetId === target.id) hits.push(event); });
  combat.update(1 / cfg.tickRate);
  assert.equal(hits[0].amount, 25);
  bus.emit('cmd:attack', { playerId: source.id });
  const cooldown = source.cooldowns.attack;
  bus.emit('cmd:attack', { playerId: source.id });
  assert.equal(source.cooldowns.attack, cooldown);
  state.time = source.attackInterval / cfg.combat.attackBoostSpeedMult / 1000 - 0.001;
  combat.update(1 / cfg.tickRate);
  assert.equal(hits.length, 1);
  state.time += 0.001;
  combat.update(1 / cfg.tickRate);
  assert.equal(hits[1].amount, 43);
  source.weaponLevel = 2;
  source.buffs.push({ type: 'rage', value: 1.5, until: 10000 }, { type: 'weapon', value: 1.2, until: 10000 });
  state.time += source.attackInterval / cfg.combat.attackBoostSpeedMult / 1000;
  combat.update(1 / cfg.tickRate);
  assert.ok(Math.abs(hits[2].amount - (30 * (1 + 0.24 + 0.5 + 0.2 + 0.6) - 5)) < 1e-8);
  target.x = 900;
  state.time = cfg.combat.attackBoostDurationMs / 1000;
  combat.update(1 / cfg.tickRate);
  assert.equal(source.intent, 'normal');
  assert.equal(hits.length, 3);
  cfg.combat.critChance = 1;
  bus.emit('damage:request', { targetId: target.id, amount: 30, sourceId: source.id, cause: 'attack' });
  assert.equal(hits.at(-1).amount, (30 - target.def) * cfg.combat.critMult);
  assert.equal(hits.at(-1).crit, true);
  source.allianceId = 'team';
  target.allianceId = 'team';
  const hp = target.hp;
  bus.emit('damage:request', { targetId: target.id, amount: 30, sourceId: source.id, cause: 'attack' });
  assert.equal(target.hp, hp);
  bus.emit('ally:betrayed', { betrayerId: source.id, victimId: target.id });
  bus.emit('damage:request', { targetId: target.id, amount: 30, sourceId: source.id, cause: 'attack' });
  assert.ok(target.hp < hp);
  combat.dispose();
});

test('combat: boss nearest targeting, single boss attacks and capped damage credit', () => {
  const cfg = testConfig();
  cfg.combat.critChance = 0;
  const state = createState(cfg);
  state.phase = 'BATTLE';
  const bus = createEventBus(cfg);
  const combat = createCombatSystem({ bus, state, config: cfg });
  const events = createEventSystem({ bus, state, config: cfg });
  const near = createPlayer({ id: 'near' }, state, cfg, 'swordsman');
  const far = createPlayer({ id: 'far' }, state, cfg, 'swordsman');
  Object.assign(near, { x: 550, y: 960, attackInterval: 100000, targetId: far.id });
  Object.assign(far, { x: 900, y: 960 });
  state.players.set(near.id, near);
  state.players.set(far.id, far);
  state.boss = { id: 'boss_test', x: 540, y: 960, hp: 500, maxHp: 500, atk: 25, speed: 90 };
  let attacks = 0;
  let defeats = 0;
  let result;
  bus.on('damage:request', (event) => { if (event.cause === 'boss') attacks += 1; });
  bus.on('boss:defeated', (event) => { defeats += 1; result = event; });
  combat.update(1 / cfg.tickRate);
  assert.equal(near.damageDealt, near.atk);
  assert.equal(state.boss.hp, state.boss.maxHp - near.atk);
  state.time = cfg.events.bossAttackIntervalMs / 1000;
  events.update(1 / cfg.tickRate);
  combat.update(1 / cfg.tickRate);
  assert.equal(attacks, 1);
  assert.equal(near.hp, near.maxHp - (25 - near.def));
  assert.equal(far.hp, far.maxHp);
  bus.emit('damage:request', { targetId: 'boss_test', amount: 10000, sourceId: near.id, cause: 'attack' });
  bus.emit('damage:request', { targetId: 'boss_test', amount: 10000, sourceId: near.id, cause: 'attack' });
  assert.equal(defeats, 1);
  assert.equal(state.boss, null);
  assert.equal(near.damageDealt, 500);
  assert.deepEqual(result.topDamagers, [{ playerId: near.id, damage: 500 }]);
  events.dispose();
  combat.dispose();
});

test('combat: headless 20 bots finish in 60-120 seconds at 30 Hz without duplicate deaths', () => {
  const originalRandom = Math.random;
  try {
    for (const seed of [1, 17, 42]) {
      Math.random = createRng(seed).next;
      const cfg = structuredClone(config);
      cfg.phases.durationSec.LOBBY = 0.1;
      cfg.phases.durationSec.COUNTDOWN = 0.1;
      const state = createState(cfg);
      const bus = createEventBus(cfg);
      const systems = [
        createRoundManager({ bus, state, config: cfg }),
        createAllianceSystem({ bus, state, config: cfg }),
        createZoneSystem({ bus, state, config: cfg }),
        createMovementSystem({ bus, state, config: cfg }),
        createCombatSystem({ bus, state, config: cfg }),
      ];
      let battleStart = 0;
      let result;
      let endedAt = 0;
      const kills = new Map();
      bus.on('round:phase', ({ phase }) => { if (phase === 'BATTLE') battleStart = state.time; });
      bus.on('round:ended', (event) => { result = event; endedAt = state.time; });
      bus.on('player:killed', ({ victimId }) => kills.set(victimId, (kills.get(victimId) ?? 0) + 1));
      for (let tick = 0; tick < 121 * cfg.tickRate && !result; tick += 1) {
        for (const system of systems) system.update(1 / cfg.tickRate);
        for (const player of state.players.values()) assert.ok(player.hp >= 0 && player.hp <= player.maxHp);
      }
      const duration = endedAt - battleStart;
      console.info(`[20 bots seed=${seed}] battle=${duration.toFixed(2)}s, kills=${kills.size}, alive=${[...state.players.values()].filter((player) => player.status === 'alive').length}`);
      assert.ok(result, `seed ${seed}: no result within 120s`);
      assert.ok(duration >= 60 && duration <= 120, `seed ${seed}: battle ${duration.toFixed(2)}s`);
      assert.equal(result.ranking.length, 20);
      assert.ok(result.winnerId);
      assert.equal(kills.size, 19);
      assert.ok([...kills.values()].every((count) => count === 1));
      systems.reverse().forEach((system) => system.dispose());
    }
  } finally {
    Math.random = originalRandom;
  }
});

test('core: chuẩn hóa, tìm người chơi và EventBus không chặn listener', () => {
  assert.equal(normalizeText('ĐÁNH'), normalizeText('danh'));
  const gameState = createState(config);
  gameState.players.set('u1', { id: 'u1', name: 'Đức Huy', status: 'alive' });
  assert.equal(getPlayerByName(gameState, 'duc huy')?.id, 'u1');
  const bus = createEventBus();
  let called = false;
  bus.on('probe', () => { throw new Error('expected test error'); });
  bus.on('probe', () => { called = true; });
  const original = console.error;
  console.error = () => {};
  bus.emit('probe');
  console.error = original;
  assert.equal(called, true);
});

test('commandParser: alias có dấu, emoji, @name và chỉ khớp đầu comment', () => {
  assert.deepEqual(parse('  ĐÁNH!!! ', config), { cmd: 'attack', arg: '' });
  assert.deepEqual(parse('TAN CONG', config), { cmd: 'attack', arg: '' });
  assert.deepEqual(parse('HỢP TÁC @Ngọc Lan 🔥', config), { cmd: 'ally', arg: 'ngoc lan' });
  assert.deepEqual(parse('cứu @Đức Huy', config), { cmd: 'giftTarget', arg: 'duc huy' });
  assert.equal(parse('Mọi người hãy đánh', config), null);
  assert.equal(parse('đánh mục tiêu', config), null);
});

test('inputRouter: cooldown riêng và token bucket chặn comment flood', () => {
  const cfg = testConfig();
  cfg.input.tokenCapacity = 50;
  cfg.input.tokenRefillPerSec = 0;
  cfg.input.commandCooldownMs.attack = 1000;
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const player = { id: 'cooldown-user', name: 'Cooldown', status: 'alive', cooldowns: { attack: 0, dodge: 0, ally: 0, betray: 0 } };
  state.players.set(player.id, player);
  const router = createInputRouter({ bus, state, config: cfg });
  let attacks = 0;
  bus.on('cmd:attack', () => { attacks += 1; });
  bus.emit('live:chat', { userId: player.id, text: 'đánh' });
  bus.emit('live:chat', { userId: player.id, text: 'ATTACK' });
  assert.equal(attacks, 1);
  state.time = 1;
  bus.emit('live:chat', { userId: player.id, text: 'tấn công' });
  assert.equal(attacks, 2);
  router.dispose();
  bus.clear();

  cfg.input.tokenCapacity = 7;
  const floodState = createState(cfg);
  const floodBus = createEventBus(cfg);
  for (let index = 0; index < 50; index += 1) {
    const id = `flood-${index}`;
    floodState.players.set(id, { id, name: id, status: 'alive', cooldowns: { attack: 0, dodge: 0, ally: 0, betray: 0 } });
  }
  const floodRouter = createInputRouter({ bus: floodBus, state: floodState, config: cfg });
  let accepted = 0;
  floodBus.on('cmd:attack', () => { accepted += 1; });
  for (let index = 0; index < 50; index += 1) floodBus.emit('live:chat', { userId: `flood-${index}`, text: 'đánh' });
  assert.equal(accepted, 7);
  floodRouter.dispose();
  floodBus.clear();
});

test('inputRouter: quà tự join, áp dụng rescue target và cộng energy đúng schema', () => {
  const game = createGame();
  const target = addMockViewer(game, 'gift-target', 'Ngọc Lan');
  const effects = [];
  const energies = [];
  const joins = [];
  game.bus.on('gift:effect', (event) => effects.push(event));
  game.bus.on('energy:add', (event) => energies.push(event));
  game.bus.on('cmd:join', (event) => joins.push(event));
  const gift = { userId: 'new-gifter', uniqueId: 'new-gifter', nickname: 'Tặng Quà', avatarUrl: '', giftId: 9, giftName: 'Rose', diamonds: 5, count: 1 };
  game.bus.emit('live:join', gift);
  game.bus.emit('live:chat', { ...gift, text: 'cứu @Ngọc Lan' });
  assert.equal(game.state.giftTargets.get(gift.userId)?.targetId, target.id);
  game.bus.emit('live:gift', gift);
  assert.ok(game.state.players.has(gift.userId));
  assert.deepEqual(effects[0], { fromId: gift.userId, toId: target.id, tier: 1, diamonds: 5, giftName: 'Rose', count: 1 });
  assert.deepEqual(energies[0], { amount: 0.5 });
  const spontaneousGift = { ...gift, userId: 'spontaneous-gifter', nickname: 'Tự Join' };
  game.bus.emit('live:gift', spontaneousGift);
  assert.ok(game.state.players.has(spontaneousGift.userId));
  assert.equal(effects[1].toId, spontaneousGift.userId);
  assert.deepEqual(joins.find((event) => event.player.id === spontaneousGift.userId), {
    player: { id: spontaneousGift.userId, name: spontaneousGift.nickname, avatar: '' },
  });
  game.bus.emit('live:like', { userId: target.id, nickname: target.name, likeCount: 10, totalLikeCount: 10 });
  assert.deepEqual(energies[1], { amount: 0.5 });
  game.dispose();
});

test('gift tier 4: ưu tiên hồi sinh người được chọn bằng rescue', () => {
  const game = createGame();
  const unrelatedVictim = addMockViewer(game, 'unrelated-dead', 'Người Khác');
  const selectedVictim = addMockViewer(game, 'selected-dead', 'Ngọc Lan');
  const giver = addMockViewer(game, 'rescue-giver', 'Người Tặng');
  game.state.phase = 'BATTLE';
  game.bus.emit('damage:request', { targetId: unrelatedVictim.id, amount: 10000, sourceId: giver.id, cause: 'attack' });
  game.bus.emit('damage:request', { targetId: selectedVictim.id, amount: 10000, sourceId: giver.id, cause: 'attack' });
  game.bus.emit('live:chat', { userId: giver.id, text: 'CỨU @Ngọc Lan' });
  game.bus.emit('live:gift', { userId: giver.id, giftName: 'Galaxy', diamonds: 500, count: 1 });
  assert.equal(selectedVictim.status, 'alive');
  assert.equal(unrelatedVictim.status, 'dead');
  game.dispose();
});

test('event audit: TikTok mapper preserves real userId and emits normalized catalog payloads', async () => {
  let connection;
  class FakeConnection extends EventEmitter {
    constructor() { super(); connection = this; }
    async connect() { return { roomId: 'adapter-test' }; }
    async disconnect() {}
  }
  const seen = [];
  const statuses = [];
  const adapter = createTikTokAdapter({ username: 'test', ConnectionClass: FakeConnection, onEvent: (type, payload) => { assert.deepEqual(validateEventPayload(type, payload), []); seen.push({ type, payload }); }, onStatus: (payload) => { assert.deepEqual(validateEventPayload('live:status', payload), []); statuses.push(payload); } });
  await adapter.connect();
  const user = { userId: '12345', uniqueId: 'viewer', nickname: 'Viewer', profilePicture: { urls: ['https://example.test/avatar.png'] } };
  connection.emit('chat', { user, comment: 'JOIN' });
  connection.emit('gift', { user, giftId: 42, giftType: 1, repeatEnd: false, repeatCount: 2, diamondCount: 5, giftName: 'Rose' });
  assert.equal(seen.length, 1);
  connection.emit('gift', { user, giftId: 42, giftType: 1, repeatEnd: true, repeatCount: 2, diamondCount: 5, giftName: 'Rose' });
  for (const type of ['like', 'member', 'follow', 'share']) connection.emit(type, { user, likeCount: 3, totalLikeCount: 7 });
  assert.equal(seen.length, 6);
  assert.ok(seen.every((event) => event.payload.userId === user.userId));
  assert.equal(seen.find((event) => event.type === 'live:gift').payload.diamonds, 10);
  connection.emit('chat', { user: { uniqueId: 'not-a-user-id', nickname: 'Missing ID' }, comment: 'JOIN' });
  assert.equal(seen.length, 6);
  await adapter.disconnect();
  assert.equal(statuses.at(-1).connected, false);
});

test('event audit: runtime schema catches extra/missing fields and invalid payload types', () => {
  assert.deepEqual(validateEventPayload('live:status', { connected: true, roomId: 'mock' }), []);
  assert.ok(validateEventPayload('live:status', { connected: true, force: true }).length);
  assert.ok(validateEventPayload('buff:apply', { playerId: 'user', type: 'health', value: 10 }).length);
  assert.ok(validateEventPayload('round:ended', { roundId: 1, winnerId: null, ranking: [{ playerId: 'user', name: 'User', kills: 1, damage: 10, placement: 1, giftValue: 5 }] }).length);
});

test('event audit: event literals đều thuộc catalog hợp đồng', () => {
  const roots = ['client', 'server'];
  const files = [];
  while (roots.length) {
    const directory = roots.pop();
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) roots.push(path);
      else if (name.name.endsWith('.js')) files.push(path);
    }
  }
  const used = new Set();
  const emitted = new Set();
  const listened = new Set();
  const pattern = /(?:\bbus\.(on|emit|once|off)|\b(listen|safeEmit|emit))\(\s*['"]([^'"]+)['"]/g;
  const adapterPattern = /\[\s*['"](live:[^'"]+)['"]/g;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const method = match[1] ?? (match[2] === 'listen' ? 'on' : 'emit');
      const event = match[3];
      used.add(event);
      if (method === 'emit') emitted.add(event);
      if (method === 'on' || method === 'once') listened.add(event);
    }
    if (file.startsWith('server')) for (const match of source.matchAll(adapterPattern)) { used.add(match[1]); emitted.add(match[1]); }
  }
  assert.deepEqual([...used].filter((event) => !eventCatalog.has(event)), []);
  console.info('[event audit] emit không có listener:', [...emitted].filter((event) => !listened.has(event)).sort().join(', ') || 'không có');
  console.info('[event audit] listener chưa thấy emit tĩnh:', [...listened].filter((event) => !emitted.has(event)).sort().join(', ') || 'không có');
});

test('round manager: bot-only tự chơi và hoàn tất ít nhất năm vòng', () => {
  const game = createGame();
  for (let tick = 0; tick < 1000 && game.state.roundId < 5; tick += 1) game.step(0.05);
  assert.ok(game.state.roundId >= 5, `chỉ chạy ${game.state.roundId} vòng`);
  assert.ok(['LOBBY', 'COUNTDOWN', 'BATTLE', 'FINAL', 'RESULT'].includes(game.state.phase));
  if (game.state.phase === 'LOBBY') game.step(game.cfg.phases.durationSec.LOBBY);
  assert.equal(game.state.players.size, 3);
  game.dispose();
});

test('player factory: public API, balanced classes and unique Vietnamese bots', () => {
  const cfg = testConfig();
  const players = Array.from({ length: 40 }, (_, index) => createPlayer({ id: index, name: `Viewer ${index}` }, cfg));
  const counts = cfg.classOrder.map((id) => players.filter((player) => player.classId === id).length);
  assert.equal(Math.max(...counts) - Math.min(...counts), 0);
  for (const player of players) {
    const base = cfg.classes[player.classId];
    assert.equal(typeof player.id, 'string');
    assert.equal(player.hp, base.hp);
    assert.equal(player.maxHp, base.hp);
    for (const key of ['atk', 'def', 'speed', 'range', 'attackInterval']) assert.equal(player[key], base[key]);
    assert.equal(player.status, 'alive');
    assert.equal(player.allianceId, null);
    assert.deepEqual(player.cooldowns, { attack: 0, dodge: 0, ally: 0, betray: 0 });
    assert.deepEqual(player.buffs, []);
  }
  const first = createBot(cfg);
  const second = createBot(cfg);
  assert.ok(first.id.startsWith('bot_'));
  assert.notEqual(first.id, second.id);
  assert.ok(first.isBot);
  assert.ok(cfg.botNames.some((name) => first.name.startsWith(name)));
});

for (const viewers of [0, 1, 40]) {
  test(`round manager: headless phase sequence with ${viewers} viewers`, () => {
    const cfg = testConfig();
    cfg.lobby.maxPlayers = 40;
    cfg.phases.finalThresholdAlive = 5;
    const state = createState(cfg);
    const bus = createEventBus(cfg);
    const phases = [];
    const results = [];
    bus.on('round:phase', (event) => phases.push(event));
    bus.on('round:ended', (event) => results.push(event));
    const manager = createRoundManager({ bus, state, config: cfg });
    for (let index = 0; index < viewers; index += 1) {
      bus.emit('cmd:join', { player: { id: `viewer-${index}`, name: `Viewer ${index}`, avatar: '' } });
    }
    const combat = createCombatSystem({ bus, state, config: cfg });
    for (let tick = 0; tick < 100 && state.roundId === 1; tick += 1) manager.update(1 / cfg.tickRate);
    assert.equal(state.roundId, 2);
    assert.deepEqual(phases.map((event) => event.phase), ['LOBBY', 'COUNTDOWN', 'BATTLE', 'FINAL', 'RESULT', 'LOBBY']);
    assert.equal(results.length, 1);
    const result = results[0];
    assert.equal(result.roundId, 1);
    assert.equal(result.ranking.length, Math.max(viewers, cfg.lobby.botFillTo));
    assert.equal(result.winnerId, result.ranking[0].playerId);
    assert.deepEqual(result.ranking.map((row) => row.placement), result.ranking.map((_, index) => index + 1));
    assert.ok(phases.every((event) => Number.isFinite(event.endsAt)));
    const battle = phases.find((event) => event.phase === 'BATTLE');
    const final = phases.find((event) => event.phase === 'FINAL');
    assert.ok(Math.abs(final.endsAt - (battle.endsAt + cfg.phases.durationSec.FINAL * 1000)) < 1);
    console.info(`[headless ${viewers}] ${phases.map((event) => `${event.roundId}:${event.phase}`).join(' -> ')}; round:ended winner=${result.winnerId}, players=${result.ranking.length}`);
    combat.dispose();
    manager.dispose();
    assert.equal(bus.listenerCount('cmd:join'), 0);
    const time = state.time;
    manager.update(1);
    assert.equal(state.time, time);
  });
}

test('round manager: countdown admission, full battle queue, placement and reset', () => {
  const cfg = testConfig();
  cfg.lobby = { minPlayers: 1, botFillTo: 1, maxPlayers: 3 };
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const manager = createRoundManager({ bus, state, config: cfg });
  const combat = createCombatSystem({ bus, state, config: cfg });
  const joinPlayer = (id) => bus.emit('cmd:join', { player: { id, name: id } });
  joinPlayer('first');
  manager.update(cfg.phases.durationSec.LOBBY);
  assert.equal(state.phase, 'COUNTDOWN');
  joinPlayer('second');
  joinPlayer('third');
  assert.equal(state.players.get('second').status, 'alive');
  joinPlayer('overflow');
  assert.equal(state.players.has('overflow'), false);
  const alive = [...state.players.values()];
  const radius = Math.min(state.arena.w / 2, state.arena.h / 2, cfg.zone.initialRadius) - cfg.ui.playerRadius;
  for (const player of alive) assert.ok(Math.abs(Math.hypot(player.x - state.arena.cx, player.y - state.arena.cy) - radius) < 1e-8);
  assert.ok(Math.abs(Math.hypot(alive[0].x - alive[1].x, alive[0].y - alive[1].y) - Math.hypot(alive[1].x - alive[2].x, alive[1].y - alive[2].y)) < 1e-8);
  manager.update(cfg.phases.durationSec.COUNTDOWN);
  joinPlayer('queued');
  joinPlayer('queued');
  assert.equal(state.players.size, 4);
  assert.equal(state.players.get('queued').status, 'spectator');
  let result;
  bus.on('round:ended', (event) => { result = event; });
  bus.emit('damage:request', { targetId: 'first', amount: 10000, sourceId: 'second', cause: 'attack' });
  assert.equal(state.players.get('first').placement, 3);
  assert.equal(state.players.get('second').kills, 1);
  assert.equal(state.players.get('second').streak, 0);
  bus.emit('revive:request', { playerId: 'first', byId: 'second' });
  assert.equal(state.players.get('first').placement, 0);
  state.time += cfg.combat.reviveInvulnMs / 1000;
  bus.emit('damage:request', { targetId: 'third', amount: 10000, sourceId: 'second', cause: 'attack' });
  bus.emit('damage:request', { targetId: 'first', amount: 10000, sourceId: 'second', cause: 'zone' });
  manager.update(1 / cfg.tickRate);
  assert.equal(result.winnerId, 'second');
  assert.deepEqual(result.ranking.map((row) => row.playerId), ['second', 'first', 'third']);
  manager.update(cfg.phases.durationSec.RESULT);
  assert.equal(state.phase, 'LOBBY');
  assert.equal(state.players.get('queued').status, 'alive');
  assert.equal([...state.players.values()].filter((player) => player.status === 'alive').length, 3);
  for (const player of state.players.values()) {
    assert.equal(player.hp, player.maxHp);
    assert.equal(player.kills, 0);
    assert.equal(player.placement, 0);
  }
  combat.dispose();
  manager.dispose();
});

test('round manager: early FINAL keeps the total deadline and timeout picks highest HP', () => {
  const cfg = testConfig();
  cfg.phases.finalThresholdAlive = 5;
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const manager = createRoundManager({ bus, state, config: cfg });
  const combat = createCombatSystem({ bus, state, config: cfg });
  for (const id of ['low-first', 'low-second', 'high-last']) bus.emit('cmd:join', { player: { id, name: id } });
  manager.update(cfg.phases.durationSec.LOBBY);
  manager.update(cfg.phases.durationSec.COUNTDOWN);
  const battleStart = state.time;
  for (const id of ['low-first', 'low-second']) {
    const player = state.players.get(id);
    const amount = player.hp - 1;
    bus.emit('damage:request', { targetId: id, amount, sourceId: null, cause: 'zone' });
  }
  let result;
  let endedAt;
  bus.on('round:ended', (event) => { result = event; endedAt = state.time; });
  const step = 1 / cfg.tickRate;
  manager.update(step);
  assert.equal(state.phase, 'FINAL');
  for (let tick = 0; tick < 100 && !result; tick += 1) manager.update(step);
  assert.equal(result.winnerId, 'high-last');
  const duration = cfg.phases.durationSec.BATTLE + cfg.phases.durationSec.FINAL;
  assert.ok(endedAt - battleStart >= duration - 1e-8);
  assert.ok(endedAt - battleStart <= duration + step + 1e-8);
  combat.dispose();
  manager.dispose();
});

test('round manager: empty fallback and a single survivor never stall the stream', () => {
  for (const viewers of [0, 1]) {
    const cfg = testConfig();
    cfg.lobby.botFillTo = 0;
    const state = createState(cfg);
    const bus = createEventBus(cfg);
    const manager = createRoundManager({ bus, state, config: cfg });
    if (viewers) bus.emit('cmd:join', { player: { id: 'solo', name: 'Solo' } });
    manager.update(cfg.phases.durationSec.LOBBY);
    assert.equal(state.players.size, 1);
    manager.update(cfg.phases.durationSec.COUNTDOWN);
    let result;
    bus.on('round:ended', (event) => { result = event; });
    manager.update(1 / cfg.tickRate);
    assert.equal(state.phase, 'RESULT');
    assert.equal(result.winnerId, [...state.players.keys()][0]);
    manager.dispose();
  }
});

test('round manager: simultaneous elimination produces a draw, invalid events are ignored', () => {
  const cfg = testConfig();
  cfg.lobby.botFillTo = 2;
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const manager = createRoundManager({ bus, state, config: cfg });
  const combat = createCombatSystem({ bus, state, config: cfg });
  bus.emit('cmd:join', null);
  bus.emit('cmd:join', { player: { id: '' } });
  manager.update(NaN);
  assert.equal(state.players.size, 0);
  manager.update(cfg.phases.durationSec.LOBBY);
  manager.update(cfg.phases.durationSec.COUNTDOWN);
  let result;
  let count = 0;
  bus.on('round:ended', (event) => { result = event; count += 1; });
  for (const player of state.players.values()) {
    bus.emit('damage:request', { targetId: player.id, amount: 10000, sourceId: null, cause: 'bomb' });
  }
  manager.update(1 / cfg.tickRate);
  assert.equal(result.winnerId, null);
  assert.equal(result.ranking.length, 2);
  manager.update(1 / cfg.tickRate);
  assert.equal(count, 1);
  combat.dispose();
  manager.dispose();
});

test('mock: comment, gift tiers, cứu và lệnh liên minh chạy qua bus', () => {
  const game = createGame();
  const giver = addMockViewer(game, 'viewer-1', 'Ngọc Lan');
  const partner = addMockViewer(game, 'viewer-2', 'Đức Huy');
  game.state.phase = 'BATTLE';
  const effects = [];
  game.bus.on('gift:effect', (event) => effects.push(event));
  giver.hp = 40;
  game.mock.send('live:gift', { userId: giver.id, diamonds: 5, giftName: 'Rose', count: 1 });
  assert.ok(giver.hp > 40);
  game.mock.send('live:gift', { userId: giver.id, diamonds: 50, giftName: 'Corgi', count: 1 });
  assert.ok(giver.shield > 0);
  assert.equal(giver.weaponLevel, 1);
  game.state.phase = 'BATTLE';
  game.mock.send('live:gift', { userId: giver.id, diamonds: 250, giftName: 'Ring', count: 1 });
  assert.equal(game.state.drops.length, game.cfg.gifts.tiers[2].supplyDrops);
  let ultimates = 0;
  game.bus.on('ultimate:fire', () => { ultimates += 1; });
  game.state.phase = 'BATTLE';
  game.mock.send('live:gift', { userId: giver.id, diamonds: 500, giftName: 'Galaxy', count: 1 });
  assert.equal(ultimates, 1);
  assert.ok(partner.hp < partner.maxHp, 'ultimate phải gây sát thương toàn đấu trường');
  game.bus.emit('live:chat', { userId: giver.id, nickname: giver.name, text: 'CỨU Đức Huy' });
  assert.equal(game.state.giftTargets.get(giver.id)?.targetId, partner.id);
  game.bus.emit('live:chat', { userId: giver.id, nickname: giver.name, text: 'HỢP TÁC Đức Huy' });
  assert.equal(giver.allianceId, null);
  game.bus.emit('live:chat', { userId: partner.id, nickname: partner.name, text: 'HỢP TÁC Ngọc Lan' });
  assert.equal(giver.allianceId, partner.id);
  assert.equal(partner.allianceId, giver.id);
  game.state.time = game.cfg.alliance.betrayWaitMs / 1000;
  game.bus.emit('live:chat', { userId: giver.id, nickname: giver.name, text: 'PHẢN BỘI' });
  assert.equal(giver.allianceId, null);
  game.bus.emit('damage:request', { targetId: partner.id, amount: 10000, sourceId: giver.id, cause: 'attack' });
  assert.equal(partner.status, 'dead');
  game.mock.send('live:gift', { userId: giver.id, diamonds: 500, giftName: 'Galaxy', count: 1 });
  assert.equal(partner.status, 'alive');
  assert.ok(partner.hp > 0 && partner.hp < partner.maxHp);
  assert.equal(effects.length, 5);
  game.dispose();
});

test('mock: event boss và combat ghi nhận damage/boss defeat', () => {
  const game = createGame();
  const fighter = addMockViewer(game, 'boss-hunter', 'Thảo');
  addMockViewer(game, 'boss-viewer', 'Nam');
  addMockViewer(game, 'boss-viewer-2', 'Lan');
  addMockViewer(game, 'boss-viewer-3', 'Minh');
  game.state.phase = 'BATTLE';
  let bossDefeated;
  game.bus.on('boss:defeated', (event) => { bossDefeated = event; });
  game.bus.emit('energy:add', { amount: game.cfg.events.energy.triggerThreshold });
  assert.ok(game.state.boss);
  const bossId = game.state.boss.id;
  game.bus.emit('damage:request', { targetId: bossId, amount: 30, sourceId: fighter.id, cause: 'attack' });
  game.bus.emit('damage:request', { targetId: bossId, amount: 30, sourceId: fighter.id, cause: 'attack' });
  assert.equal(game.state.boss, null);
  assert.equal(bossDefeated.topDamagers[0].playerId, fighter.id);
  game.dispose();
});

test('combat: ba mạng liên tiếp gắn bounty và mạng kế tiếp có thể claim', () => {
  const game = createGame();
  const killer = addMockViewer(game, 'streak-killer', 'Killer');
  const victims = ['victim-a', 'victim-b', 'victim-c', 'victim-d'].map((id, index) => addMockViewer(game, id, `Victim ${index}`));
  let bountySet;
  let bountyClaimed;
  game.bus.on('bounty:set', (event) => { bountySet = event; });
  game.bus.on('bounty:claimed', (event) => { bountyClaimed = event; });
  for (const victim of victims.slice(0, 3)) game.bus.emit('damage:request', { targetId: victim.id, amount: 10000, sourceId: killer.id, cause: 'attack' });
  assert.equal(game.state.bountyId, killer.id);
  assert.equal(bountySet.playerId, killer.id);
  game.bus.emit('damage:request', { targetId: killer.id, amount: 10000, sourceId: victims[3].id, cause: 'attack' });
  assert.equal(bountyClaimed.victimId, killer.id);
  assert.equal(bountyClaimed.killerId, victims[3].id);
  game.dispose();
});

test('mock: energy, bão, drop và trap đi đúng event/data flow', () => {
  const cfg = testConfig();
  cfg.events.energy.triggerThreshold = 10;
  cfg.events.list = [{ type: 'storm', weight: 1, durationSec: 10, dps: 10 }];
  const game = createGame(cfg);
  const player = addMockViewer(game, 'event-viewer', 'Hà');
  game.state.phase = 'BATTLE';
  game.cfg.zone.initialRadius = 100;
  player.x = game.state.arena.cx + 150;
  player.y = game.state.arena.cy;
  game.bus.emit('round:phase', { phase: 'BATTLE' });
  let triggered;
  let collected;
  game.bus.on('event:triggered', (event) => { triggered = event; });
  game.bus.on('drop:collected', (event) => { collected = event; });
  game.bus.emit('energy:add', { amount: 10 });
  assert.deepEqual(triggered, { type: 'storm' });
  const startHp = player.hp;
  const eventSystem = game.systems[4];
  for (let tick = 0; tick < 11; tick += 1) { game.state.time += 0.1; eventSystem.update(0.1); game.systems[3].update(0.1); }
  assert.ok(player.hp < startHp);
  eventSystem.spawnDrop(1, player.x, player.y);
  game.systems[5].update(0.05);
  assert.equal(game.state.drops.length, 0);
  assert.equal(collected.playerId, player.id);
  const beforeTrap = player.hp + player.shield;
  game.state.traps.push({ id: 'smoke-trap', x: player.x, y: player.y, kind: 'spike', damage: 20, radius: 50, fuseAt: Infinity });
  eventSystem.update(0.05);
  assert.ok(player.hp + player.shield < beforeTrap);
  game.dispose();
});

test('mock adapter: các live payload bắt buộc đúng kiểu dữ liệu', () => {
  const seen = new Map();
  const mock = createMockAdapter({ onEvent: (type, payload) => seen.set(type, payload) });
  const user = { userId: 'schema-user', uniqueId: 'schema', nickname: 'Schema' };
  for (const type of ['live:chat', 'live:gift', 'live:like', 'live:join', 'live:follow', 'live:share']) {
    mock.send(type, { ...user, text: 'đánh', giftName: 'Rose', diamonds: 5, count: 1, likeCount: 2, totalLikeCount: 4 });
  }
  const schema = {
    'live:chat': { userId: 'string', uniqueId: 'string', nickname: 'string', avatarUrl: 'string', text: 'string' },
    'live:gift': { userId: 'string', uniqueId: 'string', nickname: 'string', avatarUrl: 'string', giftId: 'number', giftName: 'string', diamonds: 'number', count: 'number' },
    'live:like': { userId: 'string', nickname: 'string', likeCount: 'number', totalLikeCount: 'number' },
    'live:join': { userId: 'string', uniqueId: 'string', nickname: 'string', avatarUrl: 'string' },
    'live:follow': { userId: 'string', uniqueId: 'string', nickname: 'string' },
    'live:share': { userId: 'string', uniqueId: 'string', nickname: 'string' },
  };
  for (const [type, fields] of Object.entries(schema)) {
    const payload = seen.get(type);
    assert.ok(payload, `${type} missing`);
    for (const [field, fieldType] of Object.entries(fields)) assert.equal(typeof payload[field], fieldType, `${type}.${field}`);
  }
});

test('wsClient: backend resolution distinguishes static preview from game server', async () => {
  const cfg = testConfig();
  const preview = new URL('http://localhost:5501/index.html');
  const staticResponse = async () => ({ ok: true, json: async () => { throw new SyntaxError('HTML is not JSON'); } });
  assert.equal((await resolveBackendUrl({ location: preview, config: cfg, fetchImpl: staticResponse })).origin, 'http://localhost:3000');
  const backend = new URL('http://localhost:3100/');
  const healthResponse = async () => ({ ok: true, json: async () => ({ ok: true, mock: true, clients: 2 }) });
  assert.equal((await resolveBackendUrl({ location: backend, config: cfg, fetchImpl: healthResponse })).origin, backend.origin);
  const override = new URL('http://localhost:5501/?server=http://localhost:3200');
  assert.equal((await resolveBackendUrl({ location: override, config: cfg, fetchImpl: () => { throw new Error('Override must skip probe'); } })).origin, 'http://localhost:3200');
  assert.equal((await resolveBackendUrl({ location: preview, config: cfg, fetchImpl: async () => { throw new Error('Offline'); } })).origin, 'http://localhost:3000');
});

test('wsClient local: live:status khớp schema và timer dừng khi dispose', async () => {
  const cfg = testConfig();
  cfg.net.local.joinIntervalMs = 1;
  cfg.net.local.eventIntervalMs = 1;
  const bus = createEventBus(cfg);
  const statuses = [];
  let joins = 0;
  bus.on('live:status', (status) => statuses.push(status));
  bus.on('live:join', () => { joins += 1; });
  const client = createWsClient({ bus, config: cfg, local: true });
  client.connect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.dispose();
  assert.equal(statuses[0].connected, true);
  assert.equal('force' in statuses[0], false);
  assert.ok(joins > 0);
  bus.clear();
});

test('wsClient: tự kết nối lại sau khi socket bị ngắt', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let connections = 0;
  wss.on('connection', (socket) => {
    connections += 1;
    socket.send(JSON.stringify({ type: 'live:status', payload: { connected: true, roomId: 'test' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cfg = testConfig();
  cfg.net.reconnectMinMs = 20;
  cfg.net.reconnectMaxMs = 20;
  cfg.net.backoffFactor = 1;
  const bus = createEventBus(cfg);
  const statuses = [];
  bus.on('live:status', (status) => statuses.push(status));
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  const client = createWsClient({ bus, config: cfg, url: `ws://127.0.0.1:${server.address().port}/ws`, local: false });
  const waitUntil = async (predicate) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), 'condition timed out');
  };
  try {
    client.connect();
    await waitUntil(() => statuses.some((status) => status.connected));
    for (const socket of wss.clients) socket.terminate();
    await waitUntil(() => statuses.some((status) => !status.connected));
    await waitUntil(() => connections >= 2 && statuses.filter((status) => status.connected).length >= 2);
  } finally {
    client.dispose();
    globalThis.WebSocket = previousWebSocket;
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    bus.clear();
  }
});

test('mock stress: 50 người vào và spam comment không vượt maxPlayers', () => {
  const game = createGame();
  for (let index = 0; index < 50; index += 1) game.bus.emit('live:join', { userId: `u${index}`, nickname: `User ${index}` });
  for (let index = 0; index < 1000; index += 1) game.bus.emit('live:chat', { userId: `u${index % 50}`, nickname: `User ${index % 50}`, text: 'đánh' });
  assert.equal(game.state.players.size, game.cfg.lobby.maxPlayers);
  game.dispose();
});

test('leaderboard: kết quả được tổng hợp và chống ghi trùng', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arena-leaderboard-'));
  const store = createLeaderboardStore({ filePath: join(directory, 'leaderboard.json') });
  try {
  const sessionId = `smoke-${Date.now()}`;
  const result = { sessionId, roundId: 1, winnerId: 'smoke-player', ranking: [{ playerId: 'smoke-player', name: 'Smoke', kills: 2, damage: 80, placement: 1 }] };
  const first = await store.addRoundResult(result);
  const duplicate = await store.addRoundResult(result);
  const rows = await store.getTop();
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(rows.find((row) => row.userId === 'smoke-player')?.wins, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
