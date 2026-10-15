import { createEffects } from './effects.js';
import { clamp } from '../core/utils.js';

export function createRenderer({ canvas, bus, state, config }) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  const effects = createEffects({ bus, state, config });
  const ui = config.ui;
  const colors = ui.renderColors;
  const off = [];
  const avatars = new Map();
  const deaths = new Map();
  const frameListeners = new Set();
  const camera = { cx: state.arena.cx, cy: state.arena.cy, zoom: 1 };
  let background = null;
  let elapsed = 0;
  let lastFrameAt = null;
  let shakeUntil = 0;
  let shakeAmount = 0;
  let disposed = false;

  function offscreen(width, height) {
    const surface = canvas.ownerDocument?.createElement('canvas') ?? globalThis.document?.createElement('canvas');
    if (!surface) return null;
    surface.width = width;
    surface.height = height;
    return surface;
  }

  function resize() {
    if (disposed) return;
    canvas.width = state.arena.w;
    canvas.height = state.arena.h;
    background = offscreen(canvas.width, canvas.height);
    const paint = background?.getContext('2d');
    if (!paint) { background = null; return; }
    if (!config.transparent) {
      const gradient = paint.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, colors.backgroundTop);
      gradient.addColorStop(1, colors.backgroundBottom);
      paint.fillStyle = gradient;
      paint.fillRect(0, 0, canvas.width, canvas.height);
    }
    paint.strokeStyle = colors.grid;
    paint.lineWidth = ui.gridLineWidth;
    paint.beginPath();
    for (let x = 0; x <= canvas.width; x += ui.gridSize) { paint.moveTo(x, 0); paint.lineTo(x, canvas.height); }
    for (let y = 0; y <= canvas.height; y += ui.gridSize) { paint.moveTo(0, y); paint.lineTo(canvas.width, y); }
    paint.stroke();
  }

  function releaseAvatar(entry) {
    clearTimeout(entry.timeout);
    if (entry.image) { entry.image.onload = null; entry.image.onerror = null; entry.image.src = ''; }
  }

  function avatar(url) {
    if (!url) return null;
    if (avatars.has(url)) {
      const entry = avatars.get(url);
      avatars.delete(url);
      avatars.set(url, entry);
      return entry.tile;
    }
    while (avatars.size >= ui.avatarCacheMax && avatars.size) {
      const oldest = avatars.keys().next().value;
      releaseAvatar(avatars.get(oldest));
      avatars.delete(oldest);
    }
    const entry = { tile: null, image: null, failed: false, timeout: null };
    avatars.set(url, entry);
    if (typeof globalThis.Image !== 'function') { entry.failed = true; return null; }
    const image = new Image();
    entry.image = image;
    const fail = () => { clearTimeout(entry.timeout); entry.failed = true; image.onload = null; image.onerror = null; };
    image.crossOrigin = 'anonymous';
    image.onerror = fail;
    image.onload = () => {
      clearTimeout(entry.timeout);
      if (disposed || avatars.get(url) !== entry) return;
      try {
        const size = ui.playerRadius * 2 * ui.avatarResolution;
        const tile = offscreen(size, size);
        const paint = tile?.getContext('2d');
        if (!paint || !image.naturalWidth || !image.naturalHeight) { fail(); return; }
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        paint.beginPath(); paint.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); paint.clip();
        paint.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        entry.tile = tile;
        image.onload = null;
        image.onerror = null;
      } catch { fail(); }
    };
    entry.timeout = setTimeout(fail, ui.avatarLoadTimeoutMs);
    try { image.src = url; } catch { fail(); }
    return null;
  }

  function drawZone() {
    ctx.fillStyle = colors.outside;
    ctx.beginPath(); ctx.rect(0, 0, state.arena.w, state.arena.h);
    ctx.arc(state.zone.cx, state.zone.cy, Math.max(0, state.zone.radius), 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = colors.zone;
    ctx.lineWidth = ui.zoneLineWidth;
    ctx.setLineDash(ui.zoneDash);
    ctx.beginPath(); ctx.arc(state.zone.cx, state.zone.cy, state.zone.radius, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawDrops() {
    for (const drop of state.drops) {
      const size = ui.dropSize;
      ctx.fillStyle = ui.tierColors[drop.tier] ?? colors.supply;
      ctx.fillRect(drop.x - size / 2, drop.y - size / 2, size, size);
      ctx.strokeStyle = colors.backgroundTop; ctx.lineWidth = ui.allyLineWidth;
      ctx.strokeRect(drop.x - size / 2, drop.y - size / 2, size, size);
      ctx.beginPath(); ctx.moveTo(drop.x, drop.y - size / 2); ctx.lineTo(drop.x, drop.y + size / 2);
      ctx.moveTo(drop.x - size / 2, drop.y); ctx.lineTo(drop.x + size / 2, drop.y); ctx.stroke();
    }
    for (const trap of state.traps) {
      ctx.fillStyle = trap.kind === 'bomb' ? colors.bomb : colors.spike;
      ctx.beginPath();
      if (trap.kind === 'bomb') ctx.arc(trap.x, trap.y, ui.trapRadius, 0, Math.PI * 2);
      else { ctx.moveTo(trap.x, trap.y - ui.trapRadius); ctx.lineTo(trap.x + ui.trapRadius, trap.y + ui.trapRadius); ctx.lineTo(trap.x - ui.trapRadius, trap.y + ui.trapRadius); ctx.closePath(); }
      ctx.fill();
    }
  }

  function drawBoss() {
    const boss = state.boss;
    if (!boss) return;
    ctx.fillStyle = colors.boss;
    ctx.beginPath(); ctx.arc(boss.x, boss.y, ui.bossRadius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = colors.rage; ctx.lineWidth = ui.bountyLineWidth; ctx.stroke();
    ctx.fillStyle = colors.text; ctx.font = `bold ${ui.avatarInitialFontSize}px ${ui.canvasFont}`;
    ctx.fillText('B', boss.x, boss.y + ui.avatarInitialFontSize / 3);
    bar(boss.x, boss.y - ui.bossBarOffset, ui.bossBarWidth, ui.bossBarHeight, boss.hp, boss.maxHp, colors.bossHp);
  }

  function bar(x, y, width, height, hp, maxHp, color = colors.hp) {
    ctx.fillStyle = colors.hpTrack;
    ctx.fillRect(x - width / 2, y, width, height);
    ctx.fillStyle = color;
    ctx.fillRect(x - width / 2, y, width * clamp(maxHp > 0 ? hp / maxHp : 0, 0, 1), height);
  }

  function outline(x, y, radius, color, width) {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
  }

  function drawPlayers(alpha) {
    const positions = new Map();
    for (const player of state.players.values()) {
      const x = (player.prevX ?? player.x) + (player.x - (player.prevX ?? player.x)) * alpha;
      const y = (player.prevY ?? player.y) + (player.y - (player.prevY ?? player.y)) * alpha;
      positions.set(player.id, { x, y });
    }
    ctx.strokeStyle = colors.ally; ctx.lineWidth = ui.allyLineWidth;
    ctx.beginPath();
    for (const alliance of state.alliances.values()) {
      const first = state.players.get(alliance.aId), second = state.players.get(alliance.bId);
      if (first?.status !== 'alive' || second?.status !== 'alive') continue;
      const a = positions.get(first.id), b = positions.get(second.id);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    for (const player of state.players.values()) {
      const { x, y } = positions.get(player.id);
      if (player.status === 'spectator') continue;
      if (player.status === 'dead') {
        if (!deaths.has(player.id)) deaths.set(player.id, elapsed);
        const age = elapsed - deaths.get(player.id);
        if (age >= ui.deathVisibleMs / 1000) continue;
        ctx.globalAlpha = ui.deathAlpha * (1 - age / (ui.deathVisibleMs / 1000));
        ctx.fillStyle = colors.grave;
        ctx.fillRect(x - ui.playerRadius / 2, y - ui.playerRadius, ui.playerRadius, ui.playerRadius * 1.5);
        ctx.fillStyle = colors.text; ctx.font = `${ui.classIconSize}px ${ui.canvasFont}`; ctx.fillText('+', x, y);
        ctx.globalAlpha = 1;
        continue;
      }
      deaths.delete(player.id);
      const color = config.classes[player.classId]?.color ?? colors.fallback;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, ui.playerRadius, 0, Math.PI * 2); ctx.fill();
      const tile = avatar(player.avatar || player.avatarUrl);
      if (tile) ctx.drawImage(tile, x - ui.playerRadius, y - ui.playerRadius, ui.playerRadius * 2, ui.playerRadius * 2);
      else { ctx.fillStyle = colors.text; ctx.font = `bold ${ui.avatarInitialFontSize}px ${ui.canvasFont}`; ctx.fillText(Array.from(String(player.name || '?'))[0].toUpperCase(), x, y + ui.avatarInitialFontSize / 3); }
      outline(x, y, ui.playerRadius, color, ui.allyLineWidth);
      if (player.shield > 0) outline(x, y, ui.playerRadius + ui.shieldGap, colors.shield, ui.shieldLineWidth);
      if (player.buffs.some((buff) => buff.type === 'rage' && buff.until > state.time * 1000)) outline(x, y, ui.playerRadius + ui.shieldGap * 2, colors.rage, ui.rageLineWidth);
      if (player.id === state.bountyId) {
        outline(x, y, ui.playerRadius + ui.bountyHaloGap, colors.rage, ui.bountyLineWidth);
        ctx.fillStyle = colors.crit; ctx.font = `bold ${ui.classIconSize}px ${ui.canvasFont}`; ctx.fillText('\u265B', x, y - ui.nameOffset - ui.classIconSize);
      }
      ctx.fillStyle = colors.text; ctx.font = `${ui.nameFontSize}px ${ui.canvasFont}`;
      ctx.fillText(player.name, x, y - ui.nameOffset, ui.nameMaxWidth);
      ctx.font = `${ui.classIconSize}px ${ui.canvasFont}`;
      ctx.fillText(ui.classIcons[player.classId] ?? '?', x + ui.classIconOffset, y + ui.classIconOffsetY);
      bar(x, y + ui.hpBarOffset, ui.hpBarWidth, ui.hpBarHeight, player.hp, player.maxHp);
    }
  }

  function shake(amount) { shakeAmount = amount; shakeUntil = elapsed + ui.shakeDurationMs / 1000; }
  off.push(bus.on('player:killed', (payload) => { if (payload?.victimId) deaths.set(String(payload.victimId), elapsed); }));
  off.push(bus.on('player:revived', (payload) => { if (payload?.playerId) deaths.delete(String(payload.playerId)); }));
  off.push(bus.on('boss:spawned', () => shake(ui.bossShake)));
  off.push(bus.on('boss:defeated', () => shake(ui.bossShake)));
  off.push(bus.on('ultimate:fire', () => { if (state.phase === 'BATTLE' || state.phase === 'FINAL') shake(ui.ultimateShake); }));
  off.push(bus.on('round:phase', (payload) => {
    if (payload?.phase === 'LOBBY') { deaths.clear(); shakeUntil = 0; camera.zoom = 1; camera.cx = state.arena.cx; camera.cy = state.arena.cy; }
  }));

  function update(dt) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    elapsed += dt;
    effects.update(dt);
  }

  function render(alpha = 0) {
    if (disposed) return;
    alpha = clamp(Number.isFinite(alpha) ? alpha : 0, 0, 1);
    const now = globalThis.performance?.now() ?? Date.now();
    const dt = lastFrameAt === null ? 1 / ui.cameraReferenceFps : clamp((now - lastFrameAt) / 1000, 0, ui.cameraMaxDeltaSec);
    lastFrameAt = now;
    update(dt);
    const final = state.phase === 'FINAL';
    const zoom = final ? clamp(Math.min(canvas.width, canvas.height) / (2 * (Math.max(0, state.zone.radius) + ui.cameraPadding)), 1, ui.finalZoomMax) : 1;
    const smooth = dt > 0 ? 1 - Math.pow(1 - ui.cameraSmoothing, dt * ui.cameraReferenceFps) : ui.cameraSmoothing;
    camera.zoom += (zoom - camera.zoom) * smooth;
    camera.cx += ((final ? state.zone.cx : state.arena.cx) - camera.cx) * smooth;
    camera.cy += ((final ? state.zone.cy : state.arena.cy) - camera.cy) * smooth;
    const shakeScale = elapsed < shakeUntil ? shakeAmount * (shakeUntil - elapsed) / (ui.shakeDurationMs / 1000) : 0;
    const offsetX = Math.sin(elapsed * ui.cameraReferenceFps) * shakeScale;
    const offsetY = Math.cos(elapsed * ui.cameraReferenceFps) * shakeScale;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(camera.zoom, 0, 0, camera.zoom, canvas.width / 2 - camera.cx * camera.zoom + offsetX, canvas.height / 2 - camera.cy * camera.zoom + offsetY);
    ctx.textAlign = 'center';
    if (background) ctx.drawImage(background, 0, 0);
    else if (!config.transparent) { ctx.fillStyle = colors.backgroundTop; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    drawZone();
    drawDrops();
    drawBoss();
    drawPlayers(alpha);
    effects.render(ctx, alpha);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const listener of frameListeners) {
      try { listener({ alpha, camera: { ...camera }, width: canvas.width, height: canvas.height }); }
      catch (error) { console.warn('[renderer] onFrame failed:', error); }
    }
    return alpha;
  }

  resize();
  return {
    render, resize, update,
    onFrame(listener) { if (typeof listener !== 'function') throw new TypeError('onFrame requires a function'); frameListeners.add(listener); return () => frameListeners.delete(listener); },
    dispose() { if (disposed) return; disposed = true; effects.dispose(); off.splice(0).forEach((unsubscribe) => unsubscribe()); for (const entry of avatars.values()) releaseAvatar(entry); avatars.clear(); deaths.clear(); frameListeners.clear(); background = null; },
    get particleCount() { return effects.particleCount; },
    get camera() { return { ...camera }; },
    get avatarStats() { return { cached: avatars.size, loaded: [...avatars.values()].filter((entry) => entry.tile).length, failed: [...avatars.values()].filter((entry) => entry.failed).length }; },
  };
}
