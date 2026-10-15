export function createAudio({ bus, button, musicButton, volumeInput, enabled, config, now = () => Date.now() }) {
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
  const musicVoices = new Set();
  const music = config.audio.music;
  let musicEnabled = music.enabled;
  let phase = 'LOBBY';
  let celebrating = false;
  let musicStep = 0;
  let nextMusicAt = null;
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
    if (musicButton) {
      const musicOn = active && musicEnabled;
      musicButton.setAttribute('aria-pressed', String(musicOn));
      musicButton.setAttribute('aria-label', musicOn ? 'Tắt nhạc nền' : 'Bật nhạc nền');
      musicButton.title = musicOn ? 'Tắt nhạc nền' : 'Bật nhạc nền';
    }
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
      if (!AudioContextClass) throw new Error('Trình duyệt không hỗ trợ Web Audio');
      if (context?.state === 'suspended') await context.resume();
    } catch (error) {
      console.warn('[audio] chưa bật được âm thanh:', error?.message ?? error);
    }
    if (!disposed) syncButton();
  }

  function tone(frequency, start, duration, waveform, level, background = false) {
    if (voices.size >= config.audio.maxVoices) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const voice = { oscillator, gain };
    const release = () => {
      voices.delete(voice); musicVoices.delete(voice);
      oscillator.disconnect(); gain.disconnect();
    };
    try {
      oscillator.type = waveform;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(background ? config.audio.minimumVolume : level, start);
      if (background) gain.gain.exponentialRampToValueAtTime(level, start + .015);
      gain.gain.exponentialRampToValueAtTime(config.audio.minimumVolume, start + duration);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.onended = release;
      voices.add(voice);
      if (background) musicVoices.add(voice);
      oscillator.start(start);
      oscillator.stop(start + duration);
    } catch (error) {
      oscillator.onended = null;
      release();
      throw error;
    }
  }

  function stopMusic() {
    nextMusicAt = null;
    for (const voice of musicVoices) {
      voice.oscillator.onended = null;
      try { voice.oscillator.stop(); }
      catch (error) { console.warn('[audio] không dừng được nốt nhạc:', error?.message ?? error); }
      voice.oscillator.disconnect(); voice.gain.disconnect();
      voices.delete(voice);
    }
    musicVoices.clear();
  }

  function updateMusic() {
    if (!active || !musicEnabled || !context || context.state !== 'running' || volume <= 0 || interactionTarget?.hidden) {
      stopMusic();
      return;
    }
    const stepSec = 60 / music.bpm[phase] / 2;
    if (nextMusicAt === null || nextMusicAt < context.currentTime) nextMusicAt = context.currentTime;
    while (nextMusicAt < context.currentTime + music.lookAheadSec) {
      try {
        const melody = celebrating ? music.victoryMelody : music.melody;
        const bassLine = celebrating ? music.victoryBass : music.bass;
        const note = melody[musicStep % melody.length];
        if (musicVoices.size < music.maxVoices) tone(440 * 2 ** ((note - 69) / 12), nextMusicAt, stepSec * .8, 'triangle', music.gain, true);
        if (musicStep % 4 === 0 && musicVoices.size < music.maxVoices) {
          const bass = bassLine[Math.floor(musicStep / 4) % bassLine.length];
          tone(440 * 2 ** ((bass - 69) / 12), nextMusicAt, stepSec * 2, 'sine', music.gain * .75, true);
        }
      } catch (error) { console.warn('[audio] không phát được nhạc nền:', error?.message ?? error); }
      musicStep++;
      nextMusicAt += stepSec;
    }
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
        const start = context.currentTime + index * config.audio.noteSpacingMs / 1000;
        tone(frequency, start, sound.durationMs / 1000, sound.waveform, config.audio.noteGain);
      } catch (error) { console.warn('[audio] bỏ qua hiệu ứng:', error?.message ?? error); }
    }
  }

  function setMuted(muted) {
    if (disposed) return;
    active = !muted;
    if (!active) stopMusic();
    if (master && context) master.gain.setValueAtTime(active ? volume : 0, context.currentTime);
    syncButton();
    if (active) void unlock();
  }

  function setVolume(value) {
    if (disposed || !Number.isFinite(Number(value))) return;
    volume = Math.max(0, Math.min(1, Number(value)));
    if (volume === 0) stopMusic();
    if (master && context) master.gain.setValueAtTime(active ? volume : 0, context.currentTime);
    syncButton();
  }

  function setMusicEnabled(value) {
    if (disposed) return;
    musicEnabled = Boolean(value);
    if (!musicEnabled) stopMusic();
    syncButton();
  }

  const toggle = () => setMuted(active);
  const toggleMusic = () => {
    const enable = !active || !musicEnabled;
    setMusicEnabled(enable);
    if (enable) setMuted(false);
  };
  const visibilityChanged = () => { if (interactionTarget?.hidden) stopMusic(); };
  const changeVolume = () => setVolume(volumeInput.value);
  button?.addEventListener('click', toggle);
  musicButton?.addEventListener('click', toggleMusic);
  volumeInput?.addEventListener('input', changeVolume);
  interactionTarget?.addEventListener('pointerdown', unlock);
  interactionTarget?.addEventListener('keydown', unlock);
  interactionTarget?.addEventListener('visibilitychange', visibilityChanged);
  off.push(bus.on('player:damaged', (event) => { if (event?.amount > 0) play('hit'); }));
  off.push(bus.on('player:killed', () => play('kill')));
  off.push(bus.on('gift:effect', () => play('gift')));
  off.push(bus.on('boss:spawned', () => play('boss')));
  off.push(bus.on('ultimate:fire', () => play('ultimate')));
  off.push(bus.on('skill:cast', () => play('skill')));
  off.push(bus.on('round:ended', (event) => {
    celebrating = Boolean(event?.winnerId);
    musicStep = 0; stopMusic();
    if (celebrating) play('win');
  }));
  off.push(bus.on('round:phase', (event) => {
    if (event?.phase && Object.hasOwn(music.bpm, event.phase)) {
      phase = event.phase; musicStep = 0; stopMusic();
      if (phase !== 'RESULT') celebrating = false;
    }
    countdownEndsAt = event?.phase === 'COUNTDOWN' ? event.endsAt : 0;
    lastCountdown = null;
    if (event?.phase === 'BATTLE') play('battle');
  }));

  function update() {
    if (disposed) return;
    updateMusic();
    if (!countdownEndsAt) return;
    const seconds = Math.ceil((countdownEndsAt - now()) / 1000);
    if (seconds > 0 && seconds !== lastCountdown) { lastCountdown = seconds; play('countdown'); }
  }

  syncButton();
  if (active) void unlock();

  return {
    update, setMuted, setVolume, setMusicEnabled,
    get musicEnabled() { return musicEnabled; }, get musicVoiceCount() { return musicVoices.size; },
    get muted() { return !active; }, get volume() { return volume; }, get status() { return context?.state ?? 'unavailable'; },
    dispose() {
      if (disposed) return;
      disposed = true;
      off.splice(0).forEach((unsubscribe) => unsubscribe());
      button?.removeEventListener('click', toggle);
      musicButton?.removeEventListener('click', toggleMusic);
      volumeInput?.removeEventListener('input', changeVolume);
      interactionTarget?.removeEventListener('pointerdown', unlock);
      interactionTarget?.removeEventListener('keydown', unlock);
      interactionTarget?.removeEventListener('visibilitychange', visibilityChanged);
      stopMusic();
      for (const { oscillator, gain } of voices) { oscillator.onended = null; try { oscillator.stop(); } catch {} oscillator.disconnect(); gain.disconnect(); }
      voices.clear(); master?.disconnect();
      if (context) void context.close().catch(() => {});
    },
  };
}
