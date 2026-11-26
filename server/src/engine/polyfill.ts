// The browser surface the frontend-form-sdk and TanStack Query touch, and nothing
// more: window (keeps TanStack in client mode), document.location and visibility,
// localStorage/sessionStorage, IndexedDB, requestAnimationFrame. Adapted from
// mercura-aps/form-sdk-cli (src/polyfill.ts) for Node instead of Bun.
import "fake-indexeddb/auto";

class MemoryStorage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    return this.#items.has(key) ? this.#items.get(key)! : null;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
  setItem(key: string, value: string) {
    this.#items.set(key, String(value));
  }
}

let installed = false;

export function installPolyfill(origin: string): void {
  if (installed) return;
  installed = true;
  const noop = () => undefined;
  const originUrl = new URL(`${origin}/`);
  // The SDK redirects to /dashboard on a 401; headless, that is swallowed and the
  // tool reports the 401 itself.
  const location = {
    href: originUrl.href,
    origin: originUrl.origin,
    protocol: originUrl.protocol,
    host: originUrl.host,
    hostname: originUrl.hostname,
    port: originUrl.port,
    pathname: originUrl.pathname,
    search: "",
    hash: "",
    assign: noop,
    replace: noop,
    reload: noop,
    toString: () => originUrl.href,
  };
  const g = globalThis as Record<string, unknown>;
  Object.defineProperty(globalThis, "location", { configurable: true, get: () => location, set: noop });
  g.window = globalThis;
  g.document = {
    location,
    visibilityState: "visible",
    hidden: false,
    addEventListener: noop,
    removeEventListener: noop,
  };
  g.localStorage = new MemoryStorage();
  g.sessionStorage = new MemoryStorage();
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 0);
  g.cancelAnimationFrame = (h: ReturnType<typeof setTimeout>) => clearTimeout(h);
  // The SDK persists through a Web Worker when one exists; without one it writes IndexedDB directly.
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: undefined });
  // addEventListener on window (TanStack focus/online managers).
  if (typeof g.addEventListener !== "function") g.addEventListener = noop;
  if (typeof g.removeEventListener !== "function") g.removeEventListener = noop;
}
