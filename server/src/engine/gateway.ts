// Routes the SDK's relative fetch("/api/...") calls to the configured Tenant with the
// user's session cookie. Adapted from mercura-aps/form-sdk-cli (src/fetch-gateway.ts).
import type { SessionManager } from "../session.ts";

const EMPTY_BOM = {
  id: 0,
  hide_on_checkout: false,
  hide_on_pdf: false,
  hide_on_excel: false,
  hide_on_email: false,
  tables: [],
  summary: null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type GatewayLog = {
  /** The last answer to a quote submit or draft save, kept so tools can report ids. */
  lastWrite?: { path: string; status: number; body: unknown };
};

let installed = false;
export const gatewayLog: GatewayLog = {};

export function installGateway(sessions: SessionManager): void {
  if (installed) return;
  installed = true;
  const origin = sessions.config.origin;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const OriginalRequest = globalThis.Request;

  // The SDK builds a Request from a relative URL in a few places.
  class RelativeRequest extends OriginalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === "string" && !/^https?:/i.test(input)) input = new URL(input, origin).href;
      super(input, init);
    }
  }
  globalThis.Request = RelativeRequest as typeof Request;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const url = new URL(raw, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return originalFetch(input, init);

    const send = async (cookie: string | undefined) => {
      const headers = new Headers(init?.headers);
      if (input instanceof Request) input.headers.forEach((v, k) => headers.has(k) || headers.set(k, v));
      headers.set("Accept", headers.get("Accept") ?? "application/json");
      headers.set("X-Requested-With", "XMLHttpRequest");
      if (cookie) headers.set("Cookie", cookie);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const body = init?.body ?? (input instanceof Request && method !== "GET" ? await input.clone().text() : undefined);
      return originalFetch(url, { method, headers, body, redirect: "manual" });
    };

    let response = await send(await sessions.cookieHeader());
    if (response.status === 401) {
      await sessions.ensure({ force: true });
      response = await send(await sessions.cookieHeader());
    }
    sessions.absorb(response.headers);

    // A Tenant without a BoM, or without the realtime-lookup add-on, answers 404;
    // the storefront treats both as "none".
    if (response.status === 404 && /^\/api\/form\/\d+\/bom$/.test(url.pathname)) return json(200, { data: EMPTY_BOM });
    if (response.status === 404 && url.pathname === "/api/realtime-lookup" && !url.search) return json(200, { enabled: false });

    if (/^\/api\/form\/(submit|draft\/(save|update|submit))/.test(url.pathname)) {
      const text = await response.clone().text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep text
      }
      gatewayLog.lastWrite = { path: url.pathname, status: response.status, body };
    }
    return response;
  }) as typeof fetch;
}
