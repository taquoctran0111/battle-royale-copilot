import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { artworkPaths, transparentBossKeys, clearConnectedBackdrop, createArtwork } from '../client/render/artwork.js';
import { createBossEffectSprites, bossEffectFrames, bossEffectSize } from '../client/render/bossEffectSprites.js';
import config from '../client/core/config.js';
import { createState } from '../client/core/gameState.js';
import { createEventBus } from '../client/core/eventBus.js';
import { createPlayer } from '../client/entities/playerFactory.js';
import { createRenderer } from '../client/render/renderer.js';

test('artwork: removes connected white/checkerboard and preserves enclosed highlights', () => {
  const width = 7, height = 7;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ring = x >= 2 && x <= 4 && y >= 2 && y <= 4 && !(x === 3 && y === 3);
      const color = ring ? [190, 30, 90] : [(x + y) % 2 ? 205 : 255, (x + y) % 2 ? 205 : 255, (x + y) % 2 ? 205 : 255];
      data.set([...color, 255], (y * width + x) * 4);
    }
  }
  clearConnectedBackdrop(data, width, height);
  assert.equal(data[3], 0);
  assert.equal(data[(3 * width + 3) * 4 + 3], 255);
  assert.equal(data[(2 * width + 2) * 4 + 3], 255);
  assert.equal(data[(6 * width + 6) * 4 + 3], 0);
});

test('artwork: every mapped image exists and has a valid PNG header', () => {
  for (const path of Object.values(artworkPaths)) {
    const bytes = readFileSync(new URL(`../client/${path}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG', path);
    assert.ok(bytes.readUInt32BE(16) > 0, path);
    assert.ok(bytes.readUInt32BE(20) > 0, path);
  }
});

test('boss artwork: five distinct replacement PNGs have alpha and load whole without old card crops', () => {
  assert.equal(transparentBossKeys.size, 5);
  assert.equal(new Set([...transparentBossKeys].map((key) => artworkPaths[key])).size, 5);
  for (const key of transparentBossKeys) {
    const bytes = readFileSync(new URL(`../client/${artworkPaths[key]}`, import.meta.url));
    assert.equal(bytes[25], 6, 'RGBA PNG preserves supplied transparency');
  }
});

test('artwork: processes sprites once, reports errors and releases image handlers', () => {
  const previous = globalThis.Image;
  const pending = [], loaded = [], errors = [], draws = [];
  globalThis.Image = class {
    constructor() { this.naturalWidth = 512; this.naturalHeight = 512; pending.push(this); }
  };
  const paint = {
    drawImage(...args) { draws.push(args); },
    getImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4) }),
    putImageData() {},
  };
  try {
    const artwork = createArtwork({
      document: { createElement: () => ({ getContext: () => paint }) },
      onLoad: (key) => loaded.push(key),
      onError: (path, error) => errors.push({ path, error }),
    });

    pending[0].onload();
    assert.equal(artwork.get('forest'), pending[0]);
    pending[1].onload();
    assert.ok(artwork.get('swordsman'));
    pending.at(-1).onload();
    assert.equal(draws.at(-1)[2], 145);
    pending[2].onerror();
    assert.equal(errors.length, 1);
    assert.match(errors[0].path, /asset-16/);
    assert.deepEqual(loaded, ['forest', 'swordsman', 'boss']);
    const drawCount = draws.length;
    for (const key of transparentBossKeys) {
      const image = pending[Object.keys(artworkPaths).indexOf(key)];
      image.onload();
      assert.equal(artwork.get(key), image, 'alpha artwork and full silhouette stay untouched');
    }
    assert.equal(draws.length, drawCount, 'boss images do not enter backdrop cleanup or crop pipeline');
    artwork.dispose();
    assert.equal(artwork.get('forest'), undefined);
    for (const image of pending) {
      assert.equal(image.onload, null);
      assert.equal(image.onerror, null);
      assert.equal(image.src, '');
    }
  } finally {
    if (previous === undefined) delete globalThis.Image;
    else globalThis.Image = previous;
  }
});

test('boss effect sprites: eight-frame attack/skill atlases cache per boss, select frames and release on dispose', () => {
  const calls = [], canvases = [];
  const paint = new Proxy({}, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
  const sprites = createBossEffectSprites({ config, document: { createElement() {
    const canvas = { getContext: () => paint }; canvases.push(canvas); return canvas;
  } } });
  for (const type of [...config.bosses.minorOrder, 'fusion']) {
    for (const action of ['attack', 'skill']) {
      assert.equal(sprites.draw(paint, { type, action, progress: 0, x: 10, y: 20, radius: 80 }), true);
      const canvas = canvases.at(-1);
      assert.equal(canvas.width, bossEffectSize * bossEffectFrames);
      assert.equal(canvas.height, bossEffectSize);
      const count = canvases.length;
      sprites.draw(paint, { type, action, progress: 1, x: 10, y: 20, radius: 80 });
      assert.equal(canvases.length, count, 'reuse atlas rather than rasterize every frame');
      const draw = calls.filter(([method]) => method === 'drawImage').at(-1);
      assert.equal(draw[1], canvas);
      assert.equal(draw[2], (bossEffectFrames - 1) * bossEffectSize);
    }
  }
  assert.equal(sprites.sheetCount, 10);
  sprites.dispose();
  assert.equal(sprites.sheetCount, 0);
});

test('artwork renderer: forest uses cover, automatic fighters use action art, transparent mode omits forest', () => {
  const previous = globalThis.Image;
  const pending = [], calls = [];
  globalThis.Image = class {
    constructor() { this.naturalWidth = 512; this.naturalHeight = 512; pending.push(this); }
  };
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(512 * 512 * 4) }),
  }, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]) });
  const surfaces = [];
  const document = { createElement() {
    const surface = { getContext: () => context };
    surfaces.push(surface);
    return surface;
  } };
  const cfg = structuredClone(config);
  const state = createState(cfg);
  const bus = createEventBus(cfg);
  const player = createPlayer({ id: 'sprite-test' }, state, cfg, 'swordsman');
  state.boss = { id: 'boss-art', x: player.x + 30, y: player.y, hp: 500, maxHp: 500 };
  player.targetId = state.boss.id;
  state.players.set(player.id, player);
  const before = structuredClone(state);
  let renderer;
  try {
    renderer = createRenderer({ canvas: { ownerDocument: document, getContext: () => context }, bus, state, config: cfg });
    const forest = pending[0];
    forest.naturalWidth = 1024; forest.naturalHeight = 1536;
    forest.onload();
    assert.ok(calls.some(([method, image, x, y, w, h]) => method === 'drawImage' && image === forest && x === -100 && y === 0 && w === 1280 && h === 1920));
    pending[2].onload();
    const actionSprite = surfaces.at(-1);
    calls.length = 0;
    renderer.update(.2);
    renderer.render();
    assert.ok(calls.some(([method, image]) => method === 'drawImage' && image === actionSprite));
    cfg.transparent = true;
    calls.length = 0;
    renderer.resize(); renderer.render();
    assert.equal(calls.some(([method, image]) => method === 'drawImage' && image === forest), false);
    assert.deepEqual(state, before);
  } finally {
    renderer?.dispose();
    if (previous === undefined) delete globalThis.Image;
    else globalThis.Image = previous;
  }
});
