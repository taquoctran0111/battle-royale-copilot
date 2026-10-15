import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import config from '../client/core/config.js';
import { createState, getAlive } from '../client/core/gameState.js';
import { createEventBus } from '../client/core/eventBus.js';
import { eventCatalog, validateEventPayload } from '../client/core/eventCatalog.js';
import { createInputRouter } from '../client/input/inputRouter.js';
import { createRoundManager } from '../client/systems/roundManager.js';
import { createMovementSystem } from '../client/systems/movementSystem.js';
import { createCombatSystem } from '../client/systems/combatSystem.js';
import { createZoneSystem } from '../client/systems/zoneSystem.js';
import { createEventSystem } from '../client/systems/eventSystem.js';
import { createAllianceSystem } from '../client/systems/allianceSystem.js';
import { createGiftEffectSystem } from '../client/systems/giftEffectSystem.js';
import { createEffects } from '../client/render/effects.js';
import { createMockAdapter } from '../server/mockAdapter.js';
import { createLeaderboardClient } from '../client/net/leaderboardClient.js';
import { createLeaderboardStore } from '../server/leaderboardStore.js';
import { createWsClient } from '../client/net/wsClient.js';

function game(overrides = {}) {
  const cfg = structuredClone(config);
  cfg.phases.durationSec.LOBBY = 1;
  cfg.phases.durationSec.COUNTDOWN = 0.2;
  cfg.phases.durationSec.RESULT = 0.2;
  cfg.events.intervalSec = [10000, 10000];
  cfg.events.trapSpawnSec = [10000, 10000];
  cfg.alliance.betrayWaitMs = 100;
  Object.assign(cfg, overrides);
  const state = createState(cfg);
  const base = createEventBus(cfg);
  const counts = new Map();
  const phases = [];
  const errors = [];
  const bus = { ...base, on(type, listener) {
    return base.on(type, (payload) => {
      try { return listener(payload); }
      catch (error) { errors.push(`${type}: listener failed: ${error.message}`); }
    });
  }, emit(type, payload) {
    const issues = validateEventPayload(type, payload);
    errors.push(...issues);
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (type === 'round:phase') phases.push(`${payload.roundId}:${payload.phase}`);
    return base.emit(type, payload);
  } };
  const input = createInputRouter({ bus, state, config: cfg });
  const round = createRoundManager({ bus, state, config: cfg });
  const movement = createMovementSystem({ bus, state, config: cfg });
  const combat = createCombatSystem({ bus, state, config: cfg });
  const zone = createZoneSystem({ bus, state, config: cfg });
  const events = createEventSystem({ bus, state, config: cfg });
  const alliance = createAllianceSystem({ bus, state, config: cfg });
  const gifts = createGiftEffectSystem({ bus, state, config: cfg });
  const systems = [round, gifts, alliance, zone, events, movement, combat];
  const effects = createEffects({ bus, state, config: cfg });
  const mock = createMockAdapter({ onEvent: (type, payload) => bus.emit(type, payload), onStatus: (payload) => bus.emit('live:status', payload), intensity: 'low' });
  const resources = () => ({ listeners: [...eventCatalog].reduce((sum, type) => sum + bus.listenerCount(type), 0), particles: effects.particleCount, drops: state.drops.length, traps: state.traps.length, players: state.players.size });
  return { cfg, state, bus, mock, phases, errors, counts, effects, resources,
    tick(ticks = 1) { for (let index = 0; index < ticks; index += 1) { input.update(); systems.forEach((system) => system.update(1 / cfg.tickRate)); effects.update(1 / cfg.tickRate); } },
    until(predicate, seconds = Object.values(cfg.phases.durationSec).reduce((sum, duration) => sum + duration, 0) + 1) { for (let tick = 0; tick < seconds * cfg.tickRate && !predicate(); tick += 1) this.tick(); assert.ok(predicate(), `Timed out in ${state.phase}`); },
    dispose() { effects.dispose(); systems.reverse().forEach((system) => system.dispose()); input.dispose(); assert.deepEqual(errors, [], 'runtime payload contract'); bus.clear(); },
  };
}

