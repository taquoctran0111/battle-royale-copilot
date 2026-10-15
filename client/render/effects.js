import { createBossEffectSprites } from './bossEffectSprites.js';

export function createEffects({ bus, state, config, document = globalThis.document }) {
  const off = [];
  const particles = [];
  const cap = config.ui.maxParticles;
  const ui = config.ui;
  const colors = ui.renderColors;
  const bossSprites = createBossEffectSprites({ document, config });
  let disposed = false;
  let bossPosition = { x: state.arena.cx, y: state.arena.cy };
  let stormUntil = 0;
  let weatherTime = 0;
  const meteors = new Map();
  const active = () => state.phase === 'BATTLE' || state.phase === 'FINAL';

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
    popup(player.x, player.y - ui.nameOffset - 16, `-${Math.round(amount)}${crit ? '!' : ''}`, crit ? colors.crit : '#ff627b', crit ? ui.critFontSize : ui.damageFontSize);
    add(player.x, player.y, colors.damage, ui.damageParticleCount);
  });
  listen('boss:attack', ({ bossType, x, y, targetX, targetY }) => {
    if (!active()) return;
    particle('bossAttack', (x + targetX) / 2, (y + targetY) / 2,
      config.bosses[bossType].color, 450, { bossType, angle: Math.atan2(targetY - y, targetX - x), radius: 85 });
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
  listen('skill:cast', ({ playerId, classId, x, y, targetX, targetY, radius }) => {
    if (!active()) return;
    const color = config.classes[classId].color;
    popup(x, y - ui.nameOffset - 30, config.skills[classId].name, color);
    particle('skill', x, y, color, 800, { classId, targetX, targetY, radius });
    if (classId === 'mage') add(targetX, targetY, color, 12);
    if (classId === 'tank' && playerAt(playerId)) ring(x, y, '#7eeaff', radius);
  });
  listen('gift:effect', ({ toId, tier }) => {
    const player = playerAt(toId);
    if (player?.status === 'alive' && (state.phase === 'BATTLE' || state.phase === 'FINAL')) add(player.x, player.y, ui.tierColors[tier] ?? colors.fallback, ui.giftParticleCount);
  });
  listen('drop:spawned', ({ x, y }) => particle('beam', x, y, colors.supply, ui.effectBeamLifeMs));
  listen('event:triggered', ({ type }) => {
    if (type === 'storm' && active()) stormUntil = state.time + (config.events.list.find((event) => event.type === 'storm')?.durationSec ?? 0);
  });
  listen('trap:spawned', ({ id }) => {
    const trap = state.traps.find((entry) => entry.id === id);
    if (trap?.visual === 'meteor') meteors.set(id, trap.radius);
  });
  listen('trap:triggered', ({ id, x, y }) => {
    add(x, y, colors.bomb, ui.trapParticleCount);
    ring(x, y, colors.bomb, meteors.get(id) ?? ui.effectRingRadius);
    if (meteors.has(id)) {
      particle('impact', x, y, '#ffb34d', ui.effectWaveLifeMs, { radius: meteors.get(id) });
      meteors.delete(id);
    }
  });
  listen('boss:spawned', () => {
    bossPosition = state.boss ?? { x: state.arena.cx, y: state.arena.cy };
    ring(bossPosition.x, bossPosition.y, colors.rage, ui.bossRadius * 2);
    particle('beam', bossPosition.x, bossPosition.y, colors.rage, ui.effectBeamLifeMs);
  });
  listen('boss:skill', ({ bossType, stage, x, y, radius }) => {
    if (!active()) return;
    const definition = config.bosses[bossType];
    popup(x, y - 95, definition.skill.name, definition.color, 24);
    if (stage === 'impact') {
      particle('bossSkill', x, y, definition.color, 1100, { bossType, radius });
      add(x, y, definition.color, 18);
    }
  });
  listen('boss:defeated', ({ killerId, bossType, x, y }) => {
    const point = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : bossPosition;
    add(point.x, point.y, colors.crit, ui.killParticleCount);
    ring(point.x, point.y, colors.crit, ui.bossRadius * 3);
    if (bossType === 'fusion') {
      const killer = playerAt(killerId);
      if (killer) {
        popup(killer.x, killer.y - ui.nameOffset - 45, '♛ DIỆT BOSS HỢP THỂ', '#ffdf77', 28);
        particle('beam', killer.x, killer.y, '#ffdf77', 2000);
      }
    }
  });
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
  listen('round:phase', ({ phase }) => {
    if (phase === 'LOBBY' || phase === 'RESULT') {
      stormUntil = 0; meteors.clear(); particles.length = 0;
    }
  });

  function update(dt) {
    if (disposed || !Number.isFinite(dt) || dt <= 0) return;
    weatherTime += dt;
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
    if (active()) {
      if (state.time < stormUntil) {
        ctx.fillStyle = 'rgba(8,20,57,.28)';
        ctx.fillRect(0, 0, state.arena.w, state.arena.h);
        ctx.strokeStyle = 'rgba(141,209,255,.55)'; ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 90; i++) {
          const x = ((i * 137.51 - weatherTime * 230) % state.arena.w + state.arena.w) % state.arena.w;
          const y = (i * 211.73 + weatherTime * 740) % state.arena.h;
          ctx.moveTo(x, y); ctx.lineTo(x - 16, y + 45);
        }
        ctx.stroke();
        const flash = weatherTime % 2.7;
        if (flash < .16) {
          ctx.fillStyle = 'rgba(180,213,255,.18)'; ctx.fillRect(0, 0, state.arena.w, state.arena.h);
          ctx.strokeStyle = '#ccedff'; ctx.lineWidth = 4; ctx.shadowColor = '#51aeff'; ctx.shadowBlur = 22;
          const x = state.arena.w * (.25 + .5 * Math.abs(Math.sin(Math.floor(weatherTime / 2.7) * 7)));
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 45, 120); ctx.lineTo(x + 20, 100); ctx.lineTo(x - 65, 290); ctx.stroke();
          ctx.shadowBlur = 0;
        }
      }
      for (const trap of state.traps) {
        if (trap.visual !== 'meteor') continue;
        const remaining = (trap.fuseAt - state.time * 1000) / trap.flightMs;
        ctx.strokeStyle = '#ff6945'; ctx.lineWidth = 3;
        ctx.fillStyle = 'rgba(255,65,25,.13)';
        ctx.beginPath(); ctx.arc(trap.x, trap.y, trap.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(trap.x, trap.y, trap.radius * (1 - Math.min(1, Math.max(0, remaining))), 0, Math.PI * 2); ctx.stroke();
        if (remaining > 1 || remaining < 0) continue;
        const x = trap.x - remaining * 260, y = trap.y - remaining * 520;
        ctx.strokeStyle = '#ff7c32'; ctx.lineWidth = 16; ctx.shadowColor = '#ff6026'; ctx.shadowBlur = 25;
        ctx.beginPath(); ctx.moveTo(x - 80, y - 160); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = '#ffedac'; ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
    for (const particle of particles) {
      ctx.globalAlpha = particle.life / particle.maxLife;
      ctx.fillStyle = particle.color;
      ctx.strokeStyle = particle.color;
      const x = particle.prevX + (particle.x - particle.prevX) * alpha;
      const y = particle.prevY + (particle.y - particle.prevY) * alpha;
      if (particle.kind === 'bossAttack') {
        bossSprites.draw(ctx, { type: particle.bossType, action: 'attack',
          progress: 1 - particle.life / particle.maxLife, x, y, radius: particle.radius, angle: particle.angle });
      } else if (particle.kind === 'skill') {
        const progress = 1 - particle.life / particle.maxLife;
        ctx.save(); ctx.shadowColor = particle.color; ctx.shadowBlur = 18; ctx.lineWidth = 5;
        if (particle.classId === 'archer') {
          for (let i = 0; i < 3; i++) {
            const t = Math.min(1, progress * 2 + i * .12);
            const endX = x + (particle.targetX - x) * t;
            const endY = y + (particle.targetY - y) * t + (i - 1) * 10;
            const angle = Math.atan2(particle.targetY - y, particle.targetX - x);
            ctx.beginPath(); ctx.moveTo(endX - Math.cos(angle) * 45, endY - Math.sin(angle) * 45);
            ctx.lineTo(endX, endY);
            ctx.lineTo(endX - Math.cos(angle - .6) * 12, endY - Math.sin(angle - .6) * 12);
            ctx.moveTo(endX, endY);
            ctx.lineTo(endX - Math.cos(angle + .6) * 12, endY - Math.sin(angle + .6) * 12); ctx.stroke();
          }
        } else if (particle.classId === 'swordsman') {
          for (let i = 0; i < 3; i++) {
            const angle = progress * Math.PI * 5 + i * Math.PI * 2 / 3;
            ctx.beginPath(); ctx.arc(x, y, particle.radius * (.35 + progress * .65), angle, angle + 1.5); ctx.stroke();
          }
        } else if (particle.classId === 'mage') {
          const r = particle.radius * Math.min(1, progress * 3);
          ctx.globalAlpha *= .55; ctx.beginPath();
          ctx.arc(particle.targetX, particle.targetY, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.beginPath();
          for (let i = 0; i <= 6; i++) {
            const angle = i * Math.PI / 3 + progress;
            ctx.lineTo(particle.targetX + Math.cos(angle) * r, particle.targetY + Math.sin(angle) * r);
          }
          ctx.stroke();
        } else {
          ctx.beginPath(); ctx.ellipse(x, y - 10, 45 + progress * 20, 60 + progress * 25, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.font = `bold 24px ${ui.canvasFont}`; ctx.fillText('+', x, y - 25 - progress * 40);
        }
        ctx.restore();
      } else if (particle.kind === 'bossSkill') {
        const progress = 1 - particle.life / particle.maxLife;
        if (bossSprites.draw(ctx, { type: particle.bossType, action: 'skill', progress, x, y, radius: particle.radius })) continue;
        ctx.save(); ctx.shadowColor = particle.color; ctx.shadowBlur = 20; ctx.lineWidth = 4;
        for (let i = 0; i < 12; i++) {
          const angle = i * Math.PI / 6 + (particle.bossType === 'dark' ? progress * 4 : 0);
          const r = particle.radius * (particle.bossType === 'dark' ? 1 - progress : progress);
          if (particle.bossType === 'fusion') ctx.strokeStyle = config.bosses[config.bosses.minorOrder[i % 4]].color;
          ctx.beginPath();
          if (particle.bossType === 'ice') {
            ctx.moveTo(x + Math.cos(angle - .08) * r * .65, y + Math.sin(angle - .08) * r * .65);
            ctx.lineTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
            ctx.lineTo(x + Math.cos(angle + .08) * r * .65, y + Math.sin(angle + .08) * r * .65);
          } else {
            ctx.arc(x, y, Math.max(1, r), angle, angle + .3);
          }
          ctx.stroke();
        }
        ctx.restore();
      } else if (particle.kind === 'impact') {
        ctx.beginPath(); ctx.arc(x, y, Math.max(1, particle.radius * (1 - particle.life / particle.maxLife)), 0, Math.PI * 2);
        ctx.globalAlpha *= .5; ctx.fill(); ctx.lineWidth = 6; ctx.stroke();
      } else if (particle.kind === 'popup' || particle.kind === 'heart') {
        ctx.font = `bold ${particle.size ?? ui.effectHeartSize}px ${ui.canvasFont}`;
        ctx.strokeStyle = '#07101f'; ctx.lineWidth = 5;
        ctx.strokeText(particle.kind === 'heart' ? (particle.broken ? '\u2665 /' : '\u2665') : particle.text, x, y, ui.effectTextWidth);
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

  return { update, render, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); particles.length = 0; meteors.clear(); stormUntil = 0; bossSprites.dispose(); }, get particleCount() { return particles.length; } };
}
