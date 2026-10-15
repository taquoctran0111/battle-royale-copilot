import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../client/core/config.js';
import { createEventBus } from '../client/core/eventBus.js';
import { createAudio } from '../client/ui/audio.js';

test('music: loops by phase, respects autoplay/mute/volume/visibility and releases all nodes/listeners', async () => {
  const previous = globalThis.AudioContext;
  const oscillators = [];
  const gains = [];
  let context;
  const target = () => ({
    hidden: false, dataset: {}, listeners: new Map(), attributes: new Map(),
    addEventListener(key, handler) { this.listeners.set(key, handler); },
    removeEventListener(key) { this.listeners.delete(key); },
    setAttribute(key, value) { this.attributes.set(key, value); },
  });
  const doc = target(), musicButton = target(), button = target(), slider = target();
  button.ownerDocument = doc;
  const parameter = () => ({ value: 0, setValueAtTime(value) { this.value = value; }, exponentialRampToValueAtTime() {} });
  class Context {
    constructor() { context = this; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    createGain() {
      const node = { gain: parameter(), connect() {}, disconnect() { this.disconnected = true; } };
      gains.push(node); return node;
    }
    createOscillator() {
      const node = {
        frequency: parameter(), connect() {}, disconnect() { this.disconnected = true; },
        start(at) { this.startedAt = at; },
        stop(at) { this.endsAt = at; if (at === undefined) this.onended?.(); },
      };
      oscillators.push(node); return node;
    }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  globalThis.AudioContext = Context;
  const cfg = structuredClone(config), bus = createEventBus(cfg);
  let audio;
  try {
    audio = createAudio({ bus, button, musicButton, volumeInput: slider, config: cfg, enabled: false });
    audio.update();
    assert.equal(oscillators.length, 0);
    assert.equal(musicButton.attributes.get('aria-pressed'), 'false');
    musicButton.listeners.get('click')();
    await Promise.resolve();
    audio.update();
    assert.equal(audio.musicVoiceCount, 2);
    assert.equal(musicButton.attributes.get('aria-pressed'), 'true');
    const stepSec = 60 / cfg.audio.music.bpm.LOBBY / 2;
    assert.ok(Math.abs(oscillators[0].endsAt - oscillators[0].startedAt - stepSec * .8) < 1e-6);
    for (let i = 0; i < 100; i++) {
      context.currentTime += .05;
      for (const node of oscillators) if (node.onended && node.endsAt <= context.currentTime) {
        const ended = node.onended; node.onended = null; ended();
      }
      audio.update();
      assert.ok(audio.musicVoiceCount <= cfg.audio.music.maxVoices);
    }
    assert.ok(oscillators.length > cfg.audio.music.melody.length);
    bus.emit('round:phase', { phase: 'FINAL' });
    audio.update();
    const finalNote = oscillators.at(-2);
    assert.ok(Math.abs(finalNote.endsAt - finalNote.startedAt - 60 / cfg.audio.music.bpm.FINAL / 2 * .8) < 1e-6);
    bus.emit('round:phase', { phase: 'RESULT' });
    bus.emit('round:ended', { winnerId: 'champion' });
    const beforeVictory = oscillators.length;
    audio.update();
    assert.ok(Math.abs(oscillators[beforeVictory].frequency.value - 440 * 2 ** ((cfg.audio.music.victoryMelody[0] - 69) / 12)) < 1e-6);
    assert.notEqual(oscillators[beforeVictory].frequency.value, oscillators[0].frequency.value);
    bus.emit('round:ended', { winnerId: null });
    const beforeDraw = oscillators.length;
    audio.update();
    assert.equal(oscillators.length - beforeDraw, 2, 'draw does not replay victory fanfare');
    assert.equal(oscillators[beforeDraw].frequency.value, oscillators[0].frequency.value);
    bus.emit('round:phase', { phase: 'LOBBY' });
    audio.setMusicEnabled(false);
    assert.equal(audio.musicVoiceCount, 0);
    const beforeEffect = oscillators.length;
    bus.emit('gift:effect', {});
    assert.ok(oscillators.length > beforeEffect);
    musicButton.listeners.get('click')();
    await Promise.resolve();
    audio.update();
    assert.ok(audio.musicVoiceCount > 0);
    doc.hidden = true; doc.listeners.get('visibilitychange')();
    assert.equal(audio.musicVoiceCount, 0);
    const hiddenCount = oscillators.length; audio.update();
    assert.equal(oscillators.length, hiddenCount);
    doc.hidden = false;
    context.currentTime += 1000;
    audio.update();
    assert.ok(oscillators.length - hiddenCount <= 2, 'no backlog after background tab');
    audio.setVolume(0); assert.equal(audio.musicVoiceCount, 0);
    audio.setVolume(.5); assert.equal(gains[0].gain.value, .5);
    audio.update(); assert.ok(audio.musicVoiceCount > 0);
    audio.setMuted(true); assert.equal(audio.musicVoiceCount, 0);
    const mutedCount = oscillators.length; audio.update();
    assert.equal(oscillators.length, mutedCount);
    audio.dispose();
    assert.equal(context.state, 'closed');
    assert.equal(doc.listeners.size, 0);
    assert.equal(button.listeners.size, 0);
    assert.equal(musicButton.listeners.size, 0);
    assert.equal(slider.listeners.size, 0);
    assert.ok(oscillators.every((node) => node.disconnected));
    assert.ok(gains.every((node) => node.disconnected));
    assert.equal(bus.listenerCount('round:phase'), 0);
  } finally {
    audio?.dispose();
    if (previous === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = previous;
  }
});
