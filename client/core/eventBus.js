// client/core/eventBus.js — kênh giao tiếp duy nhất giữa các module.

/**
 * @param {{debug?:boolean}|boolean} [cfg] - truyền config (đọc config.debug động) hoặc boolean.
 */
export function createEventBus(cfg = {}) {
  const listeners = new Map(); // evt -> Array<fn>
  const isDebug = () => (typeof cfg === 'boolean' ? cfg : !!cfg?.debug);

  /** Đăng ký listener; trả về hàm unsubscribe. */
  function on(evt, fn) {
    if (typeof fn !== 'function') throw new TypeError(`EventBus.on('${evt}'): listener phải là function`);
    if (!listeners.has(evt)) listeners.set(evt, []);
    listeners.get(evt).push(fn);
    return () => off(evt, fn);
  }

  /** Gỡ listener (hỗ trợ cả listener đăng ký bằng once). */
  function off(evt, fn) {
    const arr = listeners.get(evt);
    if (!arr) return;
    const i = arr.findIndex((f) => f === fn || f.__orig === fn);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) listeners.delete(evt);
  }

  /** Chỉ chạy 1 lần rồi tự gỡ. */
  function once(evt, fn) {
    const wrapper = (payload) => {
      off(evt, wrapper);
      return fn(payload);
    };
    wrapper.__orig = fn;
    return on(evt, wrapper);
  }

  /** Phát sự kiện. Lỗi trong 1 listener không ảnh hưởng listener khác. Trả về số listener đã gọi. */
  function emit(evt, payload) {
    if (isDebug()) console.log(`[bus] ${evt}`, payload);
    const arr = listeners.get(evt);
    if (!arr || !arr.length) return 0;
    const snapshot = arr.slice(); // tránh lỗi khi listener tự off trong lúc emit
    for (const fn of snapshot) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] lỗi listener của '${evt}':`, err);
      }
    }
    return snapshot.length;
  }

  /** Xóa listener của 1 sự kiện (hoặc tất cả) — dùng khi dispose/reset. */
  function clear(evt) {
    if (evt === undefined) listeners.clear();
    else listeners.delete(evt);
  }

  const listenerCount = (evt) => (listeners.get(evt) || []).length;

  return { on, off, once, emit, clear, listenerCount };
}
