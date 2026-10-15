export function createAudio({ bus, button, volumeInput, enabled, config, now = () => Date.now() }) {
  const off = [];
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  let active = Boolean(enabled ?? params.get('audio') === '1');
  let context = null;
  let master = null;
  let volume = Math.max(0, Math.min(1, config.audio.volume));
  let disposed = false;
  let countdownEndsAt = 0;
  let lastCountdown = null;
  const voices = new Set();
  const lastPlayed = new Map();
  const interactionTarget = button?.ownerDocument ?? globalThis.document;

  function syncButton() {
    if (button) {
      button.textContent = active ? '\u{1F50A}' : '\u{1F507}';
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', active ? 'Tắt âm thanh' : 'Bật âm thanh');
      button.title = active && context?.state !== 'running' ? 'Âm thanh đang chờ tương tác' : active ? 'Tắt âm thanh' : 'Bật âm thanh';
      button.dataset.state = active && context?.state !== 'running' ? 'blocked' : active ? 'on' : 'off';
    }
    if (volumeInput) volumeInput.value = String(volume);
  }

  async function unlock() {
    if (disposed || !active) return;
    try {
      const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!context && AudioContextClass) {
        context = new AudioContextClass();
        master = context.createGain();
        master.connect(context.destination);
        master.gain.setValueAtTime(volume, context.currentTime);
      }
      if (context?.state === 'suspended') await context.resume();
    } catch (error) {
      console.warn('[audio] chưa bật được âm thanh:', error?.message ?? error);
    }
    if (!disposed) syncButton();
  }

  function play(type) {
    if (disposed || !active || !context || context.state !== 'running' || volume <= 0) return;
    if (now() - (lastPlayed.get(type) ?? -Infinity) < config.audio.eventMinIntervalMs) return;
    const sound = config.audio.sounds[type];
    if (!sound) return;
    lastPlayed.set(type, now());
    for (const [index, frequency] of sound.notes.entries()) {
      if (voices.size >= config.audio.maxVoices) break;
      try {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + index * config.audio.noteSpacingMs / 1000;
        const voice = { oscillator, gain };
        oscillator.type = sound.waveform;
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(config.audio.noteGain, start);
        gain.gain.exponentialRampToValueAtTime(config.audio.minimumVolume, start + sound.durationMs / 1000);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.onended = () => { voices.delete(voice); oscillator.disconnect(); gain.disconnect(); };
        voices.add(voice);
        oscillator.start(start);
        oscillator.stop(start + sound.durationMs / 1000);
      } catch (error) { console.warn('[audio] bỏ qua hiệu ứng:', error?.message ?? error); }
    }
  }

  function setMuted(muted) {
    if (disposed) return;
    active = !muted;
    if (master && context) master.gain.setValueAtTime(active ? volume : 0, context.currentTime);
    syncButton();
    if (active) void unlock();
  }

  function setVolume(value) {
    if (disposed || !Number.isFinite(Number(value))) return;
    volume = Math.max(0, Math.min(1, Number(value)));
    if (master && context) master.gain.setValueAtTime(active ? volume : 0, context.currentTime);
    syncButton();
  }

  const toggle = () => setMuted(active);
  const changeVolume = () => setVolume(volumeInput.value);
  button?.addEventListener('click', toggle);
  volumeInput?.addEventListener('input', changeVolume);
  interactionTarget?.addEventListener('pointerdown', unlock);
  interactionTarget?.addEventListener('keydown', unlock);
  off.push(bus.on('player:damaged', (event) => { if (event?.amount > 0) play('hit'); }));
  off.push(bus.on('player:killed', () => play('kill')));
  off.push(bus.on('gift:effect', () => play('gift')));
  off.push(bus.on('boss:spawned', () => play('boss')));
  off.push(bus.on('ultimate:fire', () => play('ultimate')));
  off.push(bus.on('round:ended', (event) => { if (event?.winnerId) play('win'); }));
  off.push(bus.on('round:phase', (event) => {
    countdownEndsAt = event?.phase === 'COUNTDOWN' ? event.endsAt : 0;
    lastCountdown = null;
    if (event?.phase === 'BATTLE') play('battle');
  }));

  function update() {
    if (disposed || !countdownEndsAt) return;
    const seconds = Math.ceil((countdownEndsAt - now()) / 1000);
    if (seconds > 0 && seconds !== lastCountdown) { lastCountdown = seconds; play('countdown'); }
  }

  syncButton();
  if (active) void unlock();

  return {
    update, setMuted, setVolume,
    get muted() { return !active; }, get volume() { return volume; }, get status() { return context?.state ?? 'unavailable'; },
    dispose() {
      if (disposed) return;
      disposed = true;
      off.splice(0).forEach((unsubscribe) => unsubscribe());
      button?.removeEventListener('click', toggle);
      volumeInput?.removeEventListener('input', changeVolume);
      interactionTarget?.removeEventListener('pointerdown', unlock);
      interactionTarget?.removeEventListener('keydown', unlock);
      for (const { oscillator, gain } of voices) { oscillator.onended = null; try { oscillator.stop(); } catch {} oscillator.disconnect(); gain.disconnect(); }
      voices.clear(); master?.disconnect();
      if (context) void context.close().catch(() => {});
    },
  };
}
