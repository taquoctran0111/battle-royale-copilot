import baseConfig from '../core/config.js';

export function mockJoinText(index, config = baseConfig) {
  const slot = index % (config.classOrder.length + 1);
  const keyword = config.commands.join[0].toUpperCase();
  return slot === 0 ? keyword : `${keyword} ${config.classes[config.classOrder[slot - 1]].name}`;
}

// Emit real comments, not gameplay events: phase, death and cooldown rules still apply.
export function createMockActions({ emit, getUsers, config = baseConfig, now = () => Date.now() }) {
  let pair = null;
  let startedAt = 0;
  let nextDodgeAt = 0;
  let betrayed = false;
  let rescued = false;
  let rescueCount = 0;
  let cursor = 0;
  const chat = (user, text) => emit('live:chat', {
    userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname, avatarUrl: user.avatarUrl, text,
  });
  const betrayDelay = config.alliance.betrayWaitMs + 1000;
  const cycleMs = Math.max(28000, betrayDelay + config.combat.cooldownMs.betray + 1000);

  return {
    update() {
      const time = now();
      if (!pair || time - startedAt >= cycleMs) {
        const users = getUsers().slice(0, config.lobby.maxPlayers);
        if (users.length < 2) return;
        pair = [users[cursor % users.length], users[(cursor + 1) % users.length]];
        cursor += 2;
        startedAt = time;
        nextDodgeAt = time + 1000;
        betrayed = false;
        rescued = false;
        chat(pair[0], `${config.commands.ally[0]} ${pair[1].nickname}`);
        chat(pair[1], `${config.commands.ally[0]} ${pair[0].nickname}`);
      }
      if (time >= nextDodgeAt) {
        for (const user of pair) chat(user, config.commands.dodge[0]);
        nextDodgeAt = time + config.combat.cooldownMs.dodge + 1000;
      }
      if (!betrayed && time - startedAt >= betrayDelay) {
        betrayed = true;
        chat(pair[0], config.commands.betray[0]);
      }
      if (!rescued && time - startedAt >= betrayDelay + 3000) {
        rescued = true;
        const [sender, target] = pair;
        chat(sender, `${config.commands.rescue[0]} ${target.nickname}`);
        const revive = rescueCount++ % 2 === 1;
        const tier = config.gifts.tiers.find((entry) => entry.tier === (revive ? 4 : 1));
        emit('live:gift', {
          userId: sender.userId, uniqueId: sender.uniqueId, nickname: sender.nickname, avatarUrl: sender.avatarUrl,
          giftId: revive ? 5301 : 5001, giftName: revive ? 'Galaxy' : 'Rose',
          diamonds: tier.min, count: 1,
        });
      }
    },
  };
}
