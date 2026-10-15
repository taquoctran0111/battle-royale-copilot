export const bossEffectFrames = 8;
export const bossEffectSize = 256;

// Rasterize once per variant/action; gameplay state and source images stay untouched.
export function createBossEffectSprites({ document, config }) {
  const sheets = new Map();

  function sheet(type, action) {
    const key = `${type}:${action}`;
    if (sheets.has(key)) return sheets.get(key);
    if (!document?.createElement) return null;
    const canvas = document.createElement('canvas');
    canvas.width = bossEffectSize * bossEffectFrames;
    canvas.height = bossEffectSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Boss effect sprites require Canvas 2D');
    const definition = config.bosses[type];
    if (!definition) return null;
    for (let frame = 0; frame < bossEffectFrames; frame++) {
      const t = (frame + 1) / bossEffectFrames;
      ctx.save();
      ctx.translate(frame * bossEffectSize + 128, 128);
      ctx.beginPath(); ctx.rect(-128, -128, 256, 256); ctx.clip();
      ctx.globalAlpha = Math.sin(t * Math.PI) * .7 + .25;
      ctx.strokeStyle = definition.color;
      ctx.fillStyle = definition.color;
      ctx.shadowColor = definition.color; ctx.shadowBlur = 12;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (action === 'attack') {
        for (let slash = 0; slash < 3; slash++) {
          ctx.lineWidth = 9 - slash * 2;
          ctx.beginPath();
          ctx.arc(-38, 0, 55 + slash * 18, -.95 + t * .55, .2 + t * 1.1);
          ctx.stroke();
        }
        ctx.fillStyle = '#f2ffff';
        ctx.beginPath(); ctx.arc(25 + t * 55, 0, 9 * (1 - t) + 2, 0, Math.PI * 2); ctx.fill();
      } else {
        for (let i = 0; i < 12; i++) {
          const element = type === 'fusion' ? config.bosses.minorOrder[i % 4] : type;
          const color = config.bosses[element].color;
          ctx.strokeStyle = ctx.fillStyle = ctx.shadowColor = color;
          const angle = i * Math.PI / 6;
          ctx.save(); ctx.rotate(angle);
          const r = 18 + t * 85;
          ctx.lineWidth = 4;
          ctx.beginPath();
          if (element === 'fire') {
            ctx.moveTo(r - 30, -12); ctx.quadraticCurveTo(r + 8, -24, r + 15, 0);
            ctx.quadraticCurveTo(r - 5, -4, r - 24, 14); ctx.closePath(); ctx.fill();
          } else if (element === 'ice') {
            ctx.moveTo(r - 28, -10); ctx.lineTo(r + 15, 0);
            ctx.lineTo(r - 28, 10); ctx.lineTo(r - 18, 0); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = '#e8ffff'; ctx.stroke();
          } else if (element === 'forest') {
            ctx.moveTo(0, 0); ctx.bezierCurveTo(25, -30, r - 25, 28, r, 0); ctx.stroke();
            ctx.beginPath(); ctx.ellipse(r - 6, -7, 15, 6, -.5, 0, Math.PI * 2); ctx.fill();
          } else {
            ctx.rotate(t * 3);
            ctx.arc(0, 0, Math.max(5, 110 * (1 - t)), -.5, .7); ctx.stroke();
          }
          ctx.restore();
        }
        ctx.strokeStyle = '#f1eaff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 8 + t * 96, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
    sheets.set(key, canvas);
    return canvas;
  }

  return {
    draw(ctx, { type, action, progress, x, y, radius, angle = 0 }) {
      const atlas = sheet(type, action);
      if (!atlas) return false;
      const frame = Math.min(bossEffectFrames - 1, Math.max(0, Math.floor(progress * bossEffectFrames)));
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
      ctx.drawImage(atlas, frame * bossEffectSize, 0, bossEffectSize, bossEffectSize, -radius, -radius, radius * 2, radius * 2);
      ctx.restore();
      return true;
    },
    get sheetCount() { return sheets.size; },
    dispose() { sheets.clear(); },
  };
}
