import { getClass, pickClassId } from './classes.js';
import { pick } from '../core/utils.js';

const botSequences = new WeakMap();

export function createPlayer({ id, name, avatar = '', isBot = false }, stateOrConfig, legacyConfig, classId) {
  const config = legacyConfig ?? stateOrConfig;
  const state = legacyConfig ? stateOrConfig : null;
  const chosenClassId = classId ?? pickClassId(config, Math.random, state?.players.values());
  const base = getClass(config, chosenClassId);
  const cx = state?.arena.cx ?? config.arena.w / 2;
  const cy = state?.arena.cy ?? config.arena.h / 2;
  return {
    id: String(id), name: String(name || id), avatar: String(avatar || ''), isBot: Boolean(isBot || String(id).startsWith('bot_')), classId: chosenClassId,
    x: cx, y: cy,
    vx: 0, vy: 0, facing: 0, prevX: cx, prevY: cy,
    hp: base.hp, maxHp: base.hp, atk: base.atk, def: base.def, speed: base.speed, range: base.range,
    attackInterval: base.attackInterval, status: 'alive', shield: 0, weaponLevel: 0, buffs: [],
    kills: 0, streak: 0, damageDealt: 0, giftValue: 0, placement: 0,
    allianceId: null, targetId: null, intent: 'normal',
    cooldowns: { attack: 0, dodge: 0, ally: 0, betray: 0 },
  };
}

export function createBot(config, state) {
  const sequence = (botSequences.get(config) ?? 0) + 1;
  botSequences.set(config, sequence);
  const info = { id: `bot_${sequence}`, name: `${pick(config.botNames)} ${sequence}`, avatar: '', isBot: true };
  return state ? createPlayer(info, state, config) : createPlayer(info, config);
}
