// A stand-in config-panel Tenant for tests: the login pages, the storefront API served
// from a Form backup (mapped to the public API shape by form-sdk-cli's adapter), and
// the few admin routes the plugin uses. Nothing here talks to a real Tenant.
import http from "node:http";
import { loadBackupFiles, mapBackup } from "./fixture-adapter/backup-adapter.ts";
import { DEFAULT_LANGUAGE, DEFAULT_LOCALIZATION, DEFAULT_OPTIONS, EMPTY_BOM } from "./fixture-adapter/stubs.ts";

export const MOCK_USER = { email: "seller@example.com", password: "correct horse" };

export type MockTenant = {
  origin: string;
  formId: number;
  submits: unknown[];
  drafts: unknown[];
  adminSaves: unknown[];
  logins: number;
  close: () => Promise<void>;
};

export async function startMockTenant(fixtureDir: string, options: { level?: string; forceLogin?: boolean } = {}): Promise<MockTenant> {
  const files = loadBackupFiles(fixtureDir);
  const mapped = mapBackup(files);
  const adminForm = structuredClone(files.form) as Record<string, unknown>;
  const state = { submits: [] as unknown[], drafts: [] as unknown[], adminSaves: [] as unknown[], logins: 0 };
  const AUTH = "auth-session-1";
  const CSRF = "csrf-123";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = req.headers.cookie ?? "";
    const authed = cookie.includes(`config_session=${AUTH}`);
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      const isText = typeof data === "string";
      res.writeHead(status, { "content-type": isText ? "text/html" : "application/json", ...headers });
      res.end(isText ? data : JSON.stringify(data));
    };
    const p = url.pathname;

    // --- login ---
    if (p === "/dashboard/login" && req.method === "GET") {
      return send(200, `<form><input type="hidden" name="_token" value="login-token"><input name="email"><input name="password" type="password"></form>`, {
        "set-cookie": "config_session=anon; path=/; httponly",
      });
    }
    if (p === "/dashboard/login" && req.method === "POST") {
      const form = new URLSearchParams(body);
      if (form.get("_token") !== "login-token") return send(419, { message: "CSRF token mismatch." });
      if (form.get("email") === MOCK_USER.email && form.get("password") === MOCK_USER.password) {
        state.logins++;
        return send(302, "", { location: "/dashboard", "set-cookie": `config_session=${AUTH}; path=/; httponly` });
      }
      return send(302, "", { location: "/dashboard/login" });
    }
    if (p === "/dashboard/dashboard") {
      if (!authed) return send(302, "", { location: "/dashboard/login" });
      return send(200, `<html><head><meta name="csrf-token" content="${CSRF}"></head></html>`);
    }

    // --- admin API ---
    if (p.startsWith("/dashboard/")) {
      if (!authed) return send(401, { message: "Unauthenticated." });
      if (req.method !== "GET" && req.headers["x-csrf-token"] !== CSRF) return send(419, { message: "CSRF token mismatch." });
      const adminFormMatch = /^\/dashboard\/api\/form\/(\d+)$/.exec(p);
      if (adminFormMatch && Number(adminFormMatch[1]) === mapped.formId) {
        if (req.method === "GET") return send(200, adminForm);
        state.adminSaves.push(JSON.parse(body));
        return send(200, { message: "Saved" });
      }
      return send(404, { message: "Not found in mock." });
    }

    // --- storefront API ---
    if (options.forceLogin && !authed && p.startsWith("/api/")) return send(401, { message: "You need to be logged in, in order to do this action." });
    if (p === "/api/auth") return send(200, { authenticated: authed });
    if (p === "/api/user") {
      if (!authed) return send(401, { message: "Unauthenticated." });
      return send(200, {
        user: {
          id: 7, active: 1, name: "Sam Seller", username: "sam", email: MOCK_USER.email, level: options.level ?? "user",
          language_id: 1, discount_group_id: null, email_verified_at: null, created_at: null, updated_at: null, company_id: 1, extra_fields: null,
        },
      });
    }
    const loc = (files.localization ?? DEFAULT_LOCALIZATION) as typeof DEFAULT_LOCALIZATION;
    if (p === "/api/localization") return send(200, loc);
    if (p === "/api/localization/languages" || p === "/api/languages") return send(200, [DEFAULT_LANGUAGE]);
    if (p === "/api/localization/countries") return send(200, { data: [loc.country] });
    if (p === "/api/language") return send(200, DEFAULT_LANGUAGE);
    if (p === "/api/forms") {
      return send(200, {
        current_page: 1, last_page: 1, per_page: 25, total: 1, from: 1, to: 1, links: [], path: "/api/forms",
        first_page_url: "/api/forms?page=1", last_page_url: "/api/forms?page=1", next_page_url: null, prev_page_url: null,
        data: [{ id: mapped.formId, name: mapped.formName, active: 1, description: "Fixture form", order: 0 }],
      });
    }
    if (p === "/api/request-fields") {
      return send(200, {
        data: [{ id: 1, name: "Customer", order: 0, active: 1, created_at: null, updated_at: null, fields: [
          { name: "Company", slug: "company", text: null, type: "text", required: true, mode: "editable" },
        ] }],
      });
    }
    if (["/api/form-categories", "/api/form-super-categories", "/api/form-master-categories"].includes(p)) return send(200, { data: [] });
    if (p.startsWith("/api/options/")) return send(200, DEFAULT_OPTIONS);
    if (p.startsWith("/api/addon-has/")) return send(200, false);
    if (p.startsWith("/api/addon-values/")) return send(200, { data: [] });
    if (p.startsWith("/api/appearance-field-tabs/")) return send(200, { data: [] });
    if (p === "/api/document-templates/applicable") return send(200, { data: [], enabled: false });
    if (p === "/api/realtime-lookup") return send(200, { enabled: false });
    if (p === "/api/form/submit" && req.method === "POST") {
      state.submits.push(JSON.parse(body));
      return send(200, { message: "Submitted", request_id: 5001, pdf_url: null, document_urls: [], documents: [] });
    }
    if (p === "/api/form/draft/save" && req.method === "POST") {
      if (!authed) return send(401, { message: "Unauthenticated." });
      state.drafts.push(JSON.parse(body));
      return send(200, { message: "Saved", form_configuration_id: 77 });
    }
    if (p === "/api/requests") {
      if (!authed) return send(401, { message: "Unauthenticated." });
      return send(200, { current_page: 1, last_page: 1, total: state.submits.length, data: state.submits.map((_, i) => ({ id: 5001 + i, name: "Ada", email: "ada@example.com", status: "open", conf_total: 100, vat_total: 20, created_at: "2026-11-26T10:00:00Z" })) });
    }
    if (/^\/api\/request\/\d+\/full$/.test(p)) {
      if (!authed) return send(401, { message: "Unauthenticated." });
      return send(200, { data: { request: { id: 5001, name: "Ada", email: "ada@example.com", extra_fields: [], conf_total: 100, vat_total: 20 }, configuration: { id: 77, name: "Q", country_id: 1, configuration_3d_data: "{}" }, form_submissions: [] } });
    }
    const formMatch = /^\/api\/form\/(\d+)(\/.*)?$/.exec(p);
    if (formMatch) {
      if (Number(formMatch[1]) !== mapped.formId) return send(404, { message: "No query results for model [Form]." });
      const rest = formMatch[2] ?? "";
      if (rest === "") return send(200, mapped.form);
      if (rest === "/formula-constraints") return send(200, mapped.formulaConstraints);
      if (rest === "/queries") return send(200, mapped.queries);
      if (rest === "/product-properties/usage") return send(200, mapped.productPropertiesUsage);
      if (rest === "/bom") return send(200, { data: mapped.bom ?? EMPTY_BOM });
    }
    send(404, { message: `Mock has no route ${req.method} ${p}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    formId: mapped.formId,
    get submits() { return state.submits; },
    get drafts() { return state.drafts; },
    get adminSaves() { return state.adminSaves; },
    get logins() { return state.logins; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as MockTenant;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: mock-tenant.ts <backup dir>");
  const t = await startMockTenant(dir, { level: process.argv[3] ?? "admin" });
  console.log(`Mock Tenant for form ${t.formId} at ${t.origin} (login ${MOCK_USER.email} / ${MOCK_USER.password})`);
}
