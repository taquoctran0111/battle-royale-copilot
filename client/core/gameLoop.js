export function createGameLoop({ systems, inputRouter, renderer, config, isHidden = () => Boolean(globalThis.document?.hidden), requestFrame = globalThis.requestAnimationFrame, cancelFrame = globalThis.cancelAnimationFrame, log = console.error }) {
  const step = 1 / config.tickRate;
  const failures = new Map();
  const disabled = new Set();
  let accumulator = 0;
  let previousFrame = null;
  let animationFrame = null;
  let running = false;
  let disposed = false;

  function update(name, system) {
    if (!system || disabled.has(system)) return;
    try {
      system.update(step);
      failures.set(system, 0);
    } catch (error) {
      const count = (failures.get(system) ?? 0) + 1;
      failures.set(system, count);
      log(`[game] ${name} update failed:`, error);
      if (count >= config.runtime.systemErrorLimit) { disabled.add(system); log(`[game] disabled ${name}`); }
    }
  }

  function resetClock() { previousFrame = null; accumulator = 0; }

  function advance(timestamp) {
    if (disposed || !Number.isFinite(timestamp)) return;
    if (isHidden()) { resetClock(); return; }
    if (previousFrame === null) previousFrame = timestamp;
    const elapsed = Math.max(0, Math.min(timestamp - previousFrame, config.runtime.maxFrameDeltaMs));
    previousFrame = timestamp;
    accumulator += elapsed / 1000;
    let steps = 0;
    while (accumulator >= step && steps < config.runtime.maxStepsPerFrame) {
      update('inputRouter', inputRouter);
      for (const [name, system] of systems) update(name, system);
      accumulator -= step;
      steps += 1;
    }
    if (steps === config.runtime.maxStepsPerFrame && accumulator >= step) accumulator %= step;
    try { renderer.render(accumulator / step); }
    catch (error) { log('[game] render failed:', error); }
  }

  function frame(timestamp) {
    if (!running || disposed) return;
    advance(timestamp);
    animationFrame = requestFrame(frame);
  }

  return {
    advance, resetClock,
    start() { if (disposed || running) return; running = true; animationFrame = requestFrame(frame); },
    get disabledSystems() { return ['inputRouter', ...systems.map(([name]) => name)].filter((name, index) => disabled.has(index === 0 ? inputRouter : systems[index - 1][1])); },
    dispose() { disposed = true; running = false; if (animationFrame !== null) cancelFrame?.(animationFrame); failures.clear(); disabled.clear(); resetClock(); },
  };
}