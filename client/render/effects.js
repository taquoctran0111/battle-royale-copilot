export function createEffects({ bus, state, config }) {
  const off = [];
  const particles = [];
  const cap = config.ui.maxParticles;
  const ui = config.ui;
  const colors = ui.renderColors;
  let disposed = false;
  let bossPosition = { x: state.arena.cx, y: state.arena.cy };

  function particle(kind, x, y, color, lifeMs, extra = {}) {
    if (disposed || particles.length >= cap || !Number.isFinite(x) || !Number.isFinite(y)) return;
    particles.push({ kind, x, y, prevX: x, prevY: y, vx: 0, vy: 0, life: lifeMs / 1000, maxLife: lifeMs / 1000, color, ...extra });
  }

  function popup(x, y, text, color, size = ui.effectPopupFontSize) {
    particle('popup', x, y, color, ui.effectPopupLifeMs, { text, size, vy: -ui.effectPopupRise });
  }

  function ring(x, y, color, radius = ui.effectRingRadius) {
    particle('ring', x, y, color, ui.effectWaveLifeMs, { radius });
  }

  const playerAt = (id) => state.players.get(String(id));
  function listen(type, handler) { off.push(bus.on(type, (payload) => { if (!disposed && payload) handler(payload); })); }

  function add(x, y, color, count = 1) {
    for (let index = 0; index < count && particles.length < cap; index += 1) {
      particle('spark', x, y, color, ui.particleLifeMs, { vx: (Math.random() - 0.5) * ui.particleSpeed, vy: (Math.random() - 0.5) * ui.particleSpeed });
    }
  }

  listen('player:damaged', ({ targetId, amount, crit }) => {
    const player = playerAt(targetId);
    if (!player || !Number.isFinite(amount) || amount <= 0) return;
    popup(player.x, player.y - ui.nameOffset, `${crit ? '!' : ''}${Math.round(amount)}`, crit ? colors.crit : colors.damage, crit ? ui.critFontSize : ui.damageFontSize);
    add(player.x, player.y, colors.damage, ui.damageParticleCount);
  });
  listen('player:killed', ({ victimId, killerId }) => {
    const player = playerAt(victimId);
    if (!player) return;
    popup(player.x, player.y, `${playerAt(killerId)?.name ?? 'Zone'} > ${player.name}`, colors.crit);
    add(player.x, player.y, colors.crit, ui.killParticleCount);
    ring(player.x, player.y, colors.crit);
  });
  listen('player:revived', ({ playerId }) => {
    const player = playerAt(playerId);
    if (player) { particle('beam', player.x, player.y, colors.revive, ui.effectBeamLifeMs); popup(player.x, player.y, player.name, colors.revive); }
  });
  listen('buff:apply', ({ playerId, type, durationMs }) => {
    const player = playerAt(playerId);
    if (player && durationMs > 0) ring(player.x, player.y, type === 'rage' ? colors.rage : colors.shield);
  });
  listen('gift:effect', ({ toId, tier }) => {
    const player = playerAt(toId);
    if (player?.status === 'alive' && (state.phase === 'BATTLE' || state.phase === 'FINAL')) add(player.x, player.y, ui.tierColors[tier] ?? colors.fallback, ui.giftParticleCount);
  });
  listen('drop:spawned', ({ x, y }) => particle('beam', x, y, colors.supply, ui.effectBeamLifeMs));
  listen('trap:triggered', ({ x, y }) => { add(x, y, colors.bomb, ui.trapParticleCount); ring(x, y, colors.bomb); });
  listen('boss:spawned', () => {
    bossPosition = state.boss ?? { x: state.arena.cx, y: state.arena.cy };
    ring(bossPosition.x, bossPosition.y, colors.rage, ui.bossRadius * 2);
    particle('beam', bossPosition.x, bossPosition.y, colors.rage, ui.effectBeamLifeMs);
  });
  listen('boss:defeated', () => { add(bossPosition.x, bossPosition.y, colors.crit, ui.killParticleCount); ring(bossPosition.x, bossPosition.y, colors.crit, ui.bossRadius * 2); });
  listen('ultimate:fire', (payload) => {
    if (state.phase !== 'BATTLE' && state.phase !== 'FINAL') return;
    const source = state.players.get(String(payload?.byId));
    if (source) { add(source.x, source.y, ui.tierColors[4], ui.ultimateParticleCount); ring(source.x, source.y, colors.rage, Math.hypot(state.arena.w, state.arena.h)); }
  });
  listen('ally:formed', ({ aId, bId }) => {
    const first = playerAt(aId), second = playerAt(bId);
    if (first && second) particle('heart', (first.x + second.x) / 2, (first.y + second.y) / 2, colors.revive, ui.effectPopupLifeMs, { vy: -ui.effectPopupRise });
  });
  listen('ally:betrayed', ({ betrayerId, victimId }) => {
    const first = playerAt(betrayerId), second = playerAt(victimId);
    if (first && second) { particle('heart', (first.x + second.x) / 2, (first.y + second.y) / 2, colors.rage, ui.effectPopupLifeMs, { broken: true, vy: -ui.effectPopupRise }); ring(second.x, second.y, colors.rage); }
  });
  listen('bounty:set', ({ playerId }) => { const player = playerAt(playerId); if (player) { ring(player.x, player.y, colors.rage); popup(player.x, player.y, config.bounty.title, colors.rage); } });
  listen('round:phase', ({ phase }) => { if (phase === 'LOBBY') particles.length = 0; });

  function update(dt) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      const particle = particles[index];
      particle.life -= dt;
      if (particle.life <= 0) { particles.splice(index, 1); continue; }
      particle.prevX = particle.x;
      particle.prevY = particle.y;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      if (particle.kind === 'spark') { particle.vx *= ui.particleDrag; particle.vy *= ui.particleDrag; }
    }
  }

  function render(ctx, alpha = 1) {
    if (disposed) return;
    ctx.textAlign = 'center';
    for (const particle of particles) {
      ctx.globalAlpha = particle.life / particle.maxLife;
      ctx.fillStyle = particle.color;
      ctx.strokeStyle = particle.color;
      const x = particle.prevX + (particle.x - particle.prevX) * alpha;
      const y = particle.prevY + (particle.y - particle.prevY) * alpha;
      if (particle.kind === 'popup' || particle.kind === 'heart') {
        ctx.font = `bold ${particle.size ?? ui.effectHeartSize}px ${ui.canvasFont}`;
        ctx.fillText(particle.kind === 'heart' ? (particle.broken ? '\u2665 /' : '\u2665') : particle.text, x, y, ui.effectTextWidth);
      } else if (particle.kind === 'beam') {
        ctx.fillRect(x - ui.particleRadius, y - ui.effectBeamHeight * particle.life / particle.maxLife, ui.particleRadius * 2, ui.effectBeamHeight * particle.life / particle.maxLife);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, particle.kind === 'ring' ? Math.max(ui.particleRadius, particle.radius * (1 - particle.life / particle.maxLife)) : ui.particleRadius, 0, Math.PI * 2);
        if (particle.kind === 'ring') { ctx.lineWidth = ui.rageLineWidth; ctx.stroke(); } else ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  return { update, render, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); particles.length = 0; }, get particleCount() { return particles.length; } };
}
