// server/tiktokAdapter.js
// Kết nối TikTok LIVE và CHUẨN HÓA sự kiện theo catalog. Không chứa logic game.
// Viết cho tiktok-live-connector v2.x (ESM, class TikTokLiveConnection).
// Vẫn tương thích v1.x (class WebcastPushConnection) nhờ dùng tên sự kiện dạng chuỗi.

import * as TTL from 'tiktok-live-connector';

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30000;

// v2: TikTokLiveConnection | v1: WebcastPushConnection
const Connection =
  TTL.TikTokLiveConnection ??
  TTL.WebcastPushConnection ??
  TTL.default?.WebcastPushConnection;

const str = (v) => (v === undefined || v === null ? '' : String(v));
const firstId = (...values) => values.map(str).find((value) => value.trim() && value !== '0') ?? '';
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const errMsg = (e) => str(e?.message ?? e?.info ?? e) || 'unknown error';

/** Đọc user từ data.user.* (v2) hoặc data.* (v1). Trả về null nếu thiếu id. */
function readUser(data) {
  const u = data?.user ?? {};
  const uniqueId = firstId(u.uniqueId, u.displayId, data?.uniqueId, data?.displayId);
  const userId = firstId(u.userId, u.idStr, u.id, data?.userId, data?.idStr, data?.id, u.secUid, data?.secUid);
  if (!userId) return null;
  return {
    userId,
    uniqueId,
    nickname: firstId(u.nickname, data?.nickname, uniqueId),
    avatarUrl: str(
      u.profilePicture?.urls?.[0] ?? u.profilePictureUrl ?? u.avatarThumb?.urlList?.[0] ?? data?.profilePictureUrl ?? ''
    ),
  };
}

/**
 * @param {{ username:string, onEvent:(type:string,payload:object)=>void,
 *           onStatus:(payload:object)=>void, signApiKey?:string }} opts
 * @returns {{ connect:()=>Promise<void>, disconnect:()=>Promise<void> }}
 */
