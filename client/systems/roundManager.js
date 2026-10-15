import { applyClassStats, createBot, createPlayer } from '../entities/playerFactory.js';
import { getAlive, resetRound } from '../core/gameState.js';

export function createRoundManager({ bus, state, config, rng = Math.random }) {
  const off = [];
  let phaseElapsed = 0;
  let battleElapsed = 0;
  let elapsed = 0;
  let disposed = false;
  let ended = false;
  let epoch = Date.now();
  const eliminated = [];
  const durations = config.phases.durationSec;
  const battleDuration = durations.BATTLE + durations.FINAL;

  function setPhase(phase) {
    if (phase === 'LOBBY' || phase === 'BATTLE') state.mode = state.roundId % config.bosses.raidEvery === 0 ? 'raid' : 'battle';
    state.phase = phase;
    phaseElapsed = 0;
    if (phase === 'BATTLE') battleElapsed = 0;
    const remaining = state.mode === 'raid' && phase === 'BATTLE' ? config.bosses.raidDurationSec :
      phase === 'FINAL' ? Math.max(0, battleDuration - battleElapsed) : durations[phase];
    state.phaseEndsAt = epoch + (elapsed + remaining) * 1000;
    bus.emit('round:phase', { roundId: state.roundId, phase, endsAt: state.phaseEndsAt });
  }

  function positionPlayers() {
    const players = getAlive(state);
    const radius = Math.max(0, Math.min(config.zone.initialRadius, state.arena.w / 2, state.arena.h / 2) - config.ui.playerRadius);
    players.forEach((player, index) => {
      const angle = index * Math.PI * 2 / players.length;
      player.x = player.prevX = state.arena.cx + Math.cos(angle) * radius;
      player.y = player.prevY = state.arena.cy + Math.sin(angle) * radius;
      player.facing = angle + Math.PI;
    });
  }

  function scatterPlayers() {
    const placed = [];
    const margin = config.ui.playerRadius;
    const radius = Math.max(0, Math.min(config.zone.initialRadius - margin, Math.hypot(state.arena.w, state.arena.h)));
    const minX = Math.min(margin, state.arena.w / 2);
    const minY = Math.min(margin, state.arena.h / 2);
    for (const player of getAlive(state)) {
      let best = { x: state.arena.cx, y: state.arena.cy }, bestDistance = -1;
      for (let attempt = 0; attempt < config.spawn.attempts; attempt++) {
        const x = minX + rng() * (state.arena.w - minX * 2);
        const y = minY + rng() * (state.arena.h - minY * 2);
        if (Math.hypot(x - state.arena.cx, y - state.arena.cy) > radius) continue;
        const distance = placed.reduce((min, point) => Math.min(min, Math.hypot(x - point.x, y - point.y)), Infinity);
        if (distance > bestDistance) { best = { x, y }; bestDistance = distance; }
        if (distance >= config.spawn.minDistance) break;
      }
      player.x = player.prevX = best.x;
      player.y = player.prevY = best.y;
      player.vx = player.vy = 0;
      player.facing = rng() * Math.PI * 2;
      placed.push(best);
    }
  }

  function fillBots() {
    const target = Math.min(config.lobby.maxPlayers, Math.max(1, config.lobby.botFillTo));
    while (getAlive(state).length < target) {
      const player = createBot(config, state);
      if (state.players.has(player.id)) continue;
      state.players.set(player.id, player);
      positionPlayers();
      bus.emit('player:joined', { playerId: player.id });
    }
  }

  function ranking(alive) {
    const dead = eliminated.slice().reverse().map((id) => state.players.get(id)).filter((player) => player?.status === 'dead');
    const otherDead = [...state.players.values()].filter((player) => player.status === 'dead' && !eliminated.includes(player.id));
    return [...alive, ...dead, ...otherDead]
      .map((player, index) => {
        player.placement = index + 1;
        return { playerId: player.id, name: player.name, kills: player.kills, damage: player.damageDealt, placement: player.placement };
      });
  }

  function finishRound(raidWinnerId = null) {
    if (ended || state.phase === 'RESULT') return;
    ended = true;
    const alive = getAlive(state).sort((a, b) => b.hp - a.hp || b.kills - a.kills || b.damageDealt - a.damageDealt || a.id.localeCompare(b.id));
    let results = ranking(alive);
    if (state.mode === 'raid') {
      const winner = state.players.get(String(raidWinnerId));
      if (winner) {
        results = results.filter((row) => row.playerId !== winner.id);
        results.unshift({ playerId: winner.id, name: winner.name, kills: winner.kills, damage: winner.damageDealt });
      }
      results.forEach((row, index) => { row.placement = index + 1; state.players.get(row.playerId).placement = index + 1; });
    }
    setPhase('RESULT');
    bus.emit('round:ended', { roundId: state.roundId, winnerId: state.mode === 'raid' ? raidWinnerId : alive[0]?.id ?? null, ranking: results });
  }

  function startRound() {
    fillBots();
    ended = false;
    setPhase('COUNTDOWN');
  }

  off.push(bus.on('cmd:join', (payload) => {
    const info = payload?.player;
    if (info?.id === undefined || info.id === null || String(info.id).trim() === '') return;
    const id = String(info.id);
    if (info.classId !== undefined && (!config.classOrder.includes(info.classId) || !config.classes[info.classId])) {
      console.warn('[round] Invalid join class:', info.classId);
      return;
    }
    const entering = state.phase === 'LOBBY' || state.phase === 'COUNTDOWN';
    const existing = state.players.get(id);
    if (existing) {
      if (entering && existing.status === 'alive' && info.classId && existing.classId !== info.classId) {
        existing.classId = info.classId;
        applyClassStats(existing, config, state.roundId);
      }
      return;
    }
    if (entering && getAlive(state).length >= config.lobby.maxPlayers) return;
    const player = createPlayer({ ...info, id }, state, config, info.classId);
    if (!entering) player.status = 'spectator';
    state.players.set(id, player);
    if (entering) positionPlayers();
    bus.emit('player:joined', { playerId: id });
  }));

  off.push(bus.on('player:killed', (payload) => {
    if (state.phase !== 'BATTLE' && state.phase !== 'FINAL') return;
    const victim = state.players.get(String(payload?.victimId));
    if (!victim || victim.status !== 'dead' || eliminated.includes(victim.id)) return;
    victim.placement = getAlive(state).length + 1;
    eliminated.push(victim.id);
  }));
  off.push(bus.on('player:revived', (payload) => {
    const player = state.players.get(String(payload?.playerId));
    if (!player || player.status !== 'alive' || ended) return;
    const index = eliminated.indexOf(player.id);
    if (index !== -1) eliminated.splice(index, 1);
    player.placement = 0;
  }));
  off.push(bus.on('boss:defeated', (payload) => {
    if (state.mode !== 'raid' || ended || (state.phase !== 'BATTLE' && state.phase !== 'FINAL')) return;
    const winner = state.players.get(String(payload?.killerId));
    state.raidOutcome = winner ? 'victory' : 'defeat';
    if (winner) state.nextRoundReward = { playerId: winner.id, roundId: state.roundId + 1 };
    finishRound(winner?.id ?? null);
  }));

  function nextRound() {
    const reward = state.nextRoundReward;
    const rewarded = reward && state.players.get(reward.playerId);
    if (rewarded) rewarded.bossSlayerRound = reward.roundId;
    const queued = [...state.players.values()].filter((player) => player.status === 'spectator' && !player.isBot);
    const returning = [...state.players.values()].filter((player) => player.status !== 'spectator' && !player.isBot);
    const candidates = new Map([...(rewarded ? [rewarded] : []), ...queued, ...returning].map((player) => [player.id, player]));
    const admitted = new Set([...candidates.keys()].slice(0, config.lobby.maxPlayers));
    resetRound(state, { keepPlayers: true });
    for (const player of state.players.values()) {
      if (!admitted.has(player.id)) player.status = 'spectator';
    }
    eliminated.length = 0;
    ended = false;
    battleElapsed = 0;
    state.roundId += 1;
    for (const player of state.players.values()) applyClassStats(player, config, state.roundId);
    positionPlayers();
    setPhase('LOBBY');
  }

  state.roundId = Math.max(1, state.roundId);
  setPhase('LOBBY');

  function update(dt) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    const drift = Date.now() - (epoch + (elapsed + dt) * 1000);
    if (drift > config.runtime.clockDriftToleranceMs) {
      epoch += drift;
      state.phaseEndsAt += drift;
    }
    state.time += dt;
    elapsed += dt;
    phaseElapsed += dt;
    if (state.phase === 'BATTLE' || state.phase === 'FINAL') battleElapsed += dt;
    const aliveCount = getAlive(state).length;

    if (state.phase === 'LOBBY') {
      if (phaseElapsed >= durations.LOBBY) startRound();
      return;
    }
    if (state.phase === 'COUNTDOWN' && phaseElapsed >= durations.COUNTDOWN) {
      scatterPlayers();
      setPhase('BATTLE');
      return;
    }
    if (state.phase === 'BATTLE') {
      if (state.mode === 'raid') {
        if (aliveCount === 0 || battleElapsed >= config.bosses.raidDurationSec) {
          state.raidOutcome = 'defeat';
          state.boss = null;
          finishRound();
        }
        return;
      }
      if (aliveCount <= 1 || battleElapsed >= battleDuration) finishRound();
      else if (aliveCount <= config.phases.finalThresholdAlive || phaseElapsed >= durations.BATTLE) setPhase('FINAL');
      return;
    }
    if (state.phase === 'FINAL') {
      if (aliveCount <= 1 || battleElapsed >= battleDuration) finishRound();
      return;
    }
    if (state.phase === 'RESULT' && phaseElapsed >= durations.RESULT) {
      nextRound();
    }
  }

  return { update, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); eliminated.length = 0; } };
}
