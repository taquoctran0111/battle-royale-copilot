import { createBot, createPlayer } from '../entities/playerFactory.js';
import { getAlive, resetRound } from '../core/gameState.js';

export function createRoundManager({ bus, state, config }) {
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
    state.phase = phase;
    phaseElapsed = 0;
    if (phase === 'BATTLE') battleElapsed = 0;
    const remaining = phase === 'FINAL' ? Math.max(0, battleDuration - battleElapsed) : durations[phase];
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

  function finishRound() {
    if (ended || state.phase === 'RESULT') return;
    ended = true;
    const alive = getAlive(state).sort((a, b) => b.hp - a.hp || b.kills - a.kills || b.damageDealt - a.damageDealt || a.id.localeCompare(b.id));
    const results = ranking(alive);
    setPhase('RESULT');
    bus.emit('round:ended', { roundId: state.roundId, winnerId: alive[0]?.id ?? null, ranking: results });
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
    if (state.players.has(id)) return;
    const entering = state.phase === 'LOBBY' || state.phase === 'COUNTDOWN';
    if (entering && getAlive(state).length >= config.lobby.maxPlayers) return;
    const player = createPlayer({ ...info, id }, state, config);
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

  function nextRound() {
    const queued = [...state.players.values()].filter((player) => player.status === 'spectator' && !player.isBot);
    const returning = [...state.players.values()].filter((player) => player.status !== 'spectator' && !player.isBot);
    const admitted = new Set([...queued, ...returning].slice(0, config.lobby.maxPlayers).map((player) => player.id));
    resetRound(state, { keepPlayers: true });
    for (const player of state.players.values()) {
      if (!admitted.has(player.id)) player.status = 'spectator';
    }
    eliminated.length = 0;
    ended = false;
    battleElapsed = 0;
    state.roundId += 1;
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
      setPhase('BATTLE');
      return;
    }
    if (state.phase === 'BATTLE') {
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
