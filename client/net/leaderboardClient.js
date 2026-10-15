import baseConfig from '../core/config.js';

export function createLeaderboardClient({ bus, state, config = baseConfig, serverUrl, fetchImpl = globalThis.fetch }) {
  const off = [];
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const configuredServer = params.get('server');
  const servedByBackend = globalThis.location?.pathname === '/' || globalThis.location?.pathname === '/index.html';
  const origin = new URL(serverUrl || configuredServer || (servedByBackend ? globalThis.location.origin : `${globalThis.location?.protocol ?? 'http:'}//${globalThis.location?.hostname ?? '127.0.0.1'}:3000`), globalThis.location?.href ?? 'http://127.0.0.1/').origin;
  const sessionId = globalThis.crypto?.randomUUID?.() ?? `session_${Date.now().toString(36)}`;
  let disposed = false;
  const requests = new Set();

  async function request(url, options = {}, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    requests.add(controller);
    const timeout = setTimeout(abort, config.leaderboard.requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      requests.delete(controller);
    }
  }

  off.push(bus.on('round:ended', async (result) => {
    if (disposed || !Array.isArray(result?.ranking)) return;
    const ranking = result.ranking.map((row) => {
      const player = state?.players.get(String(row.playerId));
      return { ...row, avatar: player?.avatar ?? row.avatar ?? '', giftValue: player?.giftValue ?? row.giftValue ?? 0 };
    });
    try {
      await request(`${origin}/api/leaderboard`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...result, ranking, sessionId }),
      });
    } catch (error) {
      if (!disposed) console.warn('[leaderboard] không lưu được kết quả:', error?.message ?? error);
    }
  }));

  async function fetchTop({ period = config.leaderboard.defaultPeriod, metric = config.leaderboard.defaultMetric, limit = config.leaderboard.defaultLimit, signal } = {}) {
    if (disposed) return [];
    try {
      const query = new URLSearchParams({ period, metric, limit: String(limit) });
      const values = await request(`${origin}/api/leaderboard?${query}`, {}, signal);
      if (!Array.isArray(values)) throw new Error('Invalid leaderboard response');
      return disposed ? [] : values;
    } catch (error) {
      if (!disposed && !signal?.aborted) console.warn('[leaderboard] không tải được bảng:', error?.message ?? error);
      return [];
    }
  }

  return { fetchTop, update() {}, dispose() { disposed = true; off.splice(0).forEach((unsubscribe) => unsubscribe()); for (const controller of requests) controller.abort(); requests.clear(); } };
}
