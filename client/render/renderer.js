import { createEffects } from './effects.js';
import { clamp } from '../core/utils.js';
import { createArtwork } from './artwork.js';

export function createRenderer({ canvas, bus, state, config }) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  const effects = createEffects({ bus, state, config, document: canvas.ownerDocument ?? globalThis.document });
  const ui = config.ui;
  const colors = ui.renderColors;
  const off = [];
  const avatars = new Map();
  const deaths = new Map();
  const hits = new Map();
  const frameListeners = new Set();
  const camera = { cx: state.arena.cx, cy: state.arena.cy, zoom: 1 };
  let background = null;
  let elapsed = 0;
  let lastFrameAt = null;
  let shakeUntil = 0;
  let shakeAmount = 0;
  let disposed = false;
  let bossMotion = null;
  let bossSwingUntil = 0;
  let bossFacing = 0;
  const artwork = createArtwork({
    document: canvas.ownerDocument ?? globalThis.document,
    onLoad: (key) => { if (key === 'forest') resize(); },
    onError: (path, error) => {
      console.error(`[artwork] ${path}`, error);
      const label = canvas.ownerDocument?.querySelector?.('#artwork-status');
      if (label) { label.hidden = false; label.textContent = 'Không tải được một số ảnh đấu trường. Kiểm tra assets.'; }
    },
  });

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
      const forest = artwork.get('forest');
      if (forest) {
        const scale = Math.max(canvas.width / forest.naturalWidth, canvas.height / forest.naturalHeight);
        paint.drawImage(forest, (canvas.width - forest.naturalWidth * scale) / 2, (canvas.height - forest.naturalHeight * scale) / 2, forest.naturalWidth * scale, forest.naturalHeight * scale);
        return;
      }
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
    ctx.shadowColor = colors.zone;
    ctx.shadowBlur = 18;
    ctx.lineWidth = ui.zoneLineWidth;
    ctx.setLineDash(ui.zoneDash);
    ctx.beginPath(); ctx.arc(state.zone.cx, state.zone.cy, state.zone.radius, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
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
      if (trap.visual === 'meteor') continue;
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
    const definition = config.bosses[boss.type];
    const radius = ui.bossRadius * (boss.type === 'fusion' ? 1.5 : 1);
    const color = definition?.color ?? colors.rage;
    const fighting = state.phase === 'BATTLE' || state.phase === 'FINAL';
    const moved = bossMotion?.id === boss.id && Math.hypot(boss.x - bossMotion.x, boss.y - bossMotion.y) > 0.01;
    const movingUntil = moved ? elapsed + .12 : bossMotion?.id === boss.id ? bossMotion.movingUntil : 0;
    const moving = elapsed < movingUntil;
    const target = [...state.players.values()].filter((player) => player.status === 'alive')
      .sort((a, b) => Math.hypot(a.x - boss.x, a.y - boss.y) - Math.hypot(b.x - boss.x, b.y - boss.y))[0];
    if (target) bossFacing = Math.atan2(target.y - boss.y, target.x - boss.x);
    const swing = fighting ? clamp(1 - (bossSwingUntil - elapsed) / (ui.bossSwingDurationMs / 1000), 0, 1) : 1;
    const thrust = Math.sin(swing * Math.PI) * 20;
    const bob = fighting ? Math.sin(elapsed * (moving ? 12 : 4)) * (moving ? 5 : 2) : 0;
    bossMotion = { id: boss.id, x: boss.x, y: boss.y, movingUntil };
    ctx.fillStyle = 'rgba(8,0,10,.45)';
    ctx.beginPath(); ctx.ellipse(boss.x, boss.y + 65, 75, 23, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(boss.x + Math.cos(bossFacing) * thrust, boss.y + bob + Math.sin(bossFacing) * thrust);
    ctx.rotate(fighting ? Math.sin(elapsed * 4) * .025 + Math.sin(swing * Math.PI * 2) * .12 : 0);
    const sprite = artwork.get(boss.type === 'forest' ? 'forestBoss' : boss.type) ?? artwork.get('boss');
    ctx.shadowColor = color; ctx.shadowBlur = 25 + Math.sin(elapsed * 5) * 10;
    if (sprite) {
      const width = radius * (boss.type === 'fusion' ? 2.6 : 2);
      const height = width * (sprite.naturalHeight ?? sprite.height) / (sprite.naturalWidth ?? sprite.width);
      ctx.drawImage(sprite, -width / 2, -height / 2, width, height);
    }
    else {
      ctx.fillStyle = colors.boss;
      ctx.beginPath(); ctx.arc(0, 0, ui.bossRadius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = colors.rage; ctx.lineWidth = ui.bountyLineWidth; ctx.stroke();
      ctx.fillStyle = colors.text; ctx.font = `bold ${ui.avatarInitialFontSize}px ${ui.canvasFont}`;
      ctx.fillText('B', 0, ui.avatarInitialFontSize / 3);
    }
    ctx.restore();
    ctx.save(); ctx.strokeStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.lineWidth = 3;
    for (let i = 0; i < (boss.type === 'fusion' ? 4 : 1); i++) {
      if (boss.type === 'fusion') ctx.strokeStyle = config.bosses[config.bosses.minorOrder[i]].color;
      const angle = elapsed * 1.5 + i * Math.PI / 2;
      ctx.beginPath(); ctx.arc(boss.x, boss.y, radius + 12 + i * 4, angle, angle + Math.PI * .65); ctx.stroke();
    }
    ctx.restore();
    if (boss.casting && definition) {
      ctx.save(); ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 4;
      ctx.globalAlpha = .12 + Math.abs(Math.sin(elapsed * 9)) * .12;
      ctx.beginPath(); ctx.arc(boss.casting.x, boss.casting.y, definition.skill.radius, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = .9; ctx.stroke(); ctx.restore();
    }
    if (swing > 0 && swing < 1) {
      ctx.save(); ctx.strokeStyle = '#ffbe64'; ctx.lineWidth = 10 * (1 - swing) + 2;
      ctx.shadowColor = '#ff5b25'; ctx.shadowBlur = 22; ctx.globalAlpha = 1 - swing;
      ctx.beginPath(); ctx.arc(boss.x, boss.y, ui.bossRadius + 18, bossFacing - 1.2 + swing, bossFacing + .5 + swing); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = colors.text; ctx.font = `bold 20px ${ui.canvasFont}`;
    const barY = boss.y - Math.max(ui.bossBarOffset, radius + 28);
    ctx.strokeStyle = '#07101f'; ctx.lineWidth = 4;
    ctx.strokeText(definition?.name ?? 'BOSS', boss.x, barY - 12);
    ctx.fillText(definition?.name ?? 'BOSS', boss.x, barY - 12);
    bar(boss.x, barY, ui.bossBarWidth, ui.bossBarHeight, boss.hp, boss.maxHp, color);
    bar(boss.x, barY + ui.bossBarHeight + 4, ui.bossBarWidth, 5, boss.mana ?? 0, boss.maxMana ?? 100, '#56caff');
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
      const moving = Math.hypot(player.vx, player.vy) > 5;
      const target = state.players.get(String(player.targetId)) ?? (state.boss?.id === player.targetId ? state.boss : null);
      const fighting = target && Math.hypot(player.x - target.x, player.y - target.y) <= player.range;
      const action = (moving || fighting) && Math.floor(elapsed * 5) % 2 === 1;
      const sprite = artwork.get(`${player.classId}${action ? 'Action' : ''}`) ?? artwork.get(player.classId);
      if (sprite) {
        ctx.fillStyle = 'rgba(0,8,22,.4)';
        ctx.beginPath(); ctx.ellipse(x, y + 24, 27, 10, 0, 0, Math.PI * 2); ctx.fill();
        ctx.drawImage(sprite, x - 52, y - 62, 104, 104);
      } else {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, ui.playerRadius, 0, Math.PI * 2); ctx.fill();
        const tile = avatar(player.avatar || player.avatarUrl);
        if (tile) ctx.drawImage(tile, x - ui.playerRadius, y - ui.playerRadius, ui.playerRadius * 2, ui.playerRadius * 2);
        else { ctx.fillStyle = colors.text; ctx.font = `bold ${ui.avatarInitialFontSize}px ${ui.canvasFont}`; ctx.fillText(Array.from(String(player.name || '?'))[0].toUpperCase(), x, y + ui.avatarInitialFontSize / 3); }
        outline(x, y, ui.playerRadius, color, ui.allyLineWidth);
      }
      if (player.shield > 0) {
        const radius = ui.playerRadius + 16 + Math.sin(elapsed * 4) * 3;
        ctx.save();
        ctx.shadowColor = '#65e8ff'; ctx.shadowBlur = 22;
        ctx.fillStyle = 'rgba(73,201,255,.13)';
        ctx.beginPath(); ctx.ellipse(x, y - 5, radius, radius * 1.25, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#8ff3ff'; ctx.lineWidth = 2.5;
        ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const angle = elapsed * 1.8 + i * Math.PI / 3;
          ctx.fillStyle = '#d5ffff'; ctx.beginPath();
          ctx.arc(x + Math.cos(angle) * radius, y - 5 + Math.sin(angle) * radius * 1.25, 2.5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
      const hit = hits.get(player.id);
      if (hit && elapsed - hit.at < ui.hitFlashMs / 1000) {
        ctx.save();
        ctx.globalAlpha = .7 * (1 - (elapsed - hit.at) / (ui.hitFlashMs / 1000));
        ctx.fillStyle = '#ff375a'; ctx.shadowColor = '#ff234f'; ctx.shadowBlur = 24;
        ctx.beginPath(); ctx.ellipse(x, y - 5, 32, 42, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      if (player.buffs.some((buff) => buff.type === 'rage' && buff.until > state.time * 1000)) outline(x, y, ui.playerRadius + ui.shieldGap * 2, colors.rage, ui.rageLineWidth);
      if (player.id === state.bountyId) {
        outline(x, y, ui.playerRadius + ui.bountyHaloGap, colors.rage, ui.bountyLineWidth);
        ctx.fillStyle = colors.crit; ctx.font = `bold ${ui.classIconSize}px ${ui.canvasFont}`; ctx.fillText('\u265B', x, y - ui.nameOffset - ui.classIconSize);
      }
      if (player.bossSlayerRound === state.roundId) {
        ctx.save(); ctx.fillStyle = '#ffe18a'; ctx.shadowColor = '#ffbc38'; ctx.shadowBlur = 16;
        ctx.font = `bold 17px ${ui.canvasFont}`;
        ctx.strokeStyle = '#281536'; ctx.lineWidth = 4;
        ctx.strokeText('♛ DIỆT BOSS', x, y - ui.nameOffset - 28);
        ctx.fillText('♛ DIỆT BOSS', x, y - ui.nameOffset - 28);
        outline(x, y - 4, ui.playerRadius + 12 + Math.sin(elapsed * 4) * 3, '#ffce60', 2);
        ctx.restore();
      }
      ctx.fillStyle = colors.text; ctx.font = `bold ${ui.nameFontSize}px ${ui.canvasFont}`;
      ctx.strokeStyle = '#061023'; ctx.lineWidth = 4;
      ctx.strokeText(player.name, x, y - ui.nameOffset, ui.nameMaxWidth);
      ctx.fillText(player.name, x, y - ui.nameOffset, ui.nameMaxWidth);
      ctx.font = `${ui.classIconSize}px ${ui.canvasFont}`;
      ctx.fillText(ui.classIcons[player.classId] ?? '?', x + ui.classIconOffset, y + ui.classIconOffsetY);
      bar(x, y + ui.hpBarOffset, ui.hpBarWidth, ui.hpBarHeight, player.hp, player.maxHp);
      if (hit) {
        const decay = clamp(1 - (elapsed - hit.at) / (ui.hpTrailMs / 1000), 0, 1);
        const lost = Math.max(0, hit.hp - player.hp) * decay;
        if (lost > 0) {
          ctx.fillStyle = '#ffbe62';
          ctx.fillRect(x - ui.hpBarWidth / 2 + ui.hpBarWidth * player.hp / player.maxHp, y + ui.hpBarOffset,
            ui.hpBarWidth * lost / player.maxHp, ui.hpBarHeight);
        }
        if (!decay) hits.delete(player.id);
      }
      const fullMana = player.mana >= player.maxMana - 1e-8;
      ctx.save();
      if (fullMana) { ctx.shadowColor = '#b3edff'; ctx.shadowBlur = 10; }
      bar(x, y + ui.hpBarOffset + ui.hpBarHeight + ui.manaBarGap, ui.hpBarWidth, ui.manaBarHeight,
        player.mana, player.maxMana, fullMana ? '#e0faff' : '#38bcff');
      ctx.restore();
    }
  }

  function shake(amount) { shakeAmount = amount; shakeUntil = elapsed + ui.shakeDurationMs / 1000; }
  off.push(bus.on('player:killed', (payload) => { if (payload?.victimId) deaths.set(String(payload.victimId), elapsed); }));
  off.push(bus.on('player:revived', (payload) => { if (payload?.playerId) { deaths.delete(String(payload.playerId)); hits.delete(String(payload.playerId)); } }));
  off.push(bus.on('boss:spawned', () => { bossMotion = null; bossSwingUntil = 0; shake(ui.bossShake); }));
  off.push(bus.on('boss:defeated', () => { bossMotion = null; bossSwingUntil = 0; shake(ui.bossShake); }));
  off.push(bus.on('player:damaged', (payload) => {
    const player = state.players.get(String(payload?.targetId));
    if (player && payload.amount > 0) {
      const previous = hits.get(player.id);
      hits.set(player.id, { at: elapsed, hp: Math.min(player.maxHp, Math.max(player.hp + payload.amount,
        previous && elapsed - previous.at < ui.hpTrailMs / 1000 ? previous.hp : 0)) });
    }
    if (state.boss && payload?.cause === 'boss' && payload.sourceId === state.boss.id) {
      bossSwingUntil = elapsed + ui.bossSwingDurationMs / 1000;
    }
  }));
  off.push(bus.on('ultimate:fire', () => { if (state.phase === 'BATTLE' || state.phase === 'FINAL') shake(ui.ultimateShake); }));
  off.push(bus.on('round:phase', (payload) => {
    if (payload?.phase === 'LOBBY') { deaths.clear(); hits.clear(); bossMotion = null; bossSwingUntil = 0; shakeUntil = 0; camera.zoom = 1; camera.cx = state.arena.cx; camera.cy = state.arena.cy; }
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
    dispose() { if (disposed) return; disposed = true; artwork.dispose(); effects.dispose(); off.splice(0).forEach((unsubscribe) => unsubscribe()); for (const entry of avatars.values()) releaseAvatar(entry); avatars.clear(); deaths.clear(); hits.clear(); frameListeners.clear(); background = null; },
    get particleCount() { return effects.particleCount; },
    get camera() { return { ...camera }; },
    get avatarStats() { return { cached: avatars.size, loaded: [...avatars.values()].filter((entry) => entry.tile).length, failed: [...avatars.values()].filter((entry) => entry.failed).length }; },
  };
}