const directory = await mkdtemp(join(tmpdir(), 'arena-e2e-'));
const realtime = process.argv.includes('--realtime');
try {
  const store = createLeaderboardStore({ filePath: join(directory, 'leaderboard.json') });
  const bots = game();
  try {
    const roundSeconds = Object.values(bots.cfg.phases.durationSec).reduce((sum, duration) => sum + duration, 0) + 1;
    bots.until(() => bots.state.roundId >= 6 && bots.state.phase === 'LOBBY', roundSeconds * 5);
    assert.equal(bots.counts.get('round:ended'), 5);
    assert.deepEqual(bots.errors, []);
    console.info('[PASS] 5 bot-only rounds:', bots.phases.join(' -> '));
  } finally { bots.dispose(); }

  const match = game();
  const writes = [];
  const client = createLeaderboardClient({ bus: match.bus, state: match.state, config: match.cfg, serverUrl: 'http://mock.test', fetchImpl: async (_url, request) => {
    const write = store.addRoundResult(JSON.parse(request.body));
    writes.push(write); await write;
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  try {
    for (let index = 0; index < 50; index += 1) match.mock.send('live:join', { userId: `viewer-${index}`, nickname: `Viewer ${index}` });
    assert.equal(match.state.players.size, match.cfg.lobby.maxPlayers);
    for (let index = 0; index < 1000; index += 1) match.mock.send('live:chat', { userId: `viewer-${index % 50}`, text: 'NÉ' });
    match.until(() => match.state.phase === 'BATTLE');
    let giver = getAlive(match.state)[0];
    const sendGift = (diamonds) => match.mock.send('live:gift', { userId: giver.id, nickname: giver.name, diamonds, giftName: `Gift ${diamonds}`, count: 1 });
    sendGift(5); sendGift(50); sendGift(250); sendGift(500);
    assert.ok(giver.buffs.some((buff) => buff.type === 'speed'));
    assert.ok(giver.weaponLevel > 0);
    assert.ok(match.counts.get('drop:spawned') > 0);
    assert.ok(match.counts.get('ultimate:fire') > 0);
    match.tick(match.cfg.tickRate * 3);
    giver = getAlive(match.state).sort((a, b) => b.streak - a.streak)[0];
    const partner = getAlive(match.state).find((player) => player.id !== giver.id);
    for (const player of [giver, partner]) match.bus.emit('heal:request', { targetId: player.id, sourceId: null, amount: player.maxHp });
    match.mock.send('live:chat', { userId: giver.id, text: `HỢP TÁC ${partner.name}` });
    match.mock.send('live:chat', { userId: partner.id, text: `HỢP TÁC ${giver.name}` });
    assert.equal(giver.allianceId, partner.id);
    match.tick(4);
    match.mock.send('live:chat', { userId: giver.id, text: 'PHẢN BỘI' });
    assert.ok(match.counts.get('ally:betrayed') > 0);
    assert.equal(giver.allianceId, null);
    for (const victim of getAlive(match.state).filter((player) => player.id !== giver.id).slice(0, 3)) match.bus.emit('damage:request', { targetId: victim.id, sourceId: giver.id, amount: 10000, cause: 'attack' });
    assert.equal(match.state.bountyId, giver.id);
    const hunter = getAlive(match.state).find((player) => player.id !== giver.id);
    match.bus.emit('damage:request', { targetId: giver.id, sourceId: hunter.id, amount: 10000, cause: 'zone' });
    assert.ok(match.counts.get('bounty:claimed') > 0);
    match.mock.send('live:chat', { userId: hunter.id, text: `CỨU ${giver.name}` });
    match.mock.send('live:gift', { userId: hunter.id, diamonds: 500, giftName: 'Revive', count: 1 });
    assert.equal(giver.status, 'alive');
    match.cfg.events.list = [{ ...config.events.list.find((event) => event.type === 'boss'), weight: 1 }];
    match.bus.emit('energy:add', { amount: match.state.energy.max });
    assert.ok(match.state.boss);
    match.bus.emit('damage:request', { targetId: match.state.boss.id, amount: 10000, sourceId: hunter.id, cause: 'attack' });
    assert.ok(match.counts.get('boss:defeated') > 0);
    match.cfg.events.list = [{ ...config.events.list.find((event) => event.type === 'storm'), weight: 1 }];
    match.bus.emit('energy:add', { amount: match.state.energy.max });
    assert.ok(match.counts.get('event:triggered') >= 2);
    match.until(() => Boolean(match.counts.get('round:ended')));
    await Promise.all(writes);
    assert.ok((await store.getTop({ period: 'all' })).length > 0);
    assert.deepEqual(match.errors, []);
    console.info('[PASS] 50 viewers + 1000 comments; tiers, ally/betray, bounty/claim, revive, boss/storm/drop/ultimate; leaderboard saved');
  } finally { client.dispose(); match.dispose(); }

  const soak = game({ events: structuredClone(config.events) });
  try {
    const baseline = soak.resources().listeners;
    const battleSeconds = soak.cfg.phases.durationSec.BATTLE + soak.cfg.phases.durationSec.FINAL;
    const maxBombs = Math.max(...soak.cfg.events.list.map((event) => event.bombs ?? event.count ?? 0));
    const trapBound = Math.ceil(battleSeconds / soak.cfg.events.trapSpawnSec[0]) + Math.ceil(battleSeconds / soak.cfg.events.intervalSec[0]) * maxBombs;
    const max = { particles: 0, drops: 0, traps: 0, players: 0 };
    const started = performance.now();
    const heapSamples = [];
    for (let tick = 0; tick < 1800 * soak.cfg.tickRate; tick += 1) {
      if (realtime) {
        const remaining = (tick + 1) * 1000 / soak.cfg.tickRate - (performance.now() - started);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      soak.tick();
      const resource = soak.resources();
      for (const key of Object.keys(max)) max[key] = Math.max(max[key], resource[key]);
      assert.ok(resource.particles <= soak.cfg.ui.maxParticles);
      assert.ok(resource.players <= soak.cfg.lobby.maxPlayers);
      assert.ok(resource.traps <= trapBound);
      assert.ok(resource.drops <= Math.ceil(soak.cfg.events.dropLifetimeMs / (soak.cfg.events.dropSpawnSec[0] * 1000)) + 1);
      if (realtime && tick % (300 * soak.cfg.tickRate) === 0) {
        globalThis.gc?.();
        heapSamples.push({ simulatedSeconds: tick / soak.cfg.tickRate, heapBytes: process.memoryUsage().heapUsed });
        console.info('[SOAK]', JSON.stringify(heapSamples.at(-1)));
      }
    }
    const after = soak.resources().listeners;
    assert.equal(after, baseline);
    assert.ok(soak.counts.get('round:ended') >= 5);
    assert.deepEqual(soak.errors, []);
    console.info(`[PASS] ${realtime ? 'real-time' : 'accelerated'} 30-minute soak:`, JSON.stringify({ rounds: soak.counts.get('round:ended'), listeners: after, max, heapSamples }));
  } finally { soak.dispose(); }

  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  const network = game();
  network.cfg.net.reconnectMinMs = 10;
  network.cfg.net.reconnectMaxMs = 50;
  let server, sockets, port;
  const start = async () => { server = createServer(); sockets = new WebSocketServer({ server }); await new Promise((resolve) => server.listen(port ?? 0, '127.0.0.1', resolve)); port = server.address().port; };
  const stop = async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise((resolve) => sockets.close(resolve)); await new Promise((resolve) => server.close(resolve)); };
  const waitStatus = (connected) => new Promise((resolve, reject) => { const off = network.bus.on('live:status', (event) => { if (event.connected === connected) { clearTimeout(timeout); off(); resolve(); } }); const timeout = setTimeout(() => { off(); reject(new Error('WebSocket reconnect timeout')); }, 3000); });
  let ws;
  try {
    await start();
    ws = createWsClient({ bus: network.bus, config: network.cfg, local: false, url: `ws://127.0.0.1:${port}/ws` });
    const connected = waitStatus(true); ws.connect(); await connected;
    const offline = waitStatus(false); await stop(); await offline;
    network.tick(network.cfg.tickRate * 2);
    assert.ok(network.state.time > 0 && network.state.players.size > 0);
    const online = waitStatus(true); await start(); await online;
    console.info('[PASS] WebSocket offline -> reconnect; bot round continues while disconnected');
  } finally { ws?.dispose(); if (server?.listening) await stop(); network.dispose(); if (originalWebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = originalWebSocket; }
  console.info(`[NOTE] ${realtime ? 'Soak ran in Node in real time.' : 'Soak is simulated time.'} This is not a 30-minute browser heap/FPS measurement; run browser/OBS checks separately.`);
} finally { await rm(directory, { recursive: true, force: true }); }