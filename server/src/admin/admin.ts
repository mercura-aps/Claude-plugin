// Admin reads and guarded edits of a Form's structure.
//
// config-panel saves a Form whole (POST /dashboard/api/form/{id}): a node left out is
// deleted and a field left out is reset. So every edit here is
//   1. preview: read the live Form, apply the edits to a copy built by Mercura's own
//      GET→POST converter (form-patch.ts), show a field-by-field difference, hand back a token;
//   2. apply (with the token, after the user said yes): read the Form again, refuse if it
//      changed since the preview, back it up to a local file, save, read it back and check
//      every edited field.
// v0.1 only changes existing nodes in place; it never adds or removes groups, elements or options.
/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "../session.ts";
import { toPostableForm, type PostableForm } from "./form-patch.ts";

export type NodeEdit = {
  target: "group" | "element" | "option";
  id: number;
  label?: string;
  /** Help text under the label (sub_text); for a group, its description. */
  helpText?: string | null;
  active?: boolean;
  /** Elements only. "disabled" is not offered: it drops the element from the price at submit. */
  state?: "required" | "open";
  order?: number;
  placeholder?: string | null;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  /** Element default (for select/radio: an option id). */
  defaultValue?: string | number | null;
  /** Checkbox options only. */
  isDefault?: boolean;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  /** Option sales price in one country, in major units including VAT. */
  price?: { countryId: number; amount: number };
  /** Translation keys as config-panel stores them, e.g. { "da_label": "Bredde" }. */
  translation?: Record<string, string>;
};

type Pending = {
  token: string;
  kind: "edit" | "restore" | "rule-active";
  formId: number;
  fingerprint: string;
  summary: string[];
  run: () => Promise<unknown>;
  createdAt: number;
};

const PENDING_TTL_MS = 30 * 60 * 1000;
const ADMIN_LEVELS = new Set(["admin", "super_admin", "dev"]);

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

const show = (v: unknown) => (v === null || v === undefined ? "∅" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));

export class AdminService {
  readonly #pending = new Map<string, Pending>();
  readonly sessions: SessionManager;

  constructor(sessions: SessionManager) {
    this.sessions = sessions;
  }

  // ---- who may do what ----

  async currentUser(): Promise<{ name: string; email: string; level: string }> {
    const r = await this.sessions.json<any>("GET", "/api/user");
    const u = r?.user ?? r;
    return { name: u?.name, email: u?.email, level: u?.level };
  }

  async requireAdmin(): Promise<void> {
    const u = await this.currentUser();
    if (!ADMIN_LEVELS.has(u.level)) {
      throw new Error(`Your config-panel user (${u.email}) has level "${u.level}". Editing configurators needs level admin.`);
    }
  }

  requireEditsEnabled(): void {
    if (!this.sessions.config.allowEdits) {
      throw new Error(
        'Edits are switched off for this plugin. To allow them, run /plugin, open the config-panel plugin, choose Configure and set "Allow edits" to true.',
      );
    }
  }

  // ---- reads ----

  async adminForm(formId: number): Promise<any> {
    await this.requireAdmin();
    return this.sessions.json<any>("GET", `/dashboard/api/form/${formId}`);
  }

  async countries(): Promise<Array<{ id: number; slug: string; name: string; currency?: string }>> {
    try {
      const r = await this.sessions.json<any>("GET", "/api/localization/countries");
      const list = Array.isArray(r) ? r : r?.data ?? [];
      return list.map((c: any) => ({ id: c.id, slug: c.slug, name: c.name, currency: c.currency?.code }));
    } catch {
      return [];
    }
  }

