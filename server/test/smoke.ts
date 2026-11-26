// End-to-end test of the built plugin server: launches plugins/mercura-config-panel/server/index.mjs
// over MCP stdio (as Claude Code does) against the mock Tenant, and walks the three
// capabilities: configure & quote, look up, guarded edits.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MOCK_USER, startMockTenant } from "./mock-tenant.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(here, "../../plugins/mercura-config-panel/server/index.mjs");
const fixture = path.join(here, "fixtures/demo-form");

type Env = Record<string, string>;
let passed = 0;

async function connect(env: Env) {
  const client = new Client({ name: "smoke", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverFile], env: { PATH: process.env.PATH ?? "", ...env }, stderr: "pipe" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // text
    }
    return { error: Boolean(r.isError), data, text };
  };
  return { client, call, close: () => client.close() };
}

function check(label: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-plugin-"));
const tenant = await startMockTenant(fixture, { level: "admin" });
const base: Env = { CONFIG_PANEL_HOST: tenant.origin, CONFIG_PANEL_DATA_DIR: dataDir };

try {
  // ---------- 1. a seller with edits off ----------
  console.log("Seller, edits off");
  {
    const s = await connect({ ...base, CONFIG_PANEL_USERNAME: MOCK_USER.email, CONFIG_PANEL_PASSWORD: MOCK_USER.password, CONFIG_PANEL_ALLOW_EDITS: "${user_config.allow_edits}" });
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    check("edit tools are not offered", () => {
      assert.ok(tools.includes("add_configuration") && tools.includes("get_form_outline"));
      assert.ok(!tools.includes("apply_form_change") && !tools.includes("preview_form_edit"));
    });

    const status = await s.call("connection_status");
    check("logs in and reports the user level", () => {
      assert.equal(status.error, false, status.text);
      assert.equal(status.data.user.level, "admin");
      assert.equal(status.data.editsAllowed, false);
    });

    const list = await s.call("list_configurators");
    check("lists configurators", () => assert.equal(list.data.configurators[0].id, tenant.formId));

    const added = await s.call("add_configuration", { formId: tenant.formId, name: "Head office" });
    check("opens a configuration with its rules run", () => {
      assert.equal(added.error, false, added.text);
      assert.equal(added.data.currency, "DKK");
      assert.ok(added.data.missingRequired.some((m: any) => m.label === "Support plan"));
      const plan = added.data.sections.flatMap((s: any) => s.elements).find((e: any) => e.label === "Support plan");
      assert.deepEqual(plan.options.map((o: any) => o.label), ["Essential", "Business", "Premium"]);
    });
    const before = added.data.total.amount;

    const bad = await s.call("set_answers", { answers: [{ element: "Support plan", value: "Platinum" }] });
    check("refuses an option that does not exist, naming the real ones", () => {
      assert.equal(bad.error, true);
      assert.match(bad.text, /Essential/);
    });

    const answered = await s.call("set_answers", {
      answers: [
        { element: "Industry", value: "Manufacturing" },
        { element: 62903, value: "Business" },
        { element: "Support hours", value: 172837 },
        { element: "Microsoft 365 licences", value: "Microsoft 365 Business Standard" },
        { element: "Contract term", value: "36 months" },
        { element: "Compliance requirements", value: ["NIS2", "ISO 27001"] },
        { element: "Number of users", value: 40 },
      ],
    });
    check("answers by label, id and Slug; the price follows", () => {
      assert.equal(answered.error, false, answered.text);
      assert.deepEqual(answered.data.missingRequired, []);
      assert.notEqual(answered.data.total.amount, before);
      const users = answered.data.sections.flatMap((s: any) => s.elements).find((e: any) => e.label === "Number of users");
      assert.equal(users.value, "40");
    });
    console.log(`    total ${answered.data.total.formatted} (was ${added.data.total.formatted})`);

    const tooMany = await s.call("set_answers", { answers: [{ element: "Support plan", value: ["Essential", "Premium"] }] });
    check("a radio takes one option", () => assert.equal(tooMany.error, true));

    const fields = await s.call("get_request_fields");
    check("reads the quote's request fields", () => assert.equal(fields.data.groups[0].fields[0].slug, "company"));

    const premature = await s.call("submit_quote", { confirmed: true });
    check("will not submit without contact details", () => {
      assert.equal(premature.error, true);
      assert.equal(tenant.submits.length, 0);
    });

    await s.call("set_contact_details", { name: "Ada Lovelace", email: "ada@example.com", fields: { company: "Analytical Engines A/S" } });
    const submitted = await s.call("submit_quote", { confirmed: true });
    check("submits the storefront's exact payload", () => {
      assert.equal(submitted.error, false, submitted.text);
      assert.equal(submitted.data.requestId, 5001);
      assert.equal(tenant.submits.length, 1);
      const body: any = tenant.submits[0];
      assert.equal(body.name, "Ada Lovelace");
      assert.equal(body.data[0].id, tenant.formId);
      assert.deepEqual(body.data[0].values.groups["9640"]["62903"], ["172834"]);
      assert.deepEqual(body.requestFields, { 1: { 0: "Analytical Engines A/S" } });
    });

    const quotes = await s.call("list_quotes");
    check("lists quotes", () => assert.equal(quotes.data.quotes[0].id, 5001));
    const outline = await s.call("get_form_outline", { formId: tenant.formId });
    check("admin outline shows prices per country", () => {
      const opt = outline.data.groups[1].elements[0].options[0];
      assert.equal(opt.label, "Essential");
      assert.ok(Object.keys(opt.prices).length >= 1);
    });
    await s.close();
  }

  // ---------- 2. an admin with edits on ----------
  console.log("Admin, edits on");
  {
    const s = await connect({ ...base, CONFIG_PANEL_USERNAME: MOCK_USER.email, CONFIG_PANEL_PASSWORD: MOCK_USER.password, CONFIG_PANEL_ALLOW_EDITS: "true" });
    const logins = tenant.logins;
    const preview = await s.call("preview_form_edit", {
      formId: tenant.formId,
      reason: "Rename the plan as marketing asked",
      edits: [
        { target: "option", id: 172833, label: "Essential+", price: { countryId: 41, amount: 259 } },
        { target: "element", id: 62900, state: "required" },
      ],
    });
    await s.call("get_form_outline", { formId: tenant.formId });
    check("a new session logs in once, then reuses it", () => assert.equal(tenant.logins, logins + 1));
    check("a preview saves nothing and lists each change", () => {
      assert.equal(preview.error, false, preview.text);
      assert.equal(tenant.adminSaves.length, 0);
      assert.equal(preview.data.changes.length, 3, preview.text);
      assert.ok(preview.data.confirmationToken);
    });
    const badEdit = await s.call("preview_form_edit", { formId: tenant.formId, reason: "test a wrong id", edits: [{ target: "option", id: 1, label: "x" }] });
    check("a preview of an unknown id is refused", () => assert.equal(badEdit.error, true));

    const applied = await s.call("apply_form_change", { confirmationToken: preview.data.confirmationToken });
    check("apply saves the whole form, with every other node intact, and backs up first", () => {
      assert.equal(applied.error, false, applied.text);
      assert.equal(tenant.adminSaves.length, 1);
      const saved: any = tenant.adminSaves[0];
      assert.equal(saved.id, tenant.formId);
      assert.equal(saved.data.groups.length, 6);
      const opt = saved.data.groups[1].elements[0].options[0];
      assert.equal(opt.label, "Essential+");
      assert.equal(opt.prices.find((p: any) => p.country_id === 41).price, 259);
      assert.equal(saved.data.groups[1].elements[0].options.length, 3);
      assert.ok(applied.data.backupId);
    });
    // The mock does not persist saves, so read-back reports the mismatch: that is the check working.
    check("read-back reports fields that did not stick", () => assert.equal(applied.data.verified, false));

    const reuse = await s.call("apply_form_change", { confirmationToken: preview.data.confirmationToken });
    check("a token works once", () => assert.equal(reuse.error, true));

    const backups = await s.call("list_form_backups", { formId: tenant.formId });
    check("lists the backup", () => assert.equal(backups.data.backups.length, 1));
    await s.close();
  }

  // ---------- 3. logging in ----------
  console.log("Login");
  {
    // As Claude Code passes it when the settings were never filled in.
    const s = await connect({ CONFIG_PANEL_HOST: "${user_config.host}", CONFIG_PANEL_USERNAME: "${user_config.username}", CONFIG_PANEL_PASSWORD: "", CONFIG_PANEL_DATA_DIR: dataDir });
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    const r = await s.call("connection_status");
    check("without a login only the login tool is offered, and it says how to log in", () => {
      assert.deepEqual(tools, ["connection_status"]);
      assert.equal(r.error, true);
      assert.match(r.text, /not logged in/);
      assert.match(r.text, /\/plugin.*Configure/);
      assert.match(r.text, /Do not type the password into the chat/);
    });
    await s.close();
  }
  {
    const wrong = "wrong-secret-123";
    const s = await connect({ ...base, CONFIG_PANEL_USERNAME: MOCK_USER.email, CONFIG_PANEL_PASSWORD: wrong });
    const r = await s.call("connection_status");
    check("a wrong password is refused with the way to fix it, without echoing the password", () => {
      assert.equal(r.error, true);
      assert.match(r.text, /refused the login/);
      assert.match(r.text, /Configure/);
      assert.ok(!r.text.includes(wrong));
    });
    await s.close();
  }
  check("no password or session cookie was written to disk", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dataDir);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      assert.ok(!text.includes(MOCK_USER.password), `password in ${f}`);
      assert.ok(!text.includes("auth-session-1"), `session cookie in ${f}`);
    }
    assert.ok(files.every((f) => f.includes(`${path.sep}backups${path.sep}`)), `unexpected files: ${files.join(", ")}`);
  });
  console.log(`\n${passed} checks passed.`);
} finally {
  await tenant.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
