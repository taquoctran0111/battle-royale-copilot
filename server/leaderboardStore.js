import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import config from '../client/core/config.js';

const queues = new Map();
const periods = ['day', 'week', 'all'];
const metrics = ['wins', 'kills', 'giftValue'];
const fields = ['wins', 'kills', 'damage', 'giftValue', 'rounds'];
const root = fileURLToPath(new URL('../', import.meta.url));
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

function invalid(message) { const error = new Error(message); error.status = 400; throw error; }
function number(value, name, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) invalid(`Invalid ${name}`);
  return value;
}
function string(value, name, limit, empty = false) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) invalid(`Invalid ${name}`);
  return value;
}

export function validateRoundResult(input, options = config.leaderboard) {
  const entry = Array.isArray(input) ? { ranking: input } : input;
  if (!record(entry) || !Array.isArray(entry.ranking) || entry.ranking.length > options.maxRankingRows) invalid('Invalid ranking');
  if (entry.roundId !== undefined) number(entry.roundId, 'roundId', true);
  if (entry.sessionId !== undefined) string(entry.sessionId, 'sessionId', options.maxIdLength);
  const ids = new Set();
  const placements = new Set();
  const ranking = entry.ranking.map((row) => {
    if (!record(row)) invalid('Invalid ranking row');
    const playerId = string(row.playerId ?? row.userId, 'playerId', options.maxIdLength);
    if (ids.has(playerId)) invalid('Duplicate playerId');
    ids.add(playerId);
    const placement = number(row.placement, 'placement', true);
    if (!placement || placement > entry.ranking.length || placements.has(placement)) invalid('Invalid placement');
    placements.add(placement);
    return {
      playerId, placement,
      name: string(row.name ?? playerId, 'name', options.maxNameLength),
      avatar: string(row.avatar ?? '', 'avatar', options.maxAvatarLength, true),
      kills: number(row.kills ?? 0, 'kills', true),
      damage: number(row.damage ?? 0, 'damage'),
      giftValue: number(row.giftValue ?? 0, 'giftValue'),
    };
  });
  const winnerId = entry.winnerId === undefined ? ranking.find((row) => row.placement === 1)?.playerId ?? null : entry.winnerId;
  if (winnerId !== null && (!ids.has(winnerId) || typeof winnerId !== 'string')) invalid('Invalid winnerId');
  if (winnerId && ranking.find((row) => row.playerId === winnerId).placement !== 1) invalid('Winner must be first');
  return { roundId: entry.roundId, sessionId: entry.sessionId, winnerId, ranking };
}

export function validateTopQuery({ period = config.leaderboard.defaultPeriod, metric = config.leaderboard.defaultMetric, limit = config.leaderboard.defaultLimit } = {}) {
  if (!periods.includes(period) || !metrics.includes(metric)) invalid('Invalid period or metric');
  if (typeof limit !== 'number' && (typeof limit !== 'string' || !/^\d+$/.test(limit))) invalid('Invalid limit');
  limit = Number(limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.leaderboard.maxLimit) invalid('Invalid limit');
  return { period, metric, limit };
}

function periodKeys(time) {
  const date = new Date(time);
  const day = date.toISOString().slice(0, 10);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return { day, week: date.toISOString().slice(0, 10) };
}

export function createLeaderboardStore({ filePath = path.resolve(root, config.leaderboard.filePath), now = () => Date.now(), options = config.leaderboard } = {}) {
  filePath = path.resolve(filePath);

  function locked(task) {
    const previous = queues.get(filePath) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => {}, () => {});
    queues.set(filePath, tail);
    void tail.then(() => { if (queues.get(filePath) === tail) queues.delete(filePath); });
    return result;
  }

  async function load(time) {
    const keys = periodKeys(time);
    try {
      const data = JSON.parse(await readFile(filePath, 'utf8'));
      if (data.version !== 1 || !record(data.all) || !record(data.day?.players) || !record(data.week?.players) || !Array.isArray(data.processedRounds) || !data.processedRounds.every((key) => typeof key === 'string')) throw new Error('Invalid leaderboard file schema');
      for (const bucket of [data.all, data.day.players, data.week.players]) {
        for (const [id, player] of Object.entries(bucket)) {
          if (!record(player) || id !== player.userId || id.startsWith('bot_') || typeof player.name !== 'string' || typeof player.avatar !== 'string' || !Number.isFinite(Date.parse(player.lastSeen)) || fields.some((field) => typeof player[field] !== 'number' || !Number.isFinite(player[field]) || player[field] < 0)) throw new Error('Invalid leaderboard player');
        }
      }
      return data;
    } catch (error) {
      if (error.code !== 'ENOENT') { error.status = 500; throw error; }
      return { version: 1, all: {}, day: { key: keys.day, players: {} }, week: { key: keys.week, players: {} }, processedRounds: [] };
    }
  }

  function rollover(data, time) {
    const keys = periodKeys(time);
    let changed = false;
    for (const period of ['day', 'week']) {
      if (data[period].key !== keys[period]) { data[period] = { key: keys[period], players: {} }; changed = true; }
    }
    return changed;
  }

  async function save(data) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx');
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, filePath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function addRoundResult(input) {
    const entry = validateRoundResult(input, options);
    return locked(async () => {
      const time = now();
      const data = await load(time);
      const changed = rollover(data, time);
      const key = entry.roundId === undefined ? null : entry.sessionId ? `${entry.sessionId}:${entry.roundId}` : createHash('sha256').update(JSON.stringify(entry)).digest('hex');
      if (key && data.processedRounds.includes(key)) { if (changed) await save(data); return { ok: true, duplicate: true }; }
      const ranking = entry.ranking.filter((row) => !row.playerId.startsWith('bot_'));
      for (const row of ranking) {
        for (const bucket of [data.all, data.day.players, data.week.players]) {
          const current = Object.hasOwn(bucket, row.playerId) ? bucket[row.playerId] : { userId: row.playerId, name: row.name, avatar: row.avatar, wins: 0, kills: 0, damage: 0, giftValue: 0, rounds: 0 };
          const player = { ...current, name: row.name, avatar: row.avatar, lastSeen: new Date(time).toISOString() };
          player.wins += Number(row.playerId === entry.winnerId);
          player.kills += row.kills; player.damage += row.damage; player.giftValue += row.giftValue; player.rounds += 1;
          for (const field of fields) number(player[field], `total ${field}`);
          Object.defineProperty(bucket, row.playerId, { value: player, enumerable: true, writable: true, configurable: true });
        }
      }
      if (key) data.processedRounds = [...data.processedRounds, key].slice(-options.maxProcessedRounds);
      await save(data);
      return { ok: true, duplicate: false, players: ranking.length };
    });
  }

  async function getTop(query = {}) {
    const { period, metric, limit } = validateTopQuery(query);
    return locked(async () => {
      const time = now();
      const data = await load(time);
      if (rollover(data, time)) await save(data);
      const bucket = period === 'all' ? data.all : data[period].players;
      return Object.values(bucket).sort((a, b) => b[metric] - a[metric] || b.wins - a.wins || b.kills - a.kills || b.damage - a.damage || a.userId.localeCompare(b.userId)).slice(0, limit).map((player) => ({ ...player }));
    });
  }

  return { addRoundResult, getTop };
}

const store = createLeaderboardStore({ filePath: path.resolve(root, process.env.LEADERBOARD_FILE || config.leaderboard.filePath) });
export const addRoundResult = (ranking) => store.addRoundResult(ranking);
export const getTop = (query) => store.getTop(query);
export const addLeaderboardEntry = addRoundResult;
export const getLeaderboard = getTop;