  /** A compact tree of the Form for reading and for choosing ids. */
  async outline(formId: number) {
    const admin = await this.adminForm(formId);
    const countries = await this.countries();
    const cname = (id: unknown) => countries.find((c) => c.id === Number(id))?.slug ?? `country ${id}`;
    const el = (e: any) => ({
      id: e.id,
      label: e.label,
      type: e.type,
      state: e.state,
      ...(e.active === 0 || e.active === false ? { active: false } : {}),
      ...(e.extra_fields?.slug ? { slug: e.extra_fields.slug } : {}),
      ...(e.sub_text ? { helpText: e.sub_text } : {}),
      ...(e.min != null ? { min: e.min } : {}),
      ...(e.max != null ? { max: e.max } : {}),
      ...(e.default_value != null ? { defaultValue: e.default_value } : {}),
      priceType: e.price_type,
      options: (e.options ?? []).map((o: any) => ({
        id: o.id,
        label: o.label,
        ...(o.active === 0 || o.active === false ? { active: false } : {}),
        ...(o.extra_fields?.slug ? { slug: o.extra_fields.slug } : {}),
        ...(o.is_default ? { isDefault: true } : {}),
        prices: Object.fromEntries((o.prices ?? []).filter((p: any) => (p.type ?? "sales") === "sales").map((p: any) => [cname(p.country_id), p.price])),
        ...(o.products?.length ? { products: o.products.map((p: any) => p.sku ?? p.id) } : {}),
      })),
    });
    return {
      formId,
      name: admin?.form?.name ?? admin?.name,
      active: admin?.form?.active,
      countries,
      ungrouped: (admin.elements ?? []).map(el),
      groups: (admin.groups ?? []).map((g: any) => ({
        id: g.id,
        label: g.label,
        ...(g.active === 0 || g.active === false ? { active: false } : {}),
        ...(g.is_repeatable ? { repeatable: true } : {}),
        elements: (g.elements ?? []).map(el),
      })),
    };
  }

  async listRules(formId: number) {
    await this.requireAdmin();
    const ids = new Set<number>();
    try {
      for (let start = 0, page = 0; page < 20; page++, start += 100) {
        const data = await this.sessions.json<any>("POST", `/dashboard/form/${formId}/formula-constraint/search`, {
          form: { draw: page + 1, start, length: 100 },
        });
        for (const row of data?.data ?? []) {
          const text = JSON.stringify(row);
          for (const m of text.matchAll(/formula-constraint(?:-builder)?\/(\d+)/g)) ids.add(Number(m[1]));
        }
        const total = Number(data?.recordsFiltered ?? data?.recordsTotal ?? 0);
        if (!total || start + 100 >= total) break;
      }
    } catch {
      // fall back to constraint-usage below
    }
    try {
      const usage = await this.sessions.json<any>("GET", `/dashboard/form-builder/${formId}/constraint-usage`);
      for (const kind of ["groups", "elements", "options"]) {
        for (const v of Object.values(usage?.[kind] ?? {}) as any[]) for (const id of v?.constraints ?? []) ids.add(Number(id));
      }
    } catch (e) {
      if (!ids.size) throw e;
    }
    const rules = await Promise.all(
      [...ids].filter(Number.isFinite).map(async (id) => {
        const r = await this.getRule(formId, id).catch(() => null);
        if (!r) return { id, name: "(could not be read)" };
        const effects = r.constraint?.formula_effects ?? [];
        return {
          id,
          name: r.meta?.name ?? r.constraint?.name,
          order: r.meta?.order ?? r.constraint?.order,
          active: Boolean(r.meta?.active ?? r.constraint?.active),
          categories: (r.meta?.formula_constraint_categories ?? []).map((c: any) => c.name),
          effects: effects.map((e: any) => ({
            type: e.type,
            target: e.form_group_id ? `group ${e.form_group_id}` : e.form_element_id ? `element ${e.form_element_id}` : e.form_option_id ? `option ${e.form_option_id}` : e.product_queryable_id ? "product query" : "?",
          })),
          hasCondition: Boolean(r.constraint?.formula_expression ?? r.constraint?.formula_expression_id),
        };
      }),
    );
    return rules.sort((a: any, b: any) => Number(a.order ?? 0) - Number(b.order ?? 0) || a.id - b.id);
  }

  async getRule(formId: number, ruleId: number) {
    await this.requireAdmin();
    const [tree, meta] = await Promise.all([
      this.sessions.json<any>("GET", `/dashboard/api/formula-constraints/${ruleId}`),
      this.sessions.json<any>("GET", `/dashboard/form/${formId}/formula-constraint-meta/${ruleId}`),
    ]);
    return { id: ruleId, meta, constraint: tree?.data ?? tree };
  }

  // ---- guarded writes ----

