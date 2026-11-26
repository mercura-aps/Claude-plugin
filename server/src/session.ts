// Logged-in session to one config-panel Tenant: the session cookie plus the CSRF token.
// config-panel has no API tokens for its admin half, so the plugin logs in the way the
// panel's own login page does (GET /dashboard/login for the _token, POST it with the
// credentials, read the csrf-token meta of /dashboard/dashboard). Adapted from
// mercura-cowork packages/mercura-scripts-client/transport/cpq-auth.ts.
//
// Secrets: the password arrives in the process environment from Claude Code's secure
// storage (a `sensitive` plugin option) and is never written, logged or returned. The
// session cookie is kept in memory only; a new Claude Code session logs in again.
import { HOW_TO_LOG_IN, type PluginConfig } from "./config.ts";

export type CookieMap = Record<string, string>;

export type Session = {
  origin: string;
  csrf: string;
  cookies: CookieMap;
  loggedInAt: string;
};

const USER_AGENT = "config-panel-claude-plugin/0.1";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class LoginError extends Error {}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? single.split(/,(?=\s*[^;,=]+=[^;,]+)/g).map((s) => s.trim()) : [];
}

function applySetCookies(cookies: CookieMap, headers: Headers): void {
  for (const item of getSetCookies(headers)) {
    const first = item.split(";", 1)[0];
    const idx = first.indexOf("=");
    if (idx > 0) cookies[first.slice(0, idx)] = first.slice(idx + 1);
  }
}

export function cookieHeader(cookies: CookieMap): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