export function createTikTokAdapter({ username, onEvent, onStatus, onChatDiagnostic, signApiKey, ConnectionClass = Connection }) {
  let current = null; // kết nối hiện tại
  let stopped = true; // true khi người dùng chủ động ngắt
  let connecting = false;
  let attempts = 0; // số lần retry liên tiếp
  let retryTimer = null;

  // --- phát ra ngoài, không để lỗi của callback làm sập adapter ---
  const emit = (type, payload) => {
    try {
      onEvent?.(type, payload);
    } catch (e) {
      console.error(`[tiktok] onEvent(${type}) lỗi:`, errMsg(e));
    }
  };
  const status = (payload) => {
    try {
      onStatus?.(payload);
    } catch (e) {
      console.error('[tiktok] onStatus lỗi:', errMsg(e));
    }
  };

  const diagnoseChat = (data, accepted) => {
    const user = data?.user ?? {};
    const comment = data?.comment ?? data?.text ?? data?.content;
    const commentLength = str(comment).trim().length;
    const hasUserId = Boolean(firstId(user.userId, user.idStr, user.id, data?.userId, data?.idStr, data?.id, user.secUid, data?.secUid));
    try {
      onChatDiagnostic?.({
        accepted,
        reason: accepted ? null : commentLength === 0 ? 'empty_comment' : !hasUserId ? 'missing_user_id' : 'unknown',
        commentField: data?.comment !== undefined ? 'comment' : data?.text !== undefined ? 'text' : data?.content !== undefined ? 'content' : 'none',
        commentLength,
        hasUserId,
        hasUniqueId: Boolean(firstId(user.uniqueId, user.displayId, data?.uniqueId, data?.displayId)),
        topLevelKeys: Object.keys(data ?? {}),
        userKeys: Object.keys(user),
      });
    } catch (e) {
      console.error('[tiktok] chat diagnostic lỗi:', errMsg(e));
    }
  };

  // --- chuẩn hóa từng loại sự kiện (trả về payload hoặc null để bỏ qua) ---
  const mappers = {
    chat(data) {
      const user = readUser(data);
      const text = str(data?.comment ?? data?.text ?? data?.content).trim();
      if (!user || !text) return null;
      return ['live:chat', { ...user, text }];
    },

    gift(data) {
      const user = readUser(data);
      if (!user) return null;
      const giftType = num(data?.giftDetails?.giftType ?? data?.giftType);
      const repeatEnd = Boolean(data?.repeatEnd);
      // Quà streak: chỉ xử lý khi streak kết thúc
      if (giftType === 1 && !repeatEnd) return null;
      const unit = num(
        data?.giftDetails?.diamondCount ?? data?.diamondCount ?? data?.extendedGiftInfo?.diamond_count
      );
      const count = Math.max(1, num(data?.repeatCount) || 1);
      return [
        'live:gift',
        {
          ...user,
          giftId: num(data?.giftId),
          giftName: str(
            data?.giftDetails?.giftName ?? data?.giftName ?? data?.extendedGiftInfo?.name
          ),
          diamonds: unit * count, // tổng = đơn giá * count
          count,
        },
      ];
    },

    like(data) {
      const user = readUser(data);
      if (!user) return null;
      return [
        'live:like',
        {
          userId: user.userId,
          nickname: user.nickname,
          likeCount: num(data?.likeCount),
          totalLikeCount: num(data?.totalLikeCount),
        },
      ];
    },

    member(data) {
      const user = readUser(data);
      return user ? ['live:join', user] : null;
    },

    follow(data) {
      const user = readUser(data);
      if (!user) return null;
      return ['live:follow', { userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname }];
    },

    share(data) {
      const user = readUser(data);
      if (!user) return null;
      return ['live:share', { userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname }];
    },
  };

  /** Gắn handler cho 1 kết nối; bỏ qua sự kiện của kết nối cũ (stale). */
  function bind(conn) {
    const guard = (fn) => (...args) => {
      if (conn !== current) return;
      try {
        fn(...args);
      } catch (e) {
        console.error('[tiktok] lỗi xử lý sự kiện:', errMsg(e));
      }
    };

    for (const [name, map] of Object.entries(mappers)) {
      conn.on(
        name,
        guard((data) => {
          const out = map(data);
          if (name === 'chat') diagnoseChat(data, Boolean(out));
          if (out) emit(out[0], out[1]);
        })
      );
    }

    conn.on('error', guard((err) => console.warn('[tiktok] error:', errMsg(err?.exception ?? err?.info ?? err))));

    conn.on(
      'streamEnd',
      guard(() => status({ connected: false, error: 'stream_ended' }))
    );

    conn.on(
      'disconnected',
      guard(() => {
        if (stopped) return;
        status({ connected: false, error: 'disconnected' });
        scheduleReconnect();
      })
    );
  }

  /** Bỏ hẳn một kết nối cũ, không throw. */
  async function teardown(conn) {
    if (!conn) return;
    try {
      conn.removeAllListeners?.();
      await conn.disconnect?.();
    } catch {
      /* bỏ qua */
    }
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return; // idempotent
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
    attempts += 1;
    console.log(`[tiktok] thử kết nối lại sau ${delay / 1000}s (lần ${attempts})`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attempt();
    }, delay);
  }

  async function attempt() {
    if (stopped || connecting) return;
    connecting = true;
    const old = current;
    current = null;
    await teardown(old);

    const options = { processInitialData: false, enableExtendedGiftInfo: false };
    if (signApiKey) options.signApiKey = signApiKey;

    let conn;
    try {
      if (!ConnectionClass) throw new Error('Không tìm thấy class kết nối trong tiktok-live-connector');
      conn = new ConnectionClass(username, options);
      current = conn;
      bind(conn);
      const state = await conn.connect();
      if (stopped) {
        // bị ngắt trong lúc đang kết nối
        current = null;
        await teardown(conn);
        return;
      }
      attempts = 0;
      status({ connected: true, roomId: str(state?.roomId ?? conn.roomId ?? '') });
    } catch (e) {
      if (conn && conn === current) {
        current = null;
        await teardown(conn);
      }
      if (!stopped) {
        status({ connected: false, error: errMsg(e) });
        scheduleReconnect();
      }
    } finally {
      connecting = false;
    }
  }

  return {
    async connect() {
      stopped = false;
      attempts = 0;
      clearTimeout(retryTimer);
      retryTimer = null;
      await attempt();
    },
    async disconnect() {
      stopped = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      const conn = current;
      current = null;
      await teardown(conn);
      status({ connected: false });
    },
  };
}