  #remember(p: Omit<Pending, "token" | "createdAt">): Pending {
    for (const [k, v] of this.#pending) if (Date.now() - v.createdAt > PENDING_TTL_MS) this.#pending.delete(k);
    const token = crypto.randomBytes(6).toString("hex");
    const full = { ...p, token, createdAt: Date.now() };
    this.#pending.set(token, full);
    return full;
  }

  async apply(token: string): Promise<unknown> {
    const p = this.#pending.get(token);
    if (!p) throw new Error("Unknown or expired confirmation token. Preview the change again.");
    this.#pending.delete(token);
    return p.run();
  }

  backupDir(formId: number): string {
    return path.join(this.sessions.config.dataDir, "backups", this.sessions.config.host, `form-${formId}`);
  }

  #writeBackup(formId: number, admin: unknown, note: string): string {
    const dir = this.backupDir(formId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ formId, note, takenAt: new Date().toISOString(), admin }, null, 1), { mode: 0o600 });
    return file;
  }

  listBackups(formId: number) {
    const dir = this.backupDir(formId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => {
        try {
          const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          return { backupId: f.replace(/\.json$/, ""), takenAt: b.takenAt, note: b.note };
        } catch {
          return { backupId: f.replace(/\.json$/, ""), takenAt: null, note: "(unreadable)" };
        }
      });
  }

  async previewEdits(formId: number, edits: NodeEdit[], reason: string) {
    this.requireEditsEnabled();
    if (!edits.length) throw new Error("No edits given.");
    const admin = await this.adminForm(formId);
    const data = toPostableForm(admin);
    const summary: string[] = [];
    const warnings: string[] = [];
    for (const edit of edits) applyEdit(data, edit, summary, warnings);
    let usage: any = null;
    if (edits.some((e) => e.active === false || e.state)) {
      usage = await this.sessions.json<any>("GET", `/dashboard/form-builder/${formId}/constraint-usage`).catch(() => null);
      for (const e of edits) {
        const bucket = usage?.[`${e.target}s`]?.[String(e.id)];
        if (bucket?.constraints?.length) {
          warnings.push(`Rules ${bucket.constraints.join(", ")} act on ${e.target} ${e.id}; they may show it again or depend on it.`);
        }
      }
    }
    if (edits.some((e) => e.price)) {
      warnings.push("Prices include VAT and are per country; a country without a price row prices this option at 0.");
    }
    const fp = fingerprint(admin);
    const pending = this.#remember({
      kind: "edit",
      formId,
      fingerprint: fp,
      summary,
      run: () => this.#save(formId, fp, data, edits, `Edit: ${reason}`),
    });
    return {
      formId,
      formName: admin?.form?.name,
      changes: summary,
      warnings,
      confirmationToken: pending.token,
      next: "Show these changes to the user. Only after they confirm, call apply_form_change with the token.",
    };
  }

  async #save(formId: number, fp: string, data: PostableForm, edits: NodeEdit[], note: string) {
    const live = await this.adminForm(formId);
    if (fingerprint(live) !== fp) {
      throw new Error("The configurator changed since the preview (someone saved it meanwhile). Nothing was saved. Preview the change again.");
    }
    const backup = this.#writeBackup(formId, live, note);
    await this.sessions.json("POST", `/dashboard/api/form/${formId}`, { json: { id: formId, data } });
    const after = toPostableForm(await this.adminForm(formId));
    const mismatches: string[] = [];
    for (const e of edits) {
      const node = findNode(after, e.target, e.id);
      if (!node) {
        mismatches.push(`${e.target} ${e.id} is missing after the save`);
        continue;
      }
      for (const [field, want] of Object.entries(expectedFields(e))) {
        const got = field.startsWith("price:") ? priceOf(node, Number(field.slice(6))) : (node as any)[field];
        if (normal(got) !== normal(want)) mismatches.push(`${e.target} ${e.id} ${field}: expected ${show(want)}, found ${show(got)}`);
      }
    }
    return {
      saved: true,
      verified: mismatches.length === 0,
      mismatches,
      backupId: path.basename(backup, ".json"),
      undo: "To undo, call preview_restore_form with this backupId.",
    };
  }

  async previewRestore(formId: number, backupId: string) {
    this.requireEditsEnabled();
    const file = path.join(this.backupDir(formId), `${path.basename(backupId)}.json`);
    if (!fs.existsSync(file)) throw new Error(`No backup ${backupId} for form ${formId}. Call list_form_backups.`);
    const backup = JSON.parse(fs.readFileSync(file, "utf8"));
    const live = await this.adminForm(formId);
    const target = toPostableForm(backup.admin);
    const current = toPostableForm(live);
    const summary = diffForms(current, target);
    const missing = summary.filter((s) => s.startsWith("Comes back"));
    const fp = fingerprint(live);
    const pending = this.#remember({
      kind: "restore",
      formId,
      fingerprint: fp,
      summary,
      run: async () => {
        const again = await this.adminForm(formId);
        if (fingerprint(again) !== fp) throw new Error("The configurator changed since the preview. Nothing was restored. Preview again.");
        const safety = this.#writeBackup(formId, again, `Before restoring ${backupId}`);
        // Nodes deleted since the backup cannot come back under their old ids: drop their ids so they are created anew.
        const liveIds = collectIds(current);
        stripUnknownIds(target, liveIds);
        await this.sessions.json("POST", `/dashboard/api/form/${formId}`, { json: { id: formId, data: target } });
        return { restored: backupId, backupOfStateBefore: path.basename(safety, ".json") };
      },
    });
    return {
      formId,
      restoring: { backupId, takenAt: backup.takenAt, note: backup.note },
      changes: summary.length ? summary : ["The live configurator already matches this backup."],
      warnings: [
        ...(missing.length
          ? ["Nodes deleted since the backup come back under new ids: saved drafts and quotes that chose them, and rules that referred to them, will not find them."]
          : []),
        ...(summary.some((s) => s.startsWith("Removed"))
          ? ["Nodes added since the backup are deleted. If a rule still refers to one, config-panel refuses the save and nothing changes."]
          : []),
      ],
      confirmationToken: pending.token,
      next: "Show these changes to the user. Only after they confirm, call apply_form_change with the token.",
    };
  }

  async previewRuleActive(formId: number, ruleId: number, active: boolean, reason: string) {
    this.requireEditsEnabled();
    const rule = await this.getRule(formId, ruleId);
    const name = rule.meta?.name ?? `rule ${ruleId}`;
    const was = Boolean(rule.meta?.active);
    if (was === active) throw new Error(`Rule "${name}" is already ${active ? "on" : "off"}.`);
    const fp = fingerprint(rule.meta);
    const pending = this.#remember({
      kind: "rule-active",
      formId,
      fingerprint: fp,
      summary: [`Rule ${ruleId} "${name}": ${was ? "on" : "off"} → ${active ? "on" : "off"}`],
      run: async () => {
        const meta = await this.sessions.json<any>("GET", `/dashboard/form/${formId}/formula-constraint-meta/${ruleId}`);
        if (fingerprint(meta) !== fp) throw new Error("The rule changed since the preview. Nothing was saved. Preview again.");
        const s = await this.sessions.ensure();
        await this.sessions.json("PUT", `/dashboard/form/${formId}/formula-constraint-meta/${ruleId}`, {
          json: { ...meta, active: active ? 1 : 0, _token: s?.csrf, reason },
        });
        const after = await this.sessions.json<any>("GET", `/dashboard/form/${formId}/formula-constraint-meta/${ruleId}`);
        return { saved: true, verified: Boolean(after?.active) === active, undo: `Switch it ${was ? "on" : "off"} again the same way.` };
      },
    });
    return {
      formId,
      changes: pending.summary,
      warnings: [
        active
          ? "A rule that is switched on runs for every shopper at once; one rule whose condition fails to evaluate stops all rules of the Form."
          : "While off, whatever this rule shows, hides, requires or prices no longer happens.",
      ],
      confirmationToken: pending.token,
      next: "Show this to the user. Only after they confirm, call apply_form_change with the token.",
    };
  }
}