const scrapeLoginCsrf = (html: string) =>
  html.match(/name=["']_token["'][^>]*value=["']([^"']+)["']/i)?.[1] ?? null;
const scrapeMetaCsrf = (html: string) =>
  html.match(/name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? null;
const detectLoginField = (html: string) =>
  /name=["']username["']/i.test(html) ? "username" : /name=["']email["']/i.test(html) ? "email" : "username";
const isLoginRedirect = (r: Response) =>
  r.status >= 300 && r.status < 400 && /\/login(?:\?|$)/.test(r.headers.get("location") ?? "");

function parseMaybeJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type RequestOptions = {
  json?: unknown;
  form?: Record<string, string | number | boolean | null | undefined>;
  multipart?: FormData;
  headers?: Record<string, string>;
};

export class SessionManager {
  #session: Session | null = null;
  #loginInFlight: Promise<Session> | null = null;
  readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  get loggedIn(): boolean {
    return this.#session !== null;
  }

  get loggedInAt(): string | undefined {
    return this.#session?.loggedInAt;
  }

  /** The current session, logging in when there is none (or when forced). */
  async ensure(options: { force?: boolean } = {}): Promise<Session> {
    if (!options.force && this.#session) return this.#session;
    if (options.force) this.#session = null;
    this.#loginInFlight ??= this.#login().finally(() => {
      this.#loginInFlight = null;
    });
    this.#session = await this.#loginInFlight;
    return this.#session;
  }

  logout(): void {
    this.#session = null;
  }

  /** Cookie header for the headless storefront SDK. */
  async cookieHeader(): Promise<string> {
    return cookieHeader((await this.ensure()).cookies);
  }

  /** Absorb cookies set on a response made with this session (session rotation). */
  absorb(headers: Headers): void {
    if (this.#session) applySetCookies(this.#session.cookies, headers);
  }

  async request(method: string, pathname: string, options: RequestOptions = {}) {
    let session = await this.ensure();
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": USER_AGENT,
        Cookie: cookieHeader(session.cookies),
        "X-CSRF-TOKEN": session.csrf,
        ...options.headers,
      };
      let body: BodyInit | undefined;
      if (options.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.json);
      } else if (options.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(options.form)) if (v != null) form.set(k, String(v));
        body = form;
      } else if (options.multipart) {
        body = options.multipart;
      }
      const url = new URL(pathname, this.config.origin);
      if (url.origin !== this.config.origin) throw new Error("Refusing a request outside the configured config-panel.");
      const response = await fetch(url, { method, headers, body, redirect: "manual" });
      applySetCookies(session.cookies, response.headers);
      const text = await response.text();
      const expired = response.status === 419 || response.status === 401 || isLoginRedirect(response);
      if (expired && attempt === 0) {
        session = await this.ensure({ force: true });
        continue;
      }
      return { status: response.status, headers: response.headers, data: parseMaybeJson(text) };
    }
    throw new Error("Request failed after logging in again.");
  }

  async json<T = unknown>(method: string, pathname: string, options: RequestOptions = {}): Promise<T> {
    const r = await this.request(method, pathname, options);
    if (r.status < 200 || r.status >= 300) {
      throw new ApiError(describeFailure(method, pathname, r.status, r.data), r.status, r.data);
    }
    return r.data as T;
  }

  // ---- internals ----

  async #probe(s: Session): Promise<Session | null> {
    const cookies = { ...s.cookies };
    const r = await fetch(new URL("/dashboard/dashboard", s.origin), {
      headers: { Cookie: cookieHeader(cookies), "User-Agent": USER_AGENT },
      redirect: "manual",
    });
    if (!r.ok || isLoginRedirect(r)) return null;
    applySetCookies(cookies, r.headers);
    const csrf = scrapeMetaCsrf(await r.text());
    return csrf ? { ...s, cookies, csrf } : null;
  }

  async #login(): Promise<Session> {
    const { origin, username, password } = this.config;
    const cookies: CookieMap = {};
    const loginUrl = new URL("/dashboard/login", origin);
    let page: Response;
    try {
      page = await fetch(loginUrl, { headers: { "User-Agent": USER_AGENT }, redirect: "manual" });
    } catch {
      throw new LoginError(`Could not reach config-panel at ${origin}. Check the address and your internet connection. ${HOW_TO_LOG_IN}`);
    }
    applySetCookies(cookies, page.headers);
    const html = await page.text();
    const token = scrapeLoginCsrf(html);
    if (!token || !/name=["']password["']/i.test(html)) {
      throw new LoginError(
        `${origin} shows no config-panel login form. Check the address; if your company logs in with single sign-on only, this plugin cannot log in yet. ${HOW_TO_LOG_IN}`,
      );
    }
    const form = new URLSearchParams();
    form.set("_token", token);
    form.set(detectLoginField(html), username!);
    form.set("password", password!);
    const post = await fetch(loginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-TOKEN": token,
        Cookie: cookieHeader(cookies),
        "User-Agent": USER_AGENT,
      },
      body: form,
      redirect: "manual",
    });
    applySetCookies(cookies, post.headers);
    if (post.status === 429) throw new LoginError("config-panel refused the login: too many attempts. Wait a minute, then try again.");
    if (![200, 204, 302, 303].includes(post.status) || isLoginRedirect(post)) {
      throw new LoginError(`config-panel refused the login for "${username}": the username or password is wrong, or the user is inactive. ${HOW_TO_LOG_IN}`);
    }
    const probed = await this.#probe({ origin, csrf: token, cookies, loggedInAt: new Date().toISOString() });
    if (!probed) throw new LoginError(`Logged in as "${username}", but config-panel did not open the dashboard for this user.`);
    return probed;
  }
}

export function describeFailure(method: string, pathname: string, status: number, data: unknown): string {
  const detail =
    data && typeof data === "object"
      ? JSON.stringify((data as Record<string, unknown>).errors ?? (data as Record<string, unknown>).message ?? data).slice(0, 600)
      : String(data ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
  const hint: Record<number, string> = {
    401: "Not logged in, or the session ended.",
    403: "This user's level does not allow it.",
    404: "Not found (or not on this config-panel).",
    419: "The CSRF token expired.",
    422: "config-panel refused the data.",
    500: "config-panel failed on the server.",
  };
  return `${method} ${pathname} → HTTP ${status}. ${hint[status] ?? ""} ${detail}`.trim();
}
