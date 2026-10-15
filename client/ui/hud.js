import { getAlive } from '../core/gameState.js';

export function createHud({ root, bus, state, config, serverUrl, fetchTop, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const off = [];
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? globalThis;
  const ui = config.ui.hud;
  const node = (id) => root.querySelector(`#${id}`);
  const phase = root.querySelector('#phase-label');
  const connection = root.querySelector('#connection-label');
  const counts = root.querySelector('#counts-label');
  const energy = root.querySelector('#energy-meter');
  const feed = root.querySelector('#kill-feed');
  const notice = root.querySelector('#notice');
  const leaderboard = root.querySelector('#round-ranking');
  const eventLabel = root.querySelector('#event-label');
  const lobby = node('lobby-screen');
  const countdown = node('countdown-screen');
  const battle = node('battle-screen');
  const result = node('result-screen');
  const daily = node('daily-ranking');
  const damageTop = node('damage-ranking');
  const zoneLabel = node('zone-warning');
  const bounty = node('bounty-banner');
  const bossPanel = node('boss-panel');
  const bossMeter = node('boss-meter');
  const avatarLane = node('recent-viewers');
  const popupQueue = [];
  const feedRows = [];
  const recent = [];
  const signatures = new Map();
  let currentPopup = null;
  let ignoredGift = null;
  let ranking = [];
  let winnerId = null;
  let bossSnapshot = null;
  let energySnapshot = null;
  let zoneSnapshot = null;
  let bannerUntil = 0;
  let eventUntil = 0;
  let battleFlashUntil = 0;
  let refreshAt = 0;
  let nextDailyAt = 0;
  let dailyController = null;
  let dailyPending = false;
  let disposed = false;
  const backend = new URL(serverUrl ?? globalThis.location?.origin ?? `http://localhost:${config.net.backendPort}`).origin;
  const text = (element, value) => { const next = String(value); if (element.textContent !== next) element.textContent = next; };
  const name = (id) => state.players.get(String(id))?.name ?? (id == null ? 'Vùng nguy hiểm' : String(id));
  const short = (value, limit) => { const points = Array.from(String(value ?? '')); return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : points.join(''); };
  const listen = (type, handler) => off.push(bus.on(type, (payload) => { if (!disposed && payload) handler(payload); }));

  function avatar(player, className = '') {
    const holder = doc.createElement('span');
    holder.className = `hud-avatar ${className}`;
    const initial = doc.createElement('span');
    initial.textContent = Array.from(String(player?.name || '?'))[0].toUpperCase();
    holder.appendChild(initial);
    if (player?.avatar || player?.avatarUrl) {
      const image = doc.createElement('img');
      image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
      image.onerror = () => { image.hidden = true; };
      image.src = player.avatar || player.avatarUrl;
      holder.appendChild(image);
    }
    return holder;
  }

  function rows(target, values, makeRow) {
    const signature = JSON.stringify(values);
    if (signatures.get(target) === signature) return;
    signatures.set(target, signature);
    target.replaceChildren(...values.map(makeRow));
  }

  function scoreRow(value, index, dailyRow = false) {
    const row = doc.createElement('li');
    const place = doc.createElement('span'); place.className = 'rank-place'; place.textContent = String(value.placement ?? index + 1);
    const label = doc.createElement('strong'); label.textContent = value.name; label.title = value.name;
    const score = doc.createElement('span'); score.className = 'rank-score';
    score.textContent = dailyRow ? `${Number(value.wins) || 0} thắng · ${Number(value.kills) || 0} hạ` : `${Number(value.kills) || 0} hạ · ${Math.round(Number(value.damage) || 0)}`;
    row.append(place, label, score);
    return row;
  }

  function addFeed(message, type) {
    feedRows.unshift({ message, type, until: now() + ui.feedTtlMs });
    feedRows.length = Math.min(feedRows.length, ui.feedRows);
    refreshAt = 0;
  }

  function enqueuePopup(value) {
    if (popupQueue.length + Number(Boolean(currentPopup)) >= ui.popupQueueMax) {
      if (value.tier <= 2) return;
      const small = popupQueue.findIndex((item) => item.tier < value.tier);
      if (small === -1 && !popupQueue.length) return;
      popupQueue.splice(small === -1 ? 0 : small, 1);
    }
    const before = popupQueue.findIndex((item) => item.tier < value.tier);
    if (before === -1) popupQueue.push(value);
    else popupQueue.splice(before, 0, value);
  }

  function resize() {
    if (disposed) return;
    const width = root.parentElement?.clientWidth || view.innerWidth || state.arena.w;
    const height = root.parentElement?.clientHeight || view.innerHeight || state.arena.h;
    const scale = Math.min(width / ui.designWidth, height / ui.designHeight);
    root.style.width = `${ui.designWidth}px`; root.style.height = `${ui.designHeight}px`;
    root.style.left = `${(width - ui.designWidth * scale) / 2}px`;
    root.style.top = `${(height - ui.designHeight * scale) / 2}px`;
    root.style.transform = `scale(${scale})`;
    for (const [edge, ratio] of Object.entries(ui.safeArea)) root.style.setProperty(`--safe-${edge}`, `${(edge === 'top' || edge === 'bottom' ? ui.designHeight : ui.designWidth) * ratio}px`);
  }

  async function loadDaily() {
    if (disposed || dailyPending || state.phase !== 'RESULT') return;
    dailyPending = true;
    nextDailyAt = now() + ui.dailyRefreshMs;
    const roundId = state.roundId;
    const controller = new AbortController();
    dailyController = controller;
    const timeout = setTimeout(() => controller.abort(), ui.dailyTimeoutMs);
    try {
      let values;
      if (fetchTop) values = await fetchTop({ period: 'day', metric: 'wins', limit: config.ui.leaderboardRows, signal: controller.signal });
      else {
        const response = await fetchImpl(`${backend}/api/leaderboard`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        values = await response.json();
      }
      if (!Array.isArray(values)) throw new Error('Invalid leaderboard');
      if (disposed || state.phase !== 'RESULT' || state.roundId !== roundId) return;
      rows(daily, values.slice(0, config.ui.leaderboardRows), (row, index) => scoreRow(row, index, true));
      text(node('daily-status'), values.length ? '' : 'Chưa có kết quả hôm nay');
    } catch (error) {
      if (!disposed && !controller.signal.aborted) text(node('daily-status'), 'Không tải được bảng ngày');
    } finally {
      clearTimeout(timeout);
      if (dailyController === controller) dailyController = null;
      dailyPending = false;
    }
  }

  const commands = Object.entries(ui.commandIcons).map(([key, icon]) => ({ icon, command: `${config.commands[key]?.[0]?.toUpperCase() ?? key.toUpperCase()}${key === 'ally' || key === 'rescue' ? ' [tên]' : ''}` }));
  rows(node('command-guide'), commands, (value) => { const row = doc.createElement('li'); const icon = doc.createElement('span'); icon.textContent = value.icon; const label = doc.createElement('strong'); label.textContent = value.command; row.append(icon, label); return row; });
  rows(node('gift-guide'), config.gifts.tiers.map((tier, index) => ({ icon: ui.giftIcons[index], range: Number.isFinite(tier.max) ? `${tier.min}–${tier.max}` : `${tier.min}+`, label: ui.giftLabels[index] })), (value) => { const row = doc.createElement('li'); const icon = doc.createElement('span'); icon.textContent = value.icon; const label = doc.createElement('strong'); label.textContent = `${value.range} 💎`; const description = doc.createElement('span'); description.textContent = value.label; row.append(icon, label, description); return row; });
  for (const player of [...state.players.values()].slice(-ui.recentAvatars)) recent.push({ id: player.id, name: player.name, avatar: player.avatar });
  connection.hidden = !ui.showConnection || new URLSearchParams(globalThis.location?.search ?? '').get('connection') === '0';

  listen('live:status', (status) => {
    connection.textContent = status.connected ? `LIVE · ${status.roomId || 'connected'}` : `OFFLINE · ${status.error || 'đang thử lại'}`;
    connection.dataset.state = status.connected ? 'online' : 'offline';
  });
  listen('gift:ignored', (gift) => { ignoredGift = { ...gift, at: now() }; });
  listen('gift:effect', (gift) => {
    const reason = ignoredGift?.fromId === gift.fromId && ignoredGift.toId === gift.toId && ignoredGift.diamonds === gift.diamonds && ignoredGift.count === gift.count && ignoredGift.giftName === gift.giftName ? ignoredGift.reason : null;
    enqueuePopup({ ...gift, tier: Number(gift.tier), fromName: name(gift.fromId), reason });
    ignoredGift = null;
  });
  listen('player:joined', ({ playerId }) => {
    const player = state.players.get(String(playerId));
    if (!player || recent.some((row) => row.id === player.id)) return;
    recent.push({ id: player.id, name: player.name, avatar: player.avatar });
    if (recent.length > ui.recentAvatars) recent.shift();
    refreshAt = 0;
  });
  listen('energy:changed', (value) => { if (Number.isFinite(value.value) && Number.isFinite(value.max)) energySnapshot = value; });
  listen('zone:update', (value) => { zoneSnapshot = value; });
  listen('round:ended', (value) => {
    ranking = Array.isArray(value.ranking) ? value.ranking.map((row) => ({ ...row })) : [];
    winnerId = value.winnerId ?? null;
    rows(leaderboard, ranking, (row, index) => scoreRow(row, index));
    const winner = state.players.get(String(winnerId));
    const row = ranking.find((entry) => entry.playerId === winnerId);
    node('champion-avatar').replaceChildren(avatar(winner ?? row, 'avatar-champion'));
    text(node('champion-name'), winnerId ? winner?.name ?? row?.name ?? winnerId : 'Hòa trận');
    text(node('champion-heading'), winnerId ? 'NHÀ VÔ ĐỊCH' : 'KHÔNG CÓ NHÀ VÔ ĐỊCH');
    text(node('champion-kills'), row?.kills ?? winner?.kills ?? 0);
    text(node('champion-damage'), Math.round(row?.damage ?? winner?.damageDealt ?? 0));
    text(node('round-total'), ranking.length);
    nextDailyAt = 0; refreshAt = 0;
    void loadDaily();
  });
  listen('event:triggered', ({ type }) => { text(eventLabel, config.ui.eventNames[type] ?? type); eventUntil = now() + config.ui.eventLabelDurationMs; });
  listen('player:killed', ({ victimId, killerId }) => addFeed(`${name(killerId)} → ${name(victimId)}`, 'kill'));
  listen('ally:formed', ({ aId, bId }) => addFeed(`${name(aId)} ♥ ${name(bId)}`, 'ally'));
  listen('ally:betrayed', ({ betrayerId, victimId }) => addFeed(`${name(betrayerId)} phản bội ${name(victimId)}`, 'betray'));
  listen('bounty:set', ({ playerId }) => { text(bounty, `${config.bounty.title.toUpperCase()} · ${name(playerId)}`); bannerUntil = now() + ui.bannerDurationMs; });
  listen('bounty:claimed', ({ victimId, killerId }) => addFeed(`${name(killerId)} hạ Kẻ hủy diệt ${name(victimId)}`, 'bounty'));
  listen('player:revived', ({ playerId }) => addFeed(`${name(playerId)} trở lại đấu trường`, 'revive'));
  listen('boss:spawned', (value) => { bossSnapshot = value; });
  listen('boss:damaged', (value) => { bossSnapshot = { ...bossSnapshot, ...value }; });
  listen('boss:defeated', () => { bossSnapshot = null; addFeed('Boss đã bị hạ', 'boss'); });
  listen('round:phase', ({ phase: nextPhase }) => {
    if (nextPhase === 'BATTLE') battleFlashUntil = now() + ui.battleFlashMs;
    if (nextPhase === 'LOBBY') { popupQueue.length = 0; currentPopup = null; feedRows.length = 0; ranking = []; winnerId = null; zoneSnapshot = null; bossSnapshot = null; energySnapshot = null; bannerUntil = eventUntil = 0; }
    if (nextPhase !== 'RESULT') dailyController?.abort();
    refreshAt = 0;
  });

  function update() {
    if (disposed) return;
    const time = now();
    const seconds = Math.max(0, Math.ceil((state.phaseEndsAt - time) / 1000));
    const active = state.phase === 'BATTLE' || state.phase === 'FINAL';
    if (root.dataset.phase !== state.phase) root.dataset.phase = state.phase;
    text(phase, config.ui.phaseNames[state.phase] ?? state.phase);
    text(node('phase-clock'), `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
    text(counts, `${getAlive(state).length} còn sống · ván ${state.roundId}`);
    text(node('lobby-count'), [...state.players.values()].filter((player) => player.status !== 'spectator').length);
    text(node('lobby-clock'), seconds);
    lobby.hidden = state.phase !== 'LOBBY';
    countdown.hidden = state.phase !== 'COUNTDOWN' && !(active && time < battleFlashUntil);
    text(node('countdown-number'), state.phase === 'COUNTDOWN' && seconds > 0 ? seconds : 'CHIẾN!');
    battle.hidden = !active;
    result.hidden = state.phase !== 'RESULT';
    const value = energySnapshot ?? state.energy;
    energy.value = Math.max(0, Math.min(value.max, value.value)); energy.max = Math.max(1, value.max);
    node('energy-panel').hidden = !active;
    text(node('energy-value'), `${Math.round(energy.value)}/${Math.round(energy.max)}`);
    if (currentPopup && time >= currentPopup.until) currentPopup = null;
    if (!currentPopup && popupQueue.length) {
      currentPopup = { ...popupQueue.shift(), until: time + ui.popupDurationMs };
      const thanks = node('gift-thanks');
      text(thanks, `Cảm ơn ${short(currentPopup.fromName, ui.popupNameChars)} đã tặng ${short(currentPopup.giftName, ui.popupGiftChars)}!`);
      thanks.title = `Cảm ơn ${currentPopup.fromName} đã tặng ${currentPopup.giftName}!`;
      thanks.setAttribute?.('aria-label', thanks.title);
      text(node('gift-detail'), `${currentPopup.diamonds} 💎 · T${currentPopup.tier}${currentPopup.reason === 'inactive_phase' ? ' · Đã ghi nhận quà' : currentPopup.reason ? ' · Người nhận chưa thể nhận hỗ trợ' : ''}`);
    }
    notice.hidden = !currentPopup;
    eventLabel.hidden = !active || time >= eventUntil;
    bounty.hidden = !active || time >= bannerUntil;
    const shrinkAt = Number(zoneSnapshot?.shrinkAtMs);
    zoneLabel.hidden = !active || !Number.isFinite(shrinkAt) || shrinkAt - time > ui.zoneWarningLeadMs || time >= shrinkAt + ui.zoneWarningDurationMs;
    if (!zoneLabel.hidden) text(zoneLabel, shrinkAt > time ? `Bo thu hẹp sau ${Math.ceil((shrinkAt - time) / 1000)}s` : `Bo đang thu hẹp · R${Math.round(zoneSnapshot.nextRadius)}`);
    const boss = state.boss ?? bossSnapshot;
    bossPanel.hidden = !active || !boss || boss.hp <= 0;
    if (!bossPanel.hidden) { bossMeter.max = Math.max(1, boss.maxHp); bossMeter.value = Math.max(0, Math.min(boss.maxHp, boss.hp)); text(node('boss-hp'), `${Math.ceil(boss.hp)}/${Math.ceil(boss.maxHp)}`); }
    if (time >= refreshAt) {
      refreshAt = time + ui.refreshMs;
      const livingFeed = feedRows.filter((row) => row.until > time);
      rows(feed, livingFeed, (value) => { const row = doc.createElement('li'); row.className = `feed-${value.type}`; row.textContent = value.message; row.title = value.message; return row; });
      rows(damageTop, [...state.players.values()].filter((player) => player.status !== 'spectator').sort((a, b) => b.damageDealt - a.damageDealt).slice(0, config.ui.leaderboardRows).map((player) => ({ name: player.name, damage: Math.round(player.damageDealt), kills: player.kills })), (row, index) => scoreRow(row, index));
      rows(avatarLane, recent, (player) => { const row = doc.createElement('li'); row.appendChild(avatar(player)); const label = doc.createElement('span'); label.textContent = player.name; row.appendChild(label); return row; });
    }
    if (state.phase === 'RESULT' && time >= nextDailyAt) void loadDaily();
  }

  view.addEventListener?.('resize', resize);
  resize(); update();
  return { update, resize, get popupCount() { return popupQueue.length + Number(Boolean(currentPopup)); }, get feedCount() { return feedRows.length; }, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); view.removeEventListener?.('resize', resize); dailyController?.abort(); popupQueue.length = 0; feedRows.length = 0; currentPopup = null; signatures.clear(); } };
}