// ---- helpers over the postable form ----

function findNode(data: PostableForm, target: NodeEdit["target"], id: number): any {
  if (target === "group") return data.groups.find((g) => g.id === id);
  const elements = [...data.elements, ...data.groups.flatMap((g) => g.elements)];
  if (target === "element") return elements.find((e) => e.id === id);
  for (const e of elements) {
    const o = e.options.find((x) => x.id === id);
    if (o) return o;
  }
  return undefined;
}

function priceOf(option: any, countryId: number): unknown {
  return option.prices?.find((p: any) => Number(p.country_id) === countryId && (p.type ?? "sales") === "sales")?.price ?? null;
}

const normal = (v: unknown) => {
  if (v === true || v === 1 || v === "1") return "true";
  if (v === false || v === 0 || v === "0") return "false";
  if (v === undefined || v === "") return "null";
  return JSON.stringify(typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
};

/** Fields the save must show afterwards, by postable field name. */
function expectedFields(e: NodeEdit): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (e.label !== undefined) out.label = e.label;
  if (e.helpText !== undefined) out[e.target === "group" ? "description" : "sub_text"] = e.helpText;
  if (e.active !== undefined) out.active = e.active;
  if (e.state !== undefined) out.state = e.state;
  if (e.order !== undefined) out.order = e.order;
  if (e.placeholder !== undefined) out.placeholder = e.placeholder;
  if (e.min !== undefined) out.min = e.min;
  if (e.max !== undefined) out.max = e.max;
  if (e.step !== undefined) out.step = e.step;
  if (e.defaultValue !== undefined) out.default_value = e.defaultValue == null ? null : String(e.defaultValue);
  if (e.isDefault !== undefined) out.is_default = e.isDefault;
  if (e.minQuantity !== undefined) out.min_quantity = e.minQuantity;
  if (e.maxQuantity !== undefined) out.max_quantity = e.maxQuantity;
  if (e.price) out[`price:${e.price.countryId}`] = e.price.amount;
  return out;
}

function applyEdit(data: PostableForm, e: NodeEdit, summary: string[], warnings: string[]): void {
  const node = findNode(data, e.target, e.id);
  if (!node) throw new Error(`There is no ${e.target} ${e.id} on this form. Read the outline for ids.`);
  const name = `${e.target} ${e.id} "${node.label}"`;
  const set = (field: string, value: unknown, label = field) => {
    if (normal(node[field]) === normal(value)) return;
    summary.push(`${name}: ${label} ${show(node[field])} → ${show(value)}`);
    node[field] = value;
  };
  const only = (kinds: NodeEdit["target"][], field: string) => {
    if (!kinds.includes(e.target)) throw new Error(`"${field}" cannot be set on a ${e.target}.`);
  };

  if (e.label !== undefined) {
    if (!e.label.trim()) throw new Error(`${name}: a label cannot be empty.`);
    set("label", e.label);
  }
  if (e.helpText !== undefined) set(e.target === "group" ? "description" : "sub_text", e.helpText, "help text");
  if (e.active !== undefined) set("active", e.active, "visible");
  if (e.order !== undefined) set("order", e.order);
  if (e.state !== undefined) {
    only(["element"], "state");
    set("state", e.state, "state");
  }
  for (const [key, field] of [["placeholder", "placeholder"], ["min", "min"], ["max", "max"], ["step", "step"]] as const) {
    if (e[key] !== undefined) {
      only(["element"], key);
      if ((key === "min" || key === "max") && e[key] != null && !Number.isInteger(e[key])) {
        throw new Error(`${name}: min and max are whole numbers in config-panel (use mm rather than m).`);
      }
      set(field, e[key]);
    }
  }
  if (e.defaultValue !== undefined) {
    only(["element"], "defaultValue");
    if (["select", "radio"].includes(node.type) && e.defaultValue != null && !node.options.some((o: any) => String(o.id) === String(e.defaultValue))) {
      throw new Error(`${name}: the default must be the id of one of its options.`);
    }
    if (node.type === "checkbox") throw new Error(`${name}: a checkbox's defaults are set with isDefault on its options.`);
    set("default_value", e.defaultValue == null ? null : String(e.defaultValue), "default");
  }
  if (e.isDefault !== undefined) {
    only(["option"], "isDefault");
    set("is_default", e.isDefault, "selected by default");
  }
  if (e.minQuantity !== undefined || e.maxQuantity !== undefined) {
    only(["option"], "quantity");
    if (e.minQuantity !== undefined) set("min_quantity", e.minQuantity, "min quantity");
    if (e.maxQuantity !== undefined) set("max_quantity", e.maxQuantity, "max quantity");
    if (node.min_quantity != null && node.max_quantity != null && node.min_quantity > node.max_quantity) {
      throw new Error(`${name}: min quantity is above max quantity.`);
    }
  }
  if (e.price) {
    only(["option"], "price");
    if (!Number.isFinite(e.price.amount)) throw new Error(`${name}: price must be a number.`);
    if (node.products?.length) warnings.push(`${name} is linked to a product: the product's price, not this option's, prices it.`);
    const row = node.prices.find((p: any) => Number(p.country_id) === e.price!.countryId && (p.type ?? "sales") === "sales");
    const before = row?.price ?? null;
    if (normal(before) !== normal(e.price.amount)) {
      summary.push(`${name}: price in country ${e.price.countryId} ${show(before)} → ${e.price.amount}`);
      if (row) row.price = e.price.amount;
      else node.prices.push({ id: null, country_id: e.price.countryId, price: e.price.amount, vat_id: null, type: "sales" });
    }
  }
  if (e.translation) {
    for (const [k, v] of Object.entries(e.translation)) {
      if (!/^[a-z]{2}_[a-z_]+$/.test(k)) throw new Error(`Translation keys look like "da_label"; got "${k}".`);
      const t = (node.translation && typeof node.translation === "object" ? node.translation : {}) as Record<string, string>;
      if (t[k] !== v) {
        summary.push(`${name}: translation ${k} ${show(t[k])} → ${show(v)}`);
        node.translation = { ...t, [k]: v };
      }
    }
  }
}

function collectIds(data: PostableForm): Set<string> {
  const ids = new Set<string>();
  for (const g of data.groups) {
    ids.add(`g${g.id}`);
    for (const e of g.elements) {
      ids.add(`e${e.id}`);
      for (const o of e.options) ids.add(`o${o.id}`);
    }
  }
  for (const e of data.elements) {
    ids.add(`e${e.id}`);
    for (const o of e.options) ids.add(`o${o.id}`);
  }
  return ids;
}

function stripUnknownIds(data: PostableForm, live: Set<string>): void {
  let next = -1;
  const fix = (prefix: string, node: any) => {
    if (!live.has(`${prefix}${node.id}`)) {
      node.id = next--;
      for (const p of node.prices ?? []) p.id = null;
    }
  };
  for (const g of data.groups) {
    fix("g", g);
    for (const e of g.elements) {
      fix("e", e);
      e.form_group_id = g.id;
      for (const o of e.options) fix("o", o);
    }
  }
  for (const e of data.elements) {
    fix("e", e);
    for (const o of e.options) fix("o", o);
  }
}

function diffForms(current: PostableForm, target: PostableForm): string[] {
  const out: string[] = [];
  const index = (d: PostableForm) => {
    const m = new Map<string, any>();
    for (const g of d.groups) {
      m.set(`group ${g.id}`, g);
      for (const e of g.elements) {
        m.set(`element ${e.id}`, e);
        for (const o of e.options) m.set(`option ${o.id}`, o);
      }
    }
    for (const e of d.elements) {
      m.set(`element ${e.id}`, e);
      for (const o of e.options) m.set(`option ${o.id}`, o);
    }
    return m;
  };
  const a = index(current);
  const b = index(target);
  const fields = ["label", "active", "state", "order", "sub_text", "description", "placeholder", "min", "max", "step", "default_value", "is_default", "min_quantity", "max_quantity", "translation", "extra_fields"];
  for (const [key, node] of b) {
    const now = a.get(key);
    if (!now) {
      out.push(`Comes back: ${key} "${node.label}" (under a new id)`);
      continue;
    }
    for (const f of fields) if (normal(now[f]) !== normal(node[f])) out.push(`${key} "${now.label}": ${f} ${show(now[f])} → ${show(node[f])}`);
    if (key.startsWith("option") && normal(now.prices?.map((p: any) => [p.country_id, p.price])) !== normal(node.prices?.map((p: any) => [p.country_id, p.price]))) {
      out.push(`${key} "${now.label}": prices change`);
    }
  }
  for (const [key, node] of a) if (!b.has(key)) out.push(`Removed: ${key} "${node.label}" (added after the backup)`);
  return out;
}
