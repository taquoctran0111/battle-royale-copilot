const schemas = {
  'live:status': { connected: 'boolean', roomId: '?string', error: '?string' },
  'live:chat': { userId: 'string', uniqueId: 'string', nickname: 'string', avatarUrl: 'string', text: 'string' },
  'live:gift': { userId: 'string', uniqueId: 'string', nickname: 'string', avatarUrl: 'string', giftId: 'number', giftName: 'string', diamonds: 'number', count: 'number' },
  'live:like': { userId: 'string', nickname: 'string', likeCount: 'number', totalLikeCount: 'number' },
  'live:join': { userId: 'string', uniqueId: 'string', nickname: 'string', avatarUrl: 'string' },
  'live:follow': { userId: 'string', uniqueId: 'string', nickname: 'string' },
  'live:share': { userId: 'string', uniqueId: 'string', nickname: 'string' },
  'cmd:join': { player: { id: 'string', name: 'string', avatar: 'string' } },
  'cmd:attack': { playerId: 'string' }, 'cmd:dodge': { playerId: 'string' },
  'cmd:ally': { playerId: 'string', targetName: 'string' }, 'cmd:betray': { playerId: 'string' },
  'cmd:giftTarget': { playerId: 'string', targetName: 'string' },
  'gift:effect': { fromId: 'string', toId: 'string', tier: [1, 2, 3, 4], diamonds: 'number', giftName: 'string', count: 'number' },
  'energy:add': { amount: 'number' },
  'round:phase': { roundId: 'number', phase: ['LOBBY', 'COUNTDOWN', 'BATTLE', 'FINAL', 'RESULT'], endsAt: 'number' },
  'round:ended': { roundId: 'number', winnerId: 'nullableString', ranking: 'ranking' },
  'player:joined': { playerId: 'string' },
  'damage:request': { targetId: 'string', amount: 'number', sourceId: 'nullableString', cause: ['attack', 'zone', 'trap', 'boss', 'bomb', 'ultimate', 'betray'] },
  'heal:request': { targetId: 'string', amount: 'number', sourceId: 'nullableString' },
  'player:damaged': { targetId: 'string', amount: 'number', sourceId: 'nullableString', cause: ['attack', 'zone', 'trap', 'boss', 'bomb', 'ultimate', 'betray'], crit: 'boolean' },
  'player:killed': { victimId: 'string', killerId: 'nullableString', cause: ['attack', 'zone', 'trap', 'boss', 'bomb', 'ultimate', 'betray'] },
  'revive:request': { playerId: 'string', byId: 'nullableString' }, 'player:revived': { playerId: 'string', byId: 'nullableString' },
  'buff:apply': { playerId: 'string', type: ['shield', 'speed', 'weapon', 'rage'], durationMs: 'number', value: 'number' },
  'ally:formed': { aId: 'string', bId: 'string' },
  'ally:broken': { aId: 'string', bId: 'string', reason: ['betray', 'death', 'roundEnd'] },
  'ally:betrayed': { betrayerId: 'string', victimId: 'string' },
  'zone:update': { cx: 'number', cy: 'number', radius: 'number', nextRadius: 'number', shrinkAtMs: 'number' },
  'drop:spawned': { id: 'string', x: 'number', y: 'number', tier: [1, 2, 3, 4] },
  'drop:collected': { id: 'string', playerId: 'string', reward: ['weapon', 'shield', 'heal', 'rage'] },
  'trap:spawned': { id: 'string', x: 'number', y: 'number', kind: ['spike', 'bomb'] },
  'trap:triggered': { id: 'string', x: 'number', y: 'number', victims: 'ids' },
  'boss:spawned': { id: 'string', hp: 'number', maxHp: 'number' },
  'boss:damaged': { hp: 'number', maxHp: 'number', byId: 'nullableString' },
  'boss:defeated': { topDamagers: 'damagers' },
  'streak:updated': { playerId: 'string', streak: 'number' },
  'bounty:set': { playerId: 'string' }, 'bounty:claimed': { victimId: 'string', killerId: 'string' },
  'energy:changed': { value: 'number', max: 'number' },
  'event:triggered': { type: ['storm', 'bombRain', 'boss', 'meteor'] }, 'ultimate:fire': { byId: 'string' },
  'drop:request': { x: '?number', y: '?number', tier: [1, 2, 3, 4] },
  'gift:ignored': { fromId: 'string', toId: 'string', tier: [1, 2, 3, 4], diamonds: 'number', giftName: 'string', count: 'number', reason: ['inactive_phase', 'spectator', 'missing_player', 'dead', 'unknown_sender'] },
};

export const eventCatalog = new Set(Object.keys(schemas));

export function validateEventPayload(type, payload) {
  const errors = [];
  function check(schema, value, prefix) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${prefix}: expected object`); return; }
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema, key)) errors.push(`${prefix}.${key}: unexpected field`);
    for (const [key, rule] of Object.entries(schema)) {
      const field = `${prefix}.${key}`;
      const item = value[key];
      if (typeof rule === 'string' && rule.startsWith('?') && item === undefined) continue;
      const kind = typeof rule === 'string' ? rule.replace(/^\?/, '') : rule;
      if (Array.isArray(kind)) { if (!kind.includes(item)) errors.push(`${field}: invalid enum`); }
      else if (typeof kind === 'object') check(kind, item, field);
      else if (kind === 'nullableString') { if (item !== null && typeof item !== 'string') errors.push(`${field}: expected string|null`); }
      else if (kind === 'number') { if (typeof item !== 'number' || !Number.isFinite(item)) errors.push(`${field}: expected finite number`); }
      else if (kind === 'ranking' || kind === 'damagers') {
        if (!Array.isArray(item)) errors.push(`${field}: expected array`);
        else item.forEach((row, index) => check(kind === 'ranking' ? { playerId: 'string', name: 'string', kills: 'number', damage: 'number', placement: 'number' } : { playerId: 'string', damage: 'number' }, row, `${field}[${index}]`));
      } else if (kind === 'ids') { if (!Array.isArray(item) || item.some((id) => typeof id !== 'string')) errors.push(`${field}: expected string[]`); }
      else if (typeof item !== kind) errors.push(`${field}: expected ${kind}`);
    }
  }
  if (!Object.hasOwn(schemas, type)) return [`Unknown event: ${type}`];
  check(schemas[type], payload, type);
  return errors;
}