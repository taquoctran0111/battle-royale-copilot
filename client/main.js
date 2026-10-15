import baseConfig from './core/config.js';
import { createEventBus } from './core/eventBus.js';
import { createGameLoop } from './core/gameLoop.js';
import { createState } from './core/gameState.js';
import { createWsClient, resolveBackendUrl } from './net/wsClient.js';
import { createLeaderboardClient } from './net/leaderboardClient.js';
import { createInputRouter } from './input/inputRouter.js';
import { createRoundManager } from './systems/roundManager.js';
import { createMovementSystem } from './systems/movementSystem.js';
import { createCombatSystem } from './systems/combatSystem.js';
import { createZoneSystem } from './systems/zoneSystem.js';
import { createEventSystem } from './systems/eventSystem.js';
import { createAllianceSystem } from './systems/allianceSystem.js';
import { createGiftEffectSystem } from './systems/giftEffectSystem.js';
import { createRenderer } from './render/renderer.js';
import { createHud } from './ui/hud.js';
import { createAudio } from './ui/audio.js';

const params = new URLSearchParams(location.search);
const positiveInt = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= baseConfig.runtime.maxArenaDimension ? Number(value) : fallback;
const config = {
  ...baseConfig,
  debug: params.get('debug') === '1' || baseConfig.debug,
  transparent: params.get('transparent') === '1',
  arena: {
    ...baseConfig.arena,
    w: positiveInt(params.get('w'), baseConfig.arena.w),
    h: positiveInt(params.get('h'), baseConfig.arena.h),
  },
};

const state = createState(config);
const bus = createEventBus(config);
const backendUrl = await resolveBackendUrl({ location, config });
const socketUrl = params.get('ws') || `${backendUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${backendUrl.host}${config.net.wsPath}`;
const wsClient = createWsClient({ bus, config, url: socketUrl });
const inputRouter = createInputRouter({ bus, state, config });
const roundManager = createRoundManager({ bus, state, config });
const movementSystem = createMovementSystem({ bus, state, config });
const combatSystem = createCombatSystem({ bus, state, config });
const zoneSystem = createZoneSystem({ bus, state, config });
const eventSystem = createEventSystem({ bus, state, config });
const allianceSystem = createAllianceSystem({ bus, state, config });
const giftEffectSystem = createGiftEffectSystem({ bus, state, config });
const systems = [['roundManager', roundManager], ['giftEffectSystem', giftEffectSystem], ['allianceSystem', allianceSystem], ['zoneSystem', zoneSystem], ['eventSystem', eventSystem], ['movementSystem', movementSystem], ['combatSystem', combatSystem]];
const renderer = createRenderer({ canvas: document.querySelector('#arena'), bus, state, config });
let leaderboardClient;
const hud = createHud({ root: document.querySelector('#hud'), bus, state, config, serverUrl: backendUrl.href, fetchTop: (query) => leaderboardClient?.fetchTop(query) ?? Promise.resolve([]) });
const audio = createAudio({ bus, button: document.querySelector('#audio-toggle'), musicButton: document.querySelector('#music-toggle'), volumeInput: document.querySelector('#audio-volume'), enabled: params.get('audio') === '1', config });
leaderboardClient = createLeaderboardClient({ bus, state, config, serverUrl: backendUrl.href });
renderer.onFrame(() => { hud.update(); audio.update(); });

if (config.transparent) document.documentElement.classList.add('transparent');
const loop = createGameLoop({ systems, inputRouter, renderer, config });
let disposed = false;
const resetClock = () => loop.resetClock();
function dispose() {
  if (disposed) return;
  disposed = true;
  loop.dispose();
  document.removeEventListener('visibilitychange', resetClock);
  window.removeEventListener('pagehide', dispose);
  leaderboardClient.dispose();
  audio.dispose();
  hud.dispose();
  renderer.dispose();
  [...systems].reverse().forEach(([, system]) => system.dispose());
  inputRouter.dispose();
  wsClient.dispose();
  bus.clear();
}

document.addEventListener('visibilitychange', resetClock);
window.addEventListener('pagehide', dispose, { once: true });
wsClient.connect();
loop.start();
