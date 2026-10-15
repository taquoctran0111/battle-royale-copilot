export const artworkPaths = {
  forest: './assets/backgroud.png',
  swordsman: './assets/sprite/asset-13.png',
  swordsmanAction: './assets/sprite/asset-16.png',
  mage: './assets/sprite/asset-17.png',
  mageAction: './assets/sprite/asset-18.png',
  archer: './assets/sprite/asset-29.png',
  archerAction: './assets/sprite/asset-31.png',
  tank: './assets/sprite/asset-23.png',
  tankAction: './assets/sprite/asset-24.png',
  fire: './assets/boss/asset-1_34.png',
  ice: './assets/boss/asset-4_41.png',
  forestBoss: './assets/boss/asset-3_27.png',
  dark: './assets/boss/asset-2_44.png',
  fusion: './assets/boss/asset-5_36.png',
  boss: './assets/sprite/asset-12.png',
};

export const transparentBossKeys = new Set(['fire', 'ice', 'forestBoss', 'dark', 'fusion']);

// The supplied PNGs contain an opaque checkerboard, not an alpha channel.
export function clearConnectedBackdrop(data, width, height) {
  const visited = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let head = 0, tail = 0;
  const visit = (index) => {
    if (visited[index]) return;
    visited[index] = 1;
    const offset = index * 4;
    const max = Math.max(data[offset], data[offset + 1], data[offset + 2]);
    const min = Math.min(data[offset], data[offset + 1], data[offset + 2]);
    if (data[offset + 3] === 0 || (min >= 145 && max - min <= 32)) {
      data[offset + 3] = 0;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) visit(index - 1);
    if (x < width - 1) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index < width * (height - 1)) visit(index + width);
  }
}

export function createArtwork({ document, onLoad, onError }) {
  const images = new Map();
  const pending = [];
  let disposed = false;
  if (typeof globalThis.Image === 'function') {
    for (const [key, path] of Object.entries(artworkPaths)) {
      const image = new Image();
      pending.push(image);
      image.onload = () => {
        if (disposed) return;
        try {
          if (key === 'forest' || transparentBossKeys.has(key)) images.set(key, image);
          else {
            const surface = document.createElement('canvas');
            // Exclude the baked-in BOSS title and health bar.
            const top = key === 'boss' ? 145 : 0;
            const crop = [0, top, image.naturalWidth, image.naturalHeight - top];
            surface.width = crop[2];
            surface.height = crop[3];
            const paint = surface.getContext('2d', { willReadFrequently: true });
            if (!paint) throw new Error('Canvas 2D is unavailable');
            paint.drawImage(image, ...crop, 0, 0, surface.width, surface.height);
            const pixels = paint.getImageData(0, 0, surface.width, surface.height);
            clearConnectedBackdrop(pixels.data, surface.width, surface.height);
            paint.putImageData(pixels, 0, 0);
            images.set(key, surface);
          }
          onLoad(key);
        } catch (error) { onError(path, error); }
      };
      image.onerror = () => { if (!disposed) onError(path, new Error('Image failed to load')); };
      image.src = path;
    }
  }
  return {
    get: (key) => images.get(key),
    dispose() {
      disposed = true;
      for (const image of pending) { image.onload = null; image.onerror = null; image.src = ''; }
      images.clear();
    },
  };
}
