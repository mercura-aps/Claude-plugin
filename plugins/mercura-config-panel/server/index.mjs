#!/usr/bin/env node
// Mercura config-panel Claude plugin 0.1.1 (2026-11-26). The plugin's own code; its source is server/src/ in this repository. Third-party code is in vendor.min.mjs.

// src/index.ts
import { McpServer } from "./vendor.min.mjs";
import { StdioServerTransport } from "./vendor.min.mjs";

// src/admin/admin.ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// src/admin/form-patch.ts
function toPostableForm(admin) {
  const root = asRecord(admin);
  if (!Array.isArray(root.groups)) {
    throw new Error("Admin form payload has no groups array. Refusing to save a partial structure.");
  }
  return {
    groups: root.groups.map((group) => toPostableGroup(group)),
    elements: asArray(root.elements).map((element) => toPostableElement(element, null))
  };
}
function repeatableFromAdmin(group) {
  const flag = group.is_repeatable;
  const isRepeatable = flag === true || flag === 1 || flag === "1";
  if (!isRepeatable) return { is_repeatable: false, min_instances: 0, max_instances: null };
  return {
    is_repeatable: true,
    min_instances: countOr(group.min_instances, 0),
    max_instances: group.max_instances == null || group.max_instances === "" ? null : countOr(group.max_instances, 0)
  };
}
function countOr(value, fallback) {
  const count = Number(value);
  return Number.isInteger(count) ? count : fallback;
}
function toPostableGroup(raw) {
  const group = asRecord(raw);
  const id = numberId(group.id);
  return {
    id,
    label: stringOr(group.label, ""),
    active: group.active ?? true,
    order: group.order ?? 0,
    type: stringOr(group.type, "default"),
    ...repeatableFromAdmin(group),
    description: group.description ?? null,
    extra_fields: group.extra_fields ?? null,
    translation: group.translation ?? null,
    data: group.data ?? null,
    images: toIds(group.images),
    elements: asArray(group.elements).map((element) => toPostableElement(element, id))
  };
}
function toPostableElement(raw, groupId) {
  const element = asRecord(raw);
  const explicitGroup = element.form_group_id == null ? null : numberId(element.form_group_id);
  return {
    id: numberId(element.id),
    label: stringOr(element.label, ""),
    type: stringOr(element.type, "text"),
    active: element.active ?? true,
    state: stringOr(element.state, "open"),
    order: element.order ?? 0,
    placeholder: element.placeholder ?? null,
    min: element.min ?? null,
    max: element.max ?? null,
    step: element.step ?? null,
    format: element.format ?? null,
    default_value: element.default_value ?? null,
    sub_text: element.sub_text ?? null,
    translation: element.translation ?? null,
    price_type: stringOr(element.price_type, "none"),
    dynamic_product_operator: element.dynamic_product_operator ?? null,
    multiplier: element.multiplier ?? null,
    extra_fields: element.extra_fields ?? null,
    images: toIds(element.images),
    models_3d: toIds(element.models_3d),
    options: asArray(element.options).map(toPostableOption),
    productProperties: toIdObjects(element.productProperties),
    productPropertyAttributes: toIdObjects(element.productPropertyAttributes),
    form_group_id: groupId ?? (explicitGroup && explicitGroup > 0 ? explicitGroup : null)
  };
}
function toPostableOption(raw) {
  const option = asRecord(raw);
  const documentationIds = Array.isArray(option.documentation_ids) ? toIds(option.documentation_ids) : toIds(option.documentations);
  return {
    id: numberId(option.id),
    label: option.label ?? null,
    active: option.active ?? true,
    order: option.order ?? 0,
    is_default: option.is_default ?? false,
    sub_text: option.sub_text ?? null,
    translation: option.translation ?? null,
    extra_fields: option.extra_fields ?? null,
    allow_quantity: option.allow_quantity ?? false,
    allow_dynamic_pricing: option.allow_dynamic_pricing ?? false,
    min_quantity: option.min_quantity ?? null,
    max_quantity: option.max_quantity ?? null,
    images: toIds(option.images),
    models_3d: toIds(option.models_3d),
    prices: asArray(option.prices).map((price) => {
      const row = asRecord(price);
      return {
        id: row.id == null ? null : numberId(row.id),
        country_id: row.country_id ?? null,
        price: row.price ?? null,
        vat_id: row.vat_id ?? null,
        type: stringOr(row.type, "sales")
      };
    }),
    products: toIdObjects(option.products),
    discount_groups: asArray(option.discount_groups).map((group) => {
      const row = asRecord(group);
      const pivot = asRecord(row.pivot);
      return {
        id: numberId(row.id),
        pivot: { price_change: pivot.price_change ?? row.price_change ?? null }
      };
    }),
    documentation_ids: documentationIds
  };
}
function toIds(value) {
  return asArray(value).map((item) => item && typeof item === "object" ? numberId(asRecord(item).id) : numberId(item)).filter((id) => id > 0);
}
function toIdObjects(value) {
  return toIds(value).map((id) => ({ id }));
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function numberId(value) {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isFinite(id) ? id : 0;
}
function stringOr(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

// src/admin/admin.ts
var PENDING_TTL_MS = 30 * 60 * 1e3;
var ADMIN_LEVELS = /* @__PURE__ */ new Set(["admin", "super_admin", "dev"]);
function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
var show = (v) => v === null || v === void 0 ? "\u2205" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
var AdminService = class {
  #pending = /* @__PURE__ */ new Map();
  sessions;
  constructor(sessions) {
    this.sessions = sessions;
  }
  // ---- who may do what ----
  async currentUser() {
    const r = await this.sessions.json("GET", "/api/user");
    const u = r?.user ?? r;
    return { name: u?.name, email: u?.email, level: u?.level };
  }
  async requireAdmin() {
    const u = await this.currentUser();
    if (!ADMIN_LEVELS.has(u.level)) {
      throw new Error(`Your config-panel user (${u.email}) has level "${u.level}". Editing configurators needs level admin.`);
    }
  }
  requireEditsEnabled() {
    if (!this.sessions.config.allowEdits) {
      throw new Error(
        'Edits are switched off for this plugin. To allow them, run /plugin, open the config-panel plugin, choose Configure and set "Allow edits" to true.'
      );
    }
  }
  // ---- reads ----
  async adminForm(formId) {
    await this.requireAdmin();
    return this.sessions.json("GET", `/dashboard/api/form/${formId}`);
  }
  async countries() {
    try {
      const r = await this.sessions.json("GET", "/api/localization/countries");
      const list = Array.isArray(r) ? r : r?.data ?? [];
      return list.map((c) => ({ id: c.id, slug: c.slug, name: c.name, currency: c.currency?.code }));
    } catch {
      return [];
    }
  }
  /** A compact tree of the Form for reading and for choosing ids. */
  async outline(formId) {
    const admin = await this.adminForm(formId);
    const countries = await this.countries();
    const cname = (id) => countries.find((c) => c.id === Number(id))?.slug ?? `country ${id}`;
    const el = (e) => ({
      id: e.id,
      label: e.label,
      type: e.type,
      state: e.state,
      ...e.active === 0 || e.active === false ? { active: false } : {},
      ...e.extra_fields?.slug ? { slug: e.extra_fields.slug } : {},
      ...e.sub_text ? { helpText: e.sub_text } : {},
      ...e.min != null ? { min: e.min } : {},
      ...e.max != null ? { max: e.max } : {},
      ...e.default_value != null ? { defaultValue: e.default_value } : {},
      priceType: e.price_type,
      options: (e.options ?? []).map((o) => ({
        id: o.id,
        label: o.label,
        ...o.active === 0 || o.active === false ? { active: false } : {},
        ...o.extra_fields?.slug ? { slug: o.extra_fields.slug } : {},
        ...o.is_default ? { isDefault: true } : {},
        prices: Object.fromEntries((o.prices ?? []).filter((p) => (p.type ?? "sales") === "sales").map((p) => [cname(p.country_id), p.price])),
        ...o.products?.length ? { products: o.products.map((p) => p.sku ?? p.id) } : {}
      }))
    });
    return {
      formId,
      name: admin?.form?.name ?? admin?.name,
      active: admin?.form?.active,
      countries,
      ungrouped: (admin.elements ?? []).map(el),
      groups: (admin.groups ?? []).map((g) => ({
        id: g.id,
        label: g.label,
        ...g.active === 0 || g.active === false ? { active: false } : {},
        ...g.is_repeatable ? { repeatable: true } : {},
        elements: (g.elements ?? []).map(el)
      }))
    };
  }
  async listRules(formId) {
    await this.requireAdmin();
    const ids = /* @__PURE__ */ new Set();
    try {
      for (let start = 0, page = 0; page < 20; page++, start += 100) {
        const data = await this.sessions.json("POST", `/dashboard/form/${formId}/formula-constraint/search`, {
          form: { draw: page + 1, start, length: 100 }
        });
        for (const row of data?.data ?? []) {
          const text = JSON.stringify(row);
          for (const m of text.matchAll(/formula-constraint(?:-builder)?\/(\d+)/g)) ids.add(Number(m[1]));
        }
        const total = Number(data?.recordsFiltered ?? data?.recordsTotal ?? 0);
        if (!total || start + 100 >= total) break;
      }
    } catch {
    }
    try {
      const usage = await this.sessions.json("GET", `/dashboard/form-builder/${formId}/constraint-usage`);
      for (const kind of ["groups", "elements", "options"]) {
        for (const v of Object.values(usage?.[kind] ?? {})) for (const id of v?.constraints ?? []) ids.add(Number(id));
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
          categories: (r.meta?.formula_constraint_categories ?? []).map((c) => c.name),
          effects: effects.map((e) => ({
            type: e.type,
            target: e.form_group_id ? `group ${e.form_group_id}` : e.form_element_id ? `element ${e.form_element_id}` : e.form_option_id ? `option ${e.form_option_id}` : e.product_queryable_id ? "product query" : "?"
          })),
          hasCondition: Boolean(r.constraint?.formula_expression ?? r.constraint?.formula_expression_id)
        };
      })
    );
    return rules.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) || a.id - b.id);
  }
  async getRule(formId, ruleId) {
    await this.requireAdmin();
    const [tree, meta] = await Promise.all([
      this.sessions.json("GET", `/dashboard/api/formula-constraints/${ruleId}`),
      this.sessions.json("GET", `/dashboard/form/${formId}/formula-constraint-meta/${ruleId}`)
    ]);
    return { id: ruleId, meta, constraint: tree?.data ?? tree };
  }
  // ---- guarded writes ----
  #remember(p) {
    for (const [k, v] of this.#pending) if (Date.now() - v.createdAt > PENDING_TTL_MS) this.#pending.delete(k);
    const token = crypto.randomBytes(6).toString("hex");
    const full = { ...p, token, createdAt: Date.now() };
    this.#pending.set(token, full);
    return full;
  }
  async apply(token) {
    const p = this.#pending.get(token);
    if (!p) throw new Error("Unknown or expired confirmation token. Preview the change again.");
    this.#pending.delete(token);
    return p.run();
  }
  backupDir(formId) {
    return path.join(this.sessions.config.dataDir, "backups", this.sessions.config.host, `form-${formId}`);
  }
  #writeBackup(formId, admin, note) {
    const dir = this.backupDir(formId);
    fs.mkdirSync(dir, { recursive: true, mode: 448 });
    const file = path.join(dir, `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ formId, note, takenAt: (/* @__PURE__ */ new Date()).toISOString(), admin }, null, 1), { mode: 384 });
    return file;
  }
  listBackups(formId) {
    const dir = this.backupDir(formId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        return { backupId: f.replace(/\.json$/, ""), takenAt: b.takenAt, note: b.note };
      } catch {
        return { backupId: f.replace(/\.json$/, ""), takenAt: null, note: "(unreadable)" };
      }
    });
  }
  async previewEdits(formId, edits, reason) {
    this.requireEditsEnabled();
    if (!edits.length) throw new Error("No edits given.");
    const admin = await this.adminForm(formId);
    const data = toPostableForm(admin);
    const summary = [];
    const warnings = [];
    for (const edit of edits) applyEdit(data, edit, summary, warnings);
    let usage = null;
    if (edits.some((e) => e.active === false || e.state)) {
      usage = await this.sessions.json("GET", `/dashboard/form-builder/${formId}/constraint-usage`).catch(() => null);
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
      run: () => this.#save(formId, fp, data, edits, `Edit: ${reason}`)
    });
    return {
      formId,
      formName: admin?.form?.name,
      changes: summary,
      warnings,
      confirmationToken: pending.token,
      next: "Show these changes to the user. Only after they confirm, call apply_form_change with the token."
    };
  }
  async #save(formId, fp, data, edits, note) {
    const live = await this.adminForm(formId);
    if (fingerprint(live) !== fp) {
      throw new Error("The configurator changed since the preview (someone saved it meanwhile). Nothing was saved. Preview the change again.");
    }
    const backup = this.#writeBackup(formId, live, note);
    await this.sessions.json("POST", `/dashboard/api/form/${formId}`, { json: { id: formId, data } });
    const after = toPostableForm(await this.adminForm(formId));
    const mismatches = [];
    for (const e of edits) {
      const node = findNode(after, e.target, e.id);
      if (!node) {
        mismatches.push(`${e.target} ${e.id} is missing after the save`);
        continue;
      }
      for (const [field, want] of Object.entries(expectedFields(e))) {
        const got = field.startsWith("price:") ? priceOf(node, Number(field.slice(6))) : node[field];
        if (normal(got) !== normal(want)) mismatches.push(`${e.target} ${e.id} ${field}: expected ${show(want)}, found ${show(got)}`);
      }
    }
    return {
      saved: true,
      verified: mismatches.length === 0,
      mismatches,
      backupId: path.basename(backup, ".json"),
      undo: "To undo, call preview_restore_form with this backupId."
    };
  }
  async previewRestore(formId, backupId) {
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
        const liveIds = collectIds(current);
        stripUnknownIds(target, liveIds);
        await this.sessions.json("POST", `/dashboard/api/form/${formId}`, { json: { id: formId, data: target } });
        return { restored: backupId, backupOfStateBefore: path.basename(safety, ".json") };
      }
    });
    return {
      formId,
      restoring: { backupId, takenAt: backup.takenAt, note: backup.note },
      changes: summary.length ? summary : ["The live configurator already matches this backup."],
      warnings: [
        ...missing.length ? ["Nodes deleted since the backup come back under new ids: saved drafts and quotes that chose them, and rules that referred to them, will not find them."] : [],
        ...summary.some((s) => s.startsWith("Removed")) ? ["Nodes added since the backup are deleted. If a rule still refers to one, config-panel refuses the save and nothing changes."] : []
      ],
      confirmationToken: pending.token,
      next: "Show these changes to the user. Only after they confirm, call apply_form_change with the token."
    };
  }
  async previewRuleActive(formId, ruleId, active, reason) {
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
      summary: [`Rule ${ruleId} "${name}": ${was ? "on" : "off"} \u2192 ${active ? "on" : "off"}`],
      run: async () => {
        const meta = await this.sessions.json("GET", `/dashboard/form/${formId}/formula-constraint-meta/${ruleId}`);
        if (fingerprint(meta) !== fp) throw new Error("The rule changed since the preview. Nothing was saved. Preview again.");
        const s = await this.sessions.ensure();
        await this.sessions.json("PUT", `/dashboard/form/${formId}/formula-constraint-meta/${ruleId}`, {
          json: { ...meta, active: active ? 1 : 0, _token: s?.csrf, reason }
        });
        const after = await this.sessions.json("GET", `/dashboard/form/${formId}/formula-constraint-meta/${ruleId}`);
        return { saved: true, verified: Boolean(after?.active) === active, undo: `Switch it ${was ? "on" : "off"} again the same way.` };
      }
    });
    return {
      formId,
      changes: pending.summary,
      warnings: [
        active ? "A rule that is switched on runs for every shopper at once; one rule whose condition fails to evaluate stops all rules of the Form." : "While off, whatever this rule shows, hides, requires or prices no longer happens."
      ],
      confirmationToken: pending.token,
      next: "Show this to the user. Only after they confirm, call apply_form_change with the token."
    };
  }
};
function findNode(data, target, id) {
  if (target === "group") return data.groups.find((g) => g.id === id);
  const elements = [...data.elements, ...data.groups.flatMap((g) => g.elements)];
  if (target === "element") return elements.find((e) => e.id === id);
  for (const e of elements) {
    const o = e.options.find((x) => x.id === id);
    if (o) return o;
  }
  return void 0;
}
function priceOf(option, countryId) {
  return option.prices?.find((p) => Number(p.country_id) === countryId && (p.type ?? "sales") === "sales")?.price ?? null;
}
var normal = (v) => {
  if (v === true || v === 1 || v === "1") return "true";
  if (v === false || v === 0 || v === "0") return "false";
  if (v === void 0 || v === "") return "null";
  return JSON.stringify(typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
};
function expectedFields(e) {
  const out = {};
  if (e.label !== void 0) out.label = e.label;
  if (e.helpText !== void 0) out[e.target === "group" ? "description" : "sub_text"] = e.helpText;
  if (e.active !== void 0) out.active = e.active;
  if (e.state !== void 0) out.state = e.state;
  if (e.order !== void 0) out.order = e.order;
  if (e.placeholder !== void 0) out.placeholder = e.placeholder;
  if (e.min !== void 0) out.min = e.min;
  if (e.max !== void 0) out.max = e.max;
  if (e.step !== void 0) out.step = e.step;
  if (e.defaultValue !== void 0) out.default_value = e.defaultValue == null ? null : String(e.defaultValue);
  if (e.isDefault !== void 0) out.is_default = e.isDefault;
  if (e.minQuantity !== void 0) out.min_quantity = e.minQuantity;
  if (e.maxQuantity !== void 0) out.max_quantity = e.maxQuantity;
  if (e.price) out[`price:${e.price.countryId}`] = e.price.amount;
  return out;
}
function applyEdit(data, e, summary, warnings) {
  const node = findNode(data, e.target, e.id);
  if (!node) throw new Error(`There is no ${e.target} ${e.id} on this form. Read the outline for ids.`);
  const name = `${e.target} ${e.id} "${node.label}"`;
  const set = (field, value, label = field) => {
    if (normal(node[field]) === normal(value)) return;
    summary.push(`${name}: ${label} ${show(node[field])} \u2192 ${show(value)}`);
    node[field] = value;
  };
  const only = (kinds, field) => {
    if (!kinds.includes(e.target)) throw new Error(`"${field}" cannot be set on a ${e.target}.`);
  };
  if (e.label !== void 0) {
    if (!e.label.trim()) throw new Error(`${name}: a label cannot be empty.`);
    set("label", e.label);
  }
  if (e.helpText !== void 0) set(e.target === "group" ? "description" : "sub_text", e.helpText, "help text");
  if (e.active !== void 0) set("active", e.active, "visible");
  if (e.order !== void 0) set("order", e.order);
  if (e.state !== void 0) {
    only(["element"], "state");
    set("state", e.state, "state");
  }
  for (const [key, field] of [["placeholder", "placeholder"], ["min", "min"], ["max", "max"], ["step", "step"]]) {
    if (e[key] !== void 0) {
      only(["element"], key);
      if ((key === "min" || key === "max") && e[key] != null && !Number.isInteger(e[key])) {
        throw new Error(`${name}: min and max are whole numbers in config-panel (use mm rather than m).`);
      }
      set(field, e[key]);
    }
  }
  if (e.defaultValue !== void 0) {
    only(["element"], "defaultValue");
    if (["select", "radio"].includes(node.type) && e.defaultValue != null && !node.options.some((o) => String(o.id) === String(e.defaultValue))) {
      throw new Error(`${name}: the default must be the id of one of its options.`);
    }
    if (node.type === "checkbox") throw new Error(`${name}: a checkbox's defaults are set with isDefault on its options.`);
    set("default_value", e.defaultValue == null ? null : String(e.defaultValue), "default");
  }
  if (e.isDefault !== void 0) {
    only(["option"], "isDefault");
    set("is_default", e.isDefault, "selected by default");
  }
  if (e.minQuantity !== void 0 || e.maxQuantity !== void 0) {
    only(["option"], "quantity");
    if (e.minQuantity !== void 0) set("min_quantity", e.minQuantity, "min quantity");
    if (e.maxQuantity !== void 0) set("max_quantity", e.maxQuantity, "max quantity");
    if (node.min_quantity != null && node.max_quantity != null && node.min_quantity > node.max_quantity) {
      throw new Error(`${name}: min quantity is above max quantity.`);
    }
  }
  if (e.price) {
    only(["option"], "price");
    if (!Number.isFinite(e.price.amount)) throw new Error(`${name}: price must be a number.`);
    if (node.products?.length) warnings.push(`${name} is linked to a product: the product's price, not this option's, prices it.`);
    const row = node.prices.find((p) => Number(p.country_id) === e.price.countryId && (p.type ?? "sales") === "sales");
    const before = row?.price ?? null;
    if (normal(before) !== normal(e.price.amount)) {
      summary.push(`${name}: price in country ${e.price.countryId} ${show(before)} \u2192 ${e.price.amount}`);
      if (row) row.price = e.price.amount;
      else node.prices.push({ id: null, country_id: e.price.countryId, price: e.price.amount, vat_id: null, type: "sales" });
    }
  }
  if (e.translation) {
    for (const [k, v] of Object.entries(e.translation)) {
      if (!/^[a-z]{2}_[a-z_]+$/.test(k)) throw new Error(`Translation keys look like "da_label"; got "${k}".`);
      const t = node.translation && typeof node.translation === "object" ? node.translation : {};
      if (t[k] !== v) {
        summary.push(`${name}: translation ${k} ${show(t[k])} \u2192 ${show(v)}`);
        node.translation = { ...t, [k]: v };
      }
    }
  }
}
function collectIds(data) {
  const ids = /* @__PURE__ */ new Set();
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
function stripUnknownIds(data, live) {
  let next = -1;
  const fix = (prefix, node) => {
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
function diffForms(current, target) {
  const out = [];
  const index = (d) => {
    const m = /* @__PURE__ */ new Map();
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
    for (const f of fields) if (normal(now[f]) !== normal(node[f])) out.push(`${key} "${now.label}": ${f} ${show(now[f])} \u2192 ${show(node[f])}`);
    if (key.startsWith("option") && normal(now.prices?.map((p) => [p.country_id, p.price])) !== normal(node.prices?.map((p) => [p.country_id, p.price]))) {
      out.push(`${key} "${now.label}": prices change`);
    }
  }
  for (const [key, node] of a) if (!b.has(key)) out.push(`Removed: ${key} "${node.label}" (added after the backup)`);
  return out;
}

// src/config.ts
var HOW_TO_LOG_IN = "Log in through Claude Code's plugin settings: run /plugin, open the Installed tab, select Mercura config-panel, choose Configure and enter your config-panel address, username and password (the password is kept in your computer's secure storage). Then run /reload-plugins. Do not type the password into the chat.";
var NotConfiguredError = class extends Error {
};
function clean(value) {
  const v = value?.trim();
  if (!v || v.startsWith("${")) return void 0;
  return v;
}
function normalizeOrigin(input) {
  const raw = input.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new NotConfiguredError(`The config-panel address must use https (got ${url.hostname} over http). ${HOW_TO_LOG_IN}`);
  }
  return url.origin;
}
function loadConfig(env = process.env) {
  const hostInput = clean(env.CONFIG_PANEL_HOST);
  const username = clean(env.CONFIG_PANEL_USERNAME);
  const password = clean(env.CONFIG_PANEL_PASSWORD);
  const missing = [!hostInput && "address", !username && "username", !password && "password"].filter(Boolean);
  if (missing.length) {
    throw new NotConfiguredError(`You are not logged in to config-panel yet (missing: ${missing.join(", ")}). ${HOW_TO_LOG_IN}`);
  }
  let origin;
  try {
    origin = normalizeOrigin(hostInput);
  } catch (error) {
    if (error instanceof NotConfiguredError) throw error;
    throw new NotConfiguredError(`"${hostInput}" is not a valid config-panel address. ${HOW_TO_LOG_IN}`);
  }
  return {
    origin,
    host: new URL(origin).host,
    username,
    password,
    dataDir: clean(env.CONFIG_PANEL_DATA_DIR) ?? `${env.HOME ?? env.USERPROFILE ?? "."}/.config-panel-plugin`,
    allowEdits: /^(1|true|yes|on)$/i.test(clean(env.CONFIG_PANEL_ALLOW_EDITS) ?? "")
  };
}

// src/engine/quote.ts
import { createSDKStore } from "./vendor.min.mjs";

// src/engine/gateway.ts
var EMPTY_BOM = {
  id: 0,
  hide_on_checkout: false,
  hide_on_pdf: false,
  hide_on_excel: false,
  hide_on_email: false,
  tables: [],
  summary: null
};
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
var installed = false;
var gatewayLog = {};
function installGateway(sessions) {
  if (installed) return;
  installed = true;
  const origin = sessions.config.origin;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const OriginalRequest = globalThis.Request;
  class RelativeRequest extends OriginalRequest {
    constructor(input, init) {
      if (typeof input === "string" && !/^https?:/i.test(input)) input = new URL(input, origin).href;
      super(input, init);
    }
  }
  globalThis.Request = RelativeRequest;
  globalThis.fetch = (async (input, init) => {
    const raw = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const url = new URL(raw, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return originalFetch(input, init);
    const send = async (cookie) => {
      const headers = new Headers(init?.headers);
      if (input instanceof Request) input.headers.forEach((v, k) => headers.has(k) || headers.set(k, v));
      headers.set("Accept", headers.get("Accept") ?? "application/json");
      headers.set("X-Requested-With", "XMLHttpRequest");
      if (cookie) headers.set("Cookie", cookie);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const body = init?.body ?? (input instanceof Request && method !== "GET" ? await input.clone().text() : void 0);
      return originalFetch(url, { method, headers, body, redirect: "manual" });
    };
    let response = await send(await sessions.cookieHeader());
    if (response.status === 401) {
      await sessions.ensure({ force: true });
      response = await send(await sessions.cookieHeader());
    }
    sessions.absorb(response.headers);
    if (response.status === 404 && /^\/api\/form\/\d+\/bom$/.test(url.pathname)) return json(200, { data: EMPTY_BOM });
    if (response.status === 404 && url.pathname === "/api/realtime-lookup" && !url.search) return json(200, { enabled: false });
    if (/^\/api\/form\/(submit|draft\/(save|update|submit))/.test(url.pathname)) {
      const text = await response.clone().text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
      }
      gatewayLog.lastWrite = { path: url.pathname, status: response.status, body };
    }
    return response;
  });
}

// src/engine/polyfill.ts
import "./vendor.min.mjs";
var MemoryStorage = class {
  #items = /* @__PURE__ */ new Map();
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key) {
    return this.#items.has(key) ? this.#items.get(key) : null;
  }
  key(index) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key) {
    this.#items.delete(key);
  }
  setItem(key, value) {
    this.#items.set(key, String(value));
  }
};
var installed2 = false;
function installPolyfill(origin) {
  if (installed2) return;
  installed2 = true;
  const noop = () => void 0;
  const originUrl = new URL(`${origin}/`);
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
    toString: () => originUrl.href
  };
  const g = globalThis;
  Object.defineProperty(globalThis, "location", { configurable: true, get: () => location, set: noop });
  g.window = globalThis;
  g.document = {
    location,
    visibilityState: "visible",
    hidden: false,
    addEventListener: noop,
    removeEventListener: noop
  };
  g.localStorage = new MemoryStorage();
  g.sessionStorage = new MemoryStorage();
  g.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
  g.cancelAnimationFrame = (h) => clearTimeout(h);
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: void 0 });
  if (typeof g.addEventListener !== "function") g.addEventListener = noop;
  if (typeof g.removeEventListener !== "function") g.removeEventListener = noop;
}

// src/engine/quote.ts
var TIMEOUT_MS = 45e3;
var EngineError = class extends Error {
};
function waitFor(store, selector, predicate, label, failure) {
  return new Promise((resolve, reject) => {
    let done = false;
    const unsubs = [];
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubs.forEach((u) => u());
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new EngineError(`Timed out waiting for ${label}.`)), TIMEOUT_MS);
    unsubs.push(store.subscribe(selector, (v) => predicate(v) && finish(null, v)));
    if (failure) unsubs.push(store.subscribe(failure, (m) => m && finish(new EngineError(m))));
    const now = selector(store.getState());
    if (predicate(now)) return finish(null, now);
    const failed = failure?.(store.getState());
    if (failed) finish(new EngineError(failed));
  });
}
function captureSdkErrors() {
  const errors = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(
      args.map((a) => a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)).join(" ").slice(0, 500)
    );
  };
  return { errors, restore: () => console.error = original };
}
var isShown = (active) => active !== 0 && active !== false;
var labelOf = (node) => String(node?.label ?? node?.name ?? node?.id ?? "");
var slugOf = (node) => {
  const v = node?.extra_fields?.slug;
  return typeof v === "string" && v ? v : void 0;
};
var QuoteEngine = class {
  #store = null;
  sessions;
  constructor(sessions) {
    this.sessions = sessions;
  }
  get store() {
    if (!this.#store) throw new EngineError("No quote in progress. Call start_quote first.");
    return this.#store;
  }
  get active() {
    return this.#store !== null;
  }
  /** Start a new quote (resets any quote in progress). */
  async start(options = {}) {
    installPolyfill(this.sessions.config.origin);
    installGateway(this.sessions);
    if (this.#store) await this.#reset();
    const [store] = createSDKStore({ formSubstoreConfig: { debugMode: true } });
    this.#store = store;
    const cap = captureSdkErrors();
    try {
      await waitFor(
        store,
        (s) => s.localizationSubstore.selectedCountry,
        Boolean,
        "the Tenant's countries",
        () => cap.errors.find((e) => /401|Unauthorized|logged in/i.test(e)) ? "config-panel answered that this user is not logged in. Call connection_status with again: true to log in again." : void 0
      );
      const loc = store.getState().localizationSubstore;
      if (options.country) {
        loc.setSelectedCountry(options.country.toLowerCase());
        if (store.getState().localizationSubstore.selectedCountry?.slug?.toLowerCase() !== options.country.toLowerCase()) {
          throw new EngineError(`Country "${options.country}" is not one of this Tenant's countries: ${this.countries().join(", ")}.`);
        }
      }
      if (options.language) {
        loc.setSelectedLanguage(options.language.toLowerCase());
        if (store.getState().localizationSubstore.selectedLanguage?.slug !== options.language.toLowerCase()) {
          throw new EngineError(`Language "${options.language}" is not one of this Tenant's languages.`);
        }
      }
    } finally {
      cap.restore();
    }
  }
  countries() {
    const loc = this.store.getState().localizationSubstore;
    const list = loc.availableCountries?.data ?? loc.countries ?? [];
    return (Array.isArray(list) ? list : []).map((c) => c.slug);
  }
  async #reset() {
    const store = this.#store;
    await new Promise((resolve) => {
      const reset = store.getState().resetSubstore;
      reset.setAfterReset(() => resolve());
      reset.reset();
    });
    this.#store = null;
  }
  /** Add a configuration of a Form to the quote; resolves once its rules have run. */
  async addConfiguration(formId, name) {
    const store = this.store;
    const cap = captureSdkErrors();
    try {
      const label = name ?? `Form ${formId}`;
      const configId = store.getState().configsSubstore.addConfig({
        formId,
        name: label,
        formName: label,
        configQuantity: 1
      });
      if (!configId) throw new EngineError(`Form id ${formId} is not valid.`);
      store.getState().configsSubstore.setCurrentConfigId(configId);
      await waitFor(
        store,
        (s) => s.formSubstore.fromConfigs[configId],
        (f) => Boolean(f && !f.isLoading && f.constraintsCheckedFormData && f.form),
        `form ${formId} to load`,
        (s) => s.configsSubstore.configs.some((c) => c.id === configId) ? void 0 : `Form ${formId} did not load: it does not exist on this Tenant, is inactive, or this user may not open it. ${cap.errors.join(" ")}`.trim()
      );
      await this.#bomSettled(configId);
      const form = store.getState().formSubstore.fromConfigs[configId];
      if (form?.form?.name && !name) store.getState().configsSubstore.updateConfig(configId, { name: form.form.name });
      return configId;
    } finally {
      cap.restore();
    }
  }
  removeConfiguration(configId) {
    this.#config(configId);
    this.store.getState().configsSubstore.removeConfig(configId);
  }
  setConfigurationQuantity(configId, quantity) {
    this.#config(configId);
    this.store.getState().configsSubstore.updateConfig(configId, { configQuantity: quantity });
  }
  #config(configId) {
    const config = this.store.getState().configsSubstore.configs.find((c) => c.id === configId);
    if (!config) throw new EngineError(`There is no configuration ${configId} in this quote.`);
    return config;
  }
  configurationIds() {
    return this.store.getState().configsSubstore.configs.map((c) => c.id);
  }
  async #bomSettled(configId) {
    await waitFor(
      this.store,
      (s) => s.bomSubstore.bomConfigs[configId]?.bomConfig,
      (b) => Boolean(b && !b.isLoading),
      "the bill of materials"
    );
  }
  #elements(configId) {
    const data = this.store.getState().formSubstore.fromConfigs[configId]?.constraintsCheckedFormData;
    if (!data) throw new EngineError(`Configuration ${configId} has not loaded.`);
    const out = [];
    for (const el of data.elements ?? []) out.push(el);
    for (const g of data.groups ?? []) for (const el of g.elements ?? []) out.push({ ...el, __group: g });
    return out;
  }
  #findElement(configId, ref) {
    const els = this.#elements(configId);
    const key = String(ref).trim();
    const hit = els.find((e) => String(e.id) === key) ?? els.find((e) => slugOf(e) === key) ?? els.filter((e) => String(e.label ?? "").toLowerCase() === key.toLowerCase());
    if (Array.isArray(hit)) {
      if (hit.length === 1) return hit[0];
      if (hit.length > 1) throw new EngineError(`"${key}" matches ${hit.length} elements (${hit.map((e) => e.id).join(", ")}); use the id.`);
      throw new EngineError(`No element "${key}" in configuration ${configId}. Read the configuration to see the elements and their ids.`);
    }
    return hit;
  }
  #findOption(element, ref) {
    const key = String(ref).trim();
    const opts = element.options ?? [];
    const hit = opts.find((o) => String(o.id) === key) ?? opts.find((o) => slugOf(o) === key || o.attribute_slug === key) ?? opts.filter((o) => labelOf(o).toLowerCase() === key.toLowerCase());
    const found = Array.isArray(hit) ? hit.length === 1 ? hit[0] : void 0 : hit;
    if (!found) {
      throw new EngineError(
        `"${key}" is not an option of "${element.label}" (${element.id}). Options: ${opts.filter((o) => isShown(o.active)).slice(0, 30).map((o) => `${o.id} ${labelOf(o)}`).join("; ")}`
      );
    }
    if (!isShown(found.active)) throw new EngineError(`Option "${labelOf(found)}" of "${element.label}" is hidden by the configurator's rules right now.`);
    return found;
  }
  /** Apply answers, then wait for the rules to run. Returns a list of notes on what changed. */
  async setAnswers(configId, answers) {
    const store = this.store;
    this.#config(configId);
    const current = store.getState().valuesSubstore.valuesConfigs[configId];
    if (!current) throw new EngineError(`Configuration ${configId} has not loaded.`);
    const values = { ...current.values };
    const quantities = structuredClone(current.quantities ?? {});
    const notes = [];
    for (const answer of answers) {
      const el = this.#findElement(configId, answer.element);
      if (!isShown(el.active)) throw new EngineError(`"${el.label}" (${el.id}) is hidden by the configurator's rules right now.`);
      if (el.state === "disabled" || el.state === "readonly") throw new EngineError(`"${el.label}" (${el.id}) is read-only: the configurator sets it.`);
      const id = String(el.id);
      const raw = answer.value;
      if (raw === null || Array.isArray(raw) && raw.length === 0) {
        values[id] = [];
        continue;
      }
      if (["select", "radio", "checkbox"].includes(el.type) || el.options?.length && !["text", "number", "range"].includes(el.type)) {
        const list = Array.isArray(raw) ? raw : [raw];
        if (el.type !== "checkbox" && list.length > 1) throw new EngineError(`"${el.label}" takes one option; got ${list.length}.`);
        values[id] = list.map((r) => String(this.#findOption(el, r).id));
      } else {
        if (Array.isArray(raw)) throw new EngineError(`"${el.label}" takes one value.`);
        if (el.type === "number" || el.type === "range") {
          const n = Number(raw);
          if (!Number.isFinite(n)) throw new EngineError(`"${el.label}" takes a number; got "${raw}".`);
          if (el.min != null && n < Number(el.min)) throw new EngineError(`"${el.label}" is at least ${el.min}.`);
          if (el.max != null && n > Number(el.max)) throw new EngineError(`"${el.label}" is at most ${el.max}.`);
        }
        values[id] = [String(raw)];
      }
      for (const [optRef, qty] of Object.entries(answer.quantities ?? {})) {
        const opt = this.#findOption(el, optRef);
        const ol = labelOf(opt);
        if (!opt.allow_quantity && !(opt.products?.length > 0)) throw new EngineError(`"${ol}" has no quantity.`);
        if (opt.min_quantity != null && qty < opt.min_quantity) throw new EngineError(`"${ol}" quantity is at least ${opt.min_quantity}.`);
        if (opt.max_quantity != null && qty > opt.max_quantity) throw new EngineError(`"${ol}" quantity is at most ${opt.max_quantity}.`);
        quantities[id] = { ...quantities[id] ?? {}, [String(opt.id)]: Math.round(qty) };
      }
    }
    const before = JSON.stringify([current.values, current.quantities]);
    if (before === JSON.stringify([values, quantities])) return ["Nothing changed."];
    const beforeDebug = store.getState().formSubstore.fromConfigs[configId]?.debugHistory?.at(-1)?.id ?? 0;
    const cap = captureSdkErrors();
    try {
      store.getState().valuesSubstore.setValues(configId, values);
      store.getState().valuesSubstore.setQuantities(configId, quantities);
      await waitFor(
        store,
        (s) => s.formSubstore.fromConfigs[configId],
        (f) => Boolean(f && !f.isLoading && f.constraintsCheckedFormData && (f.debugHistory?.at(-1)?.id ?? 0) !== beforeDebug),
        "the configurator's rules"
      );
      await this.#bomSettled(configId);
    } finally {
      cap.restore();
    }
    if (cap.errors.length) notes.push(`The configurator reported: ${cap.errors.slice(0, 3).join(" | ")}`);
    const after = store.getState().valuesSubstore.valuesConfigs[configId];
    for (const a of answers) {
      const el = this.#findElement(configId, a.element);
      const want = values[String(el.id)];
      const got = after?.values?.[String(el.id)] ?? [];
      if (JSON.stringify(want) !== JSON.stringify(got)) notes.push(`The rules changed "${el.label}" to ${JSON.stringify(got)}.`);
    }
    return notes;
  }
  /** A compact view of one configuration for the model. */
  describe(configId, options = {}) {
    const state = this.store.getState();
    const config = this.#config(configId);
    const form = state.formSubstore.fromConfigs[configId];
    const vals = state.valuesSubstore.valuesConfigs[configId] ?? { values: {}, quantities: {} };
    const maxOptions = options.maxOptions ?? 40;
    const nf = state.numberFormatterSubstore;
    const fmt = (n) => {
      try {
        return typeof n === "number" ? nf.getPriceFormatter()?.format(n) ?? String(n) : void 0;
      } catch {
        return String(n);
      }
    };
    const messages = [];
    for (const kind of ["groups", "elements", "options"]) {
      for (const [id, list] of Object.entries(form?.messages?.[kind] ?? {})) {
        for (const m of list) if (m?.message) messages.push({ on: `${kind.slice(0, -1)} ${id}`, type: m.type, message: m.message });
      }
    }
    const describeElement = (el) => {
      const id = String(el.id);
      const selected = vals.values?.[id] ?? [];
      const out = {
        id: Number(el.id),
        label: el.label,
        type: el.type
      };
      const slug = slugOf(el);
      if (slug) out.slug = slug;
      if (el.state === "required") out.required = true;
      if (el.state === "disabled" || el.state === "readonly") out.readonly = true;
      if (!isShown(el.active)) out.hidden = true;
      if (el.sub_text) out.help = String(el.sub_text).replace(/<[^>]+>/g, "").slice(0, 200);
      if (el.options?.length) {
        const visible = el.options.filter((o) => options.includeHidden || isShown(o.active));
        out.value = selected.map((s) => {
          const o = el.options.find((x) => String(x.id) === s);
          const q = vals.quantities?.[id]?.[s];
          return { id: Number(s), label: o ? labelOf(o) : s, ...q != null && q !== 1 ? { quantity: q } : {} };
        });
        out.options = visible.slice(0, maxOptions).map((o) => ({
          id: Number(o.id),
          label: labelOf(o),
          ...slugOf(o) ? { slug: slugOf(o) } : {},
          ...typeof o.price === "number" && o.price !== 0 ? { price: o.price } : {},
          ...o.allow_quantity ? { quantity: [o.min_quantity, o.max_quantity] } : {},
          ...!isShown(o.active) ? { hidden: true } : {}
        }));
        if (visible.length > maxOptions) out.moreOptions = visible.length - maxOptions;
      } else {
        out.value = selected[0] ?? null;
        if (el.min != null) out.min = el.min;
        if (el.max != null) out.max = el.max;
        if (el.step != null) out.step = el.step;
        if (el.format) out.unit = el.format;
      }
      return out;
    };
    const data = form?.constraintsCheckedFormData ?? {};
    const sections = [];
    if (data.elements?.length) {
      sections.push({
        label: "(no group)",
        elements: data.elements.filter((e) => options.includeHidden || isShown(e.active)).map(describeElement)
      });
    }
    for (const g of data.groups ?? []) {
      if (!options.includeHidden && !isShown(g.active)) continue;
      sections.push({
        id: g.id,
        label: g.label,
        ...g.is_repeatable ? { repeatable: true, note: "Repeatable group: lines are not editable through this plugin yet." } : {},
        elements: (g.elements ?? []).filter((e) => options.includeHidden || isShown(e.active)).map(describeElement)
      });
    }
    let total = null;
    let vat = null;
    try {
      total = nf.calculateConfigPrice({ configId, multiplyConfigQuantity: true });
      vat = nf.calculateConfigVat({ configId, multiplyConfigQuantity: true });
    } catch {
    }
    return {
      configurationId: configId,
      form: form?.form ? { id: form.form.id, name: form.form.name } : null,
      quantity: config.configQuantity,
      status: config.status,
      missingRequired: (config.missingRequiredElements ?? []).map((m) => ({ id: Number(m.id), label: m.label })),
      total: total == null ? null : { amount: total, formatted: fmt(total), vatIncluded: vat, vatFormatted: fmt(vat) },
      currency: state.localizationSubstore.selectedCountry?.currency?.code,
      messages,
      sections
    };
  }
  quoteOverview() {
    const state = this.store.getState();
    const configs = state.configsSubstore.configs.map((c) => {
      let total = null;
      try {
        total = state.numberFormatterSubstore.calculateConfigPrice({ configId: c.id, multiplyConfigQuantity: true });
      } catch {
      }
      return {
        configurationId: c.id,
        name: c.name,
        formId: c.formId,
        quantity: c.configQuantity,
        status: c.status,
        missingRequired: (c.missingRequiredElements ?? []).map((m) => m.label),
        total
      };
    });
    const loc = state.localizationSubstore;
    return {
      country: loc.selectedCountry?.slug,
      language: loc.selectedLanguage?.slug,
      currency: loc.selectedCountry?.currency?.code,
      draftId: state.submitSubstore.draftId ?? null,
      configurations: configs,
      total: configs.reduce((s, c) => s + (c.total ?? 0), 0),
      pricesIncludeVat: true
    };
  }
  /** The quote step's request fields (customer, project, ...) with their current values. */
  async requestFields() {
    const store = this.store;
    await waitFor(
      store,
      (s) => s.contactDetailsSubstore.requestFieldsData,
      (d) => Boolean(d && !d.isLoading),
      "request fields"
    );
    const cd = store.getState().contactDetailsSubstore;
    const fields = cd.requestFieldsData?.data ?? [];
    return {
      name: cd.fixedContactDetails.find((d) => d.id === "name")?.value ?? "",
      email: cd.fixedContactDetails.find((d) => d.id === "email")?.value ?? "",
      groups: fields.map((g) => ({
        id: g.id,
        name: g.name,
        fields: (g.fields ?? []).filter((f) => f.mode !== "hidden").map((f) => ({
          id: f.id,
          slug: f.slug,
          name: f.name,
          type: f.type,
          required: Boolean(f.required),
          ...f.options ? { options: f.options } : {},
          value: cd.requestFieldsValues?.[g.id]?.[f.id] ?? cd.requestFieldsValues?.[String(g.id)]?.[String(f.id)] ?? ""
        }))
      })),
      errors: cd.requestFieldsErrors
    };
  }
  async setContactDetails(input) {
    const store = this.store;
    const cd = () => store.getState().contactDetailsSubstore;
    if (input.name != null) cd().setFixedContactDetailsValue({ id: "name", value: input.name });
    if (input.email != null) cd().setFixedContactDetailsValue({ id: "email", value: input.email });
    if (input.fields && Object.keys(input.fields).length) {
      const groups = (await this.requestFields()).groups;
      for (const [key, value] of Object.entries(input.fields)) {
        const hits = groups.flatMap(
          (g) => g.fields.filter((f) => f.slug === key || String(f.id) === key || String(f.name).toLowerCase() === key.toLowerCase()).map((f) => ({ g, f }))
        );
        if (hits.length !== 1) throw new EngineError(hits.length ? `"${key}" matches several request fields; use "<group id>.<field id>".` : `No request field "${key}".`);
        cd().setSubFieldValue({ requestFieldId: hits[0].g.id, requestSubFieldId: hits[0].f.id, value: String(value) });
      }
    }
    return this.requestFields();
  }
  async saveDraft(name) {
    const store = this.store;
    const sub = () => store.getState().submitSubstore;
    sub().setDraftName(name);
    const cap = captureSdkErrors();
    try {
      const r = await sub().saveOrUpdateDraft();
      if (!r?.ok) throw new EngineError(`config-panel did not save the draft. ${sub().errorDraft ?? cap.errors.join(" ")}`.trim());
      return { draftId: sub().draftId ?? null, type: r.type };
    } finally {
      cap.restore();
    }
  }
  async openDraft(draftId) {
    const store = this.store;
    const cap = captureSdkErrors();
    try {
      const r = await store.getState().submitSubstore.openFromDraft(draftId);
      if (!r?.ok) throw new EngineError(`Could not open draft ${draftId}. ${cap.errors.join(" ")}`.trim());
      const ids = this.configurationIds();
      for (const id of ids) {
        await waitFor(
          store,
          (s) => s.formSubstore.fromConfigs[id],
          (f) => Boolean(f && !f.isLoading && f.constraintsCheckedFormData),
          `configuration ${id}`
        );
      }
      return ids;
    } finally {
      cap.restore();
    }
  }
  async openCopyOfQuote(requestId) {
    const store = this.store;
    const cap = captureSdkErrors();
    try {
      const r = await store.getState().submitSubstore.openFromRequestCopy(requestId);
      if (!r?.ok) throw new EngineError(`Could not open a copy of quote ${requestId}. ${cap.errors.join(" ")}`.trim());
      return this.configurationIds();
    } finally {
      cap.restore();
    }
  }
  /** Submit the quote. The backend re-checks rules and computes the stored total. */
  async submit() {
    const store = this.store;
    const sub = () => store.getState().submitSubstore;
    await waitFor(store, (s) => s.submitSubstore.isSubmitEnabled, Boolean, "the quote to be ready to submit").catch(() => {
      const fields = store.getState().contactDetailsSubstore;
      const missing = [
        ...fields.fixedContactDetails.filter((d) => d.error).map((d) => `${d.id} (${d.error})`),
        ...Object.keys(fields.requestFieldsErrors ?? {}).length ? ["request fields: " + JSON.stringify(fields.requestFieldsErrors)] : []
      ];
      throw new EngineError(`The quote is not ready to submit. ${missing.join("; ")}`);
    });
    gatewayLog.lastWrite = void 0;
    const cap = captureSdkErrors();
    try {
      const r = await sub().submit();
      const answer = gatewayLog.lastWrite;
      if (!r?.ok) {
        const reason = sub().errorSubmit ?? (answer ? JSON.stringify(answer.body).slice(0, 800) : cap.errors.join(" "));
        throw new EngineError(`config-panel refused the quote${answer ? ` (HTTP ${answer.status})` : ""}: ${reason}`);
      }
      const body = answer?.body ?? {};
      return {
        requestId: body.request_id ?? body.id ?? body.data?.id ?? body.request?.id ?? null,
        pdfUrl: r.pdfUrl ?? null,
        documents: (r.documents ?? []).map((d) => ({ filename: d.filename, url: d.url })),
        documentUrls: r.documentUrls ?? []
      };
    } finally {
      cap.restore();
    }
  }
};

// src/session.ts
var USER_AGENT = "config-panel-claude-plugin/0.1";
var ApiError = class extends Error {
  status;
  body;
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
};
var LoginError = class extends Error {
};
function getSetCookies(headers) {
  const h = headers;
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? single.split(/,(?=\s*[^;,=]+=[^;,]+)/g).map((s) => s.trim()) : [];
}
function applySetCookies(cookies, headers) {
  for (const item of getSetCookies(headers)) {
    const first = item.split(";", 1)[0];
    const idx = first.indexOf("=");
    if (idx > 0) cookies[first.slice(0, idx)] = first.slice(idx + 1);
  }
}
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}
var scrapeLoginCsrf = (html) => html.match(/name=["']_token["'][^>]*value=["']([^"']+)["']/i)?.[1] ?? null;
var scrapeMetaCsrf = (html) => html.match(/name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? null;
var detectLoginField = (html) => /name=["']username["']/i.test(html) ? "username" : /name=["']email["']/i.test(html) ? "email" : "username";
var isLoginRedirect = (r) => r.status >= 300 && r.status < 400 && /\/login(?:\?|$)/.test(r.headers.get("location") ?? "");
function parseMaybeJson(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
var SessionManager = class {
  #session = null;
  #loginInFlight = null;
  config;
  constructor(config) {
    this.config = config;
  }
  get loggedIn() {
    return this.#session !== null;
  }
  get loggedInAt() {
    return this.#session?.loggedInAt;
  }
  /** The current session, logging in when there is none (or when forced). */
  async ensure(options = {}) {
    if (!options.force && this.#session) return this.#session;
    if (options.force) this.#session = null;
    this.#loginInFlight ??= this.#login().finally(() => {
      this.#loginInFlight = null;
    });
    this.#session = await this.#loginInFlight;
    return this.#session;
  }
  logout() {
    this.#session = null;
  }
  /** Cookie header for the headless storefront SDK. */
  async cookieHeader() {
    return cookieHeader((await this.ensure()).cookies);
  }
  /** Absorb cookies set on a response made with this session (session rotation). */
  absorb(headers) {
    if (this.#session) applySetCookies(this.#session.cookies, headers);
  }
  async request(method, pathname, options = {}) {
    let session = await this.ensure();
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": USER_AGENT,
        Cookie: cookieHeader(session.cookies),
        "X-CSRF-TOKEN": session.csrf,
        ...options.headers
      };
      let body;
      if (options.json !== void 0) {
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
  async json(method, pathname, options = {}) {
    const r = await this.request(method, pathname, options);
    if (r.status < 200 || r.status >= 300) {
      throw new ApiError(describeFailure(method, pathname, r.status, r.data), r.status, r.data);
    }
    return r.data;
  }
  // ---- internals ----
  async #probe(s) {
    const cookies = { ...s.cookies };
    const r = await fetch(new URL("/dashboard/dashboard", s.origin), {
      headers: { Cookie: cookieHeader(cookies), "User-Agent": USER_AGENT },
      redirect: "manual"
    });
    if (!r.ok || isLoginRedirect(r)) return null;
    applySetCookies(cookies, r.headers);
    const csrf = scrapeMetaCsrf(await r.text());
    return csrf ? { ...s, cookies, csrf } : null;
  }
  async #login() {
    const { origin, username, password } = this.config;
    const cookies = {};
    const loginUrl = new URL("/dashboard/login", origin);
    let page;
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
        `${origin} shows no config-panel login form. Check the address; if your company logs in with single sign-on only, this plugin cannot log in yet. ${HOW_TO_LOG_IN}`
      );
    }
    const form = new URLSearchParams();
    form.set("_token", token);
    form.set(detectLoginField(html), username);
    form.set("password", password);
    const post = await fetch(loginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-TOKEN": token,
        Cookie: cookieHeader(cookies),
        "User-Agent": USER_AGENT
      },
      body: form,
      redirect: "manual"
    });
    applySetCookies(cookies, post.headers);
    if (post.status === 429) throw new LoginError("config-panel refused the login: too many attempts. Wait a minute, then try again.");
    if (![200, 204, 302, 303].includes(post.status) || isLoginRedirect(post)) {
      throw new LoginError(`config-panel refused the login for "${username}": the username or password is wrong, or the user is inactive. ${HOW_TO_LOG_IN}`);
    }
    const probed = await this.#probe({ origin, csrf: token, cookies, loggedInAt: (/* @__PURE__ */ new Date()).toISOString() });
    if (!probed) throw new LoginError(`Logged in as "${username}", but config-panel did not open the dashboard for this user.`);
    return probed;
  }
};
function describeFailure(method, pathname, status, data) {
  const detail = data && typeof data === "object" ? JSON.stringify(data.errors ?? data.message ?? data).slice(0, 600) : String(data ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
  const hint = {
    401: "Not logged in, or the session ended.",
    403: "This user's level does not allow it.",
    404: "Not found (or not on this config-panel).",
    419: "The CSRF token expired.",
    422: "config-panel refused the data.",
    500: "config-panel failed on the server."
  };
  return `${method} ${pathname} \u2192 HTTP ${status}. ${hint[status] ?? ""} ${detail}`.trim();
}

// src/tools.ts
import { z } from "./vendor.min.mjs";
var ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }] });
var fail = (error) => ({
  isError: true,
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
});
function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (error) {
      return fail(error);
    }
  };
}
var READ = { readOnlyHint: true, openWorldHint: true };
var LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
var WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
var answerSchema = z.object({
  element: z.union([z.string(), z.number()]).describe("Element id, Slug, or exact label"),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])), z.null()]).describe("Option id/Slug/label (a list for a checkbox), or the number/text to enter; null clears it"),
  quantities: z.record(z.string(), z.number()).optional().describe("Option id/label \u2192 quantity, for options with a quantity")
});
var editSchema = z.object({
  target: z.enum(["group", "element", "option"]),
  id: z.number().int(),
  label: z.string().optional(),
  helpText: z.string().nullable().optional().describe("Text under the label; a group's description"),
  active: z.boolean().optional().describe("false hides it from shoppers"),
  state: z.enum(["required", "open"]).optional().describe("Elements: required or optional"),
  order: z.number().int().optional(),
  placeholder: z.string().nullable().optional(),
  min: z.number().int().nullable().optional(),
  max: z.number().int().nullable().optional(),
  step: z.number().nullable().optional(),
  defaultValue: z.union([z.string(), z.number()]).nullable().optional().describe("Elements: default; for select/radio an option id"),
  isDefault: z.boolean().optional().describe("Checkbox options: selected by default"),
  minQuantity: z.number().int().nullable().optional(),
  maxQuantity: z.number().int().nullable().optional(),
  price: z.object({ countryId: z.number().int(), amount: z.number() }).optional().describe("Option sales price in one country, major units, VAT included. Country ids are in get_form_outline."),
  translation: z.record(z.string(), z.string()).optional().describe('Keys like "da_label", "de_sub_text"')
});
function registerTools(server, { sessions, quote, admin }) {
  const configId = (id) => {
    if (id != null) return id;
    const ids = quote.configurationIds();
    if (!ids.length) throw new Error("This quote has no configuration yet. Call add_configuration.");
    return ids[ids.length - 1];
  };
  server.registerTool(
    "connection_status",
    {
      title: "Log in and show the connection",
      description: "Log in to config-panel with the login from the plugin's settings (the password is in the computer's secure storage) and show which config-panel, which user and level, and whether edits are on. Call this first in every conversation. If it fails, show the user its message: the login is fixed in /plugin \u2192 Mercura config-panel \u2192 Configure, never in the chat.",
      inputSchema: { again: z.boolean().optional().describe("Log in again even if already logged in") },
      annotations: READ
    },
    wrap(async ({ again }) => {
      await sessions.ensure({ force: again === true });
      const user = await admin.currentUser();
      return {
        loggedIn: true,
        tenant: sessions.config.origin,
        user,
        loggedInAt: sessions.loggedInAt,
        editsAllowed: sessions.config.allowEdits,
        quoteInProgress: quote.active ? quote.quoteOverview() : null
      };
    })
  );
  server.registerTool(
    "list_configurators",
    {
      title: "List configurators",
      description: "The configurators (Forms) this user can open, with ids.",
      inputSchema: { page: z.number().int().min(1).optional() },
      annotations: READ
    },
    wrap(async ({ page }) => {
      const r = await sessions.json("GET", `/api/forms?size=100&page=${page ?? 1}`);
      const rows = Array.isArray(r) ? r : r?.data ?? [];
      return {
        page: r?.current_page ?? 1,
        lastPage: r?.last_page ?? 1,
        configurators: rows.map((f) => ({ id: f.id, name: f.name, active: f.active !== 0 && f.active !== false, description: f.description ?? void 0 }))
      };
    })
  );
  server.registerTool(
    "start_quote",
    {
      title: "Start a quote",
      description: "Start a new quote (discards any quote in progress that was not saved as a draft). Optionally choose the country (prices and currency follow it) and language by slug, e.g. dk, de, en.",
      inputSchema: { country: z.string().optional(), language: z.string().optional() },
      annotations: LOCAL
    },
    wrap(async ({ country, language }) => {
      await quote.start({ country, language });
      return { started: true, ...quote.quoteOverview() };
    })
  );
  server.registerTool(
    "add_configuration",
    {
      title: "Add a configuration",
      description: "Open a configurator in the current quote. Returns its questions (elements), the options shoppers can pick now, the running total and what is still required. Starts a quote first if none is in progress.",
      inputSchema: { formId: z.number().int(), name: z.string().optional().describe("A name for this line, e.g. 'Kitchen wall'") },
      annotations: LOCAL
    },
    wrap(async ({ formId, name }) => {
      if (!quote.active) await quote.start();
      const id = await quote.addConfiguration(formId, name);
      return quote.describe(id);
    })
  );
  server.registerTool(
    "get_configuration",
    {
      title: "Read a configuration",
      description: "The current state of one configuration: questions, chosen values, options available now, messages from the configurator, total price and missing required answers.",
      inputSchema: {
        configurationId: z.number().int().optional().describe("Defaults to the last one added"),
        includeHidden: z.boolean().optional().describe("Also list what the configurator's rules hide right now"),
        maxOptions: z.number().int().min(1).max(500).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    wrap(
      async (a) => quote.describe(configId(a.configurationId), { includeHidden: a.includeHidden, maxOptions: a.maxOptions })
    )
  );
  server.registerTool(
    "set_answers",
    {
      title: "Answer questions",
      description: "Set one or more answers in a configuration, exactly as a shopper would. The configurator's rules then run (they may show, hide, set or price other things). Returns notes on what the rules changed and the new state.",
      inputSchema: { configurationId: z.number().int().optional(), answers: z.array(answerSchema).min(1) },
      annotations: LOCAL
    },
    wrap(async (a) => {
      const id = configId(a.configurationId);
      const notes = await quote.setAnswers(id, a.answers);
      return { notes, ...quote.describe(id) };
    })
  );
  server.registerTool(
    "set_configuration_quantity",
    {
      title: "Set how many",
      description: "How many of this configuration the quote includes (the line quantity).",
      inputSchema: { configurationId: z.number().int(), quantity: z.number().int().min(1) },
      annotations: LOCAL
    },
    wrap(async (a) => {
      quote.setConfigurationQuantity(a.configurationId, a.quantity);
      return quote.quoteOverview();
    })
  );
  server.registerTool(
    "remove_configuration",
    {
      title: "Remove a configuration",
      description: "Take a configuration out of the quote in progress.",
      inputSchema: { configurationId: z.number().int() },
      annotations: LOCAL
    },
    wrap(async (a) => {
      quote.removeConfiguration(a.configurationId);
      return quote.quoteOverview();
    })
  );
  server.registerTool(
    "get_quote_overview",
    {
      title: "Quote overview",
      description: "Every configuration in the quote in progress with its total, and the quote total (prices include VAT).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    wrap(async () => quote.quoteOverview())
  );
  server.registerTool(
    "get_request_fields",
    {
      title: "Quote details to fill in",
      description: "The customer name, e-mail and the Tenant's request fields (company, project, ...) the quote asks for, with current values.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async () => quote.requestFields())
  );
  server.registerTool(
    "set_contact_details",
    {
      title: "Fill in quote details",
      description: "Set the customer's name and e-mail and request fields (by Slug, id or name) for the quote in progress.",
      inputSchema: {
        name: z.string().optional(),
        email: z.string().optional(),
        fields: z.record(z.string(), z.string()).optional()
      },
      annotations: LOCAL
    },
    wrap(async (a) => quote.setContactDetails(a))
  );
  server.registerTool(
    "save_draft",
    {
      title: "Save as draft",
      description: "Save the quote in progress as a draft in config-panel (needs a login). Saving again updates the same draft.",
      inputSchema: { name: z.string().min(1) },
      annotations: WRITE
    },
    wrap(async (a) => quote.saveDraft(a.name))
  );
  server.registerTool(
    "open_draft",
    {
      title: "Open a draft",
      description: "Load a saved draft into a new quote in progress, with today's prices.",
      inputSchema: { draftId: z.number().int() },
      annotations: LOCAL
    },
    wrap(async (a) => {
      await quote.start();
      const ids = await quote.openDraft(a.draftId);
      return { configurationIds: ids, ...quote.quoteOverview() };
    })
  );
  server.registerTool(
    "copy_quote",
    {
      title: "Copy a quote",
      description: "Start a new quote in progress from a copy of a submitted quote (prices are recalculated).",
      inputSchema: { requestId: z.number().int() },
      annotations: LOCAL
    },
    wrap(async (a) => {
      await quote.start();
      const ids = await quote.openCopyOfQuote(a.requestId);
      return { configurationIds: ids, ...quote.quoteOverview() };
    })
  );
  server.registerTool(
    "submit_quote",
    {
      title: "Submit the quote",
      description: "Submit the quote in progress to config-panel. This creates the quote for real: config-panel stores it, renders its documents and may e-mail the customer and notify connected systems. Only call it after showing the user the overview and contact details and getting an explicit yes; pass confirmed: true.",
      inputSchema: { confirmed: z.literal(true).describe("The user explicitly confirmed submitting this quote") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    wrap(async () => {
      const overview = quote.quoteOverview();
      const missing = overview.configurations.filter((c) => c.missingRequired.length);
      if (missing.length) {
        throw new Error(`Required answers are missing: ${missing.map((c) => `${c.name}: ${c.missingRequired.join(", ")}`).join("; ")}`);
      }
      const result = await quote.submit();
      return { submitted: true, ...result, total: overview.total, currency: overview.currency };
    })
  );
  server.registerTool(
    "list_quotes",
    {
      title: "List quotes",
      description: "Submitted quotes, newest first (customers see their own; sellers and admins see the Tenant's).",
      inputSchema: { page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(100).optional() },
      annotations: READ
    },
    wrap(async (a) => {
      const r = await sessions.json("GET", `/api/requests?size=${a.size ?? 25}&page=${a.page ?? 1}&direction=desc`);
      const rows = Array.isArray(r) ? r : r?.data ?? [];
      return {
        page: r?.current_page ?? a.page ?? 1,
        lastPage: r?.last_page,
        total: r?.total,
        quotes: rows.map((q) => ({
          id: q.id,
          name: q.name,
          email: q.email,
          status: q.status,
          total: q.conf_total,
          vat: q.vat_total,
          createdAt: q.created_at,
          configuration: q.configuration_name ?? q.configuration?.name
        }))
      };
    })
  );
  server.registerTool(
    "get_quote",
    {
      title: "Read a quote",
      description: "One submitted quote: customer, request fields, totals (VAT included) and every configured line with its answers.",
      inputSchema: { requestId: z.number().int() },
      annotations: READ
    },
    wrap(async (a) => {
      const r = await sessions.json("GET", `/api/request/${a.requestId}/full`);
      return summarizeRequest(r?.data ?? r);
    })
  );
  server.registerTool(
    "get_draft",
    {
      title: "Read a draft",
      description: "One saved draft with its configurations (raw, as config-panel stores it). Use open_draft to continue working on it.",
      inputSchema: { draftId: z.number().int() },
      annotations: READ
    },
    wrap(async (a) => sessions.json("GET", `/api/form/draft/${a.draftId}`))
  );
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "Products of the catalogue (SKU, name, prices, properties). Needs a seller or admin login.",
      inputSchema: { page: z.number().int().min(1).optional(), search: z.string().optional().describe("Filters by SKU or name on this page") },
      annotations: READ
    },
    wrap(async (a) => {
      const r = await sessions.json("GET", `/dashboard/api/products?per_page=50&page=${a.page ?? 1}`);
      let rows = Array.isArray(r) ? r : r?.data ?? [];
      if (a.search) {
        const q = a.search.toLowerCase();
        rows = rows.filter((p) => String(p.sku ?? "").toLowerCase().includes(q) || String(p.name ?? "").toLowerCase().includes(q));
      }
      return {
        page: r?.current_page ?? a.page ?? 1,
        lastPage: r?.last_page,
        products: rows.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          active: p.active,
          prices: (p.prices ?? []).map((x) => ({ type: x.type, countryId: x.country_id, price: x.price }))
        }))
      };
    })
  );
  server.registerTool(
    "get_localizations",
    {
      title: "Countries and languages",
      description: "The countries (with currency) and languages this config-panel offers. Prices include VAT and differ per country.",
      inputSchema: {},
      annotations: READ
    },
    wrap(async () => {
      const [countries, languages] = await Promise.all([
        sessions.json("GET", "/api/localization/countries"),
        sessions.json("GET", "/api/localization/languages")
      ]);
      return {
        countries: (Array.isArray(countries) ? countries : countries?.data ?? []).map((c) => ({ id: c.id, slug: c.slug, name: c.name, currency: c.currency?.code })),
        languages: (Array.isArray(languages) ? languages : languages?.data ?? []).map((l) => ({ id: l.id, slug: l.slug, name: l.name }))
      };
    })
  );
  server.registerTool(
    "get_form_outline",
    {
      title: "Configurator structure (admin)",
      description: "Admins: the full structure of a configurator as stored, including hidden nodes, Slugs and option prices per country. Use it to find ids before an edit.",
      inputSchema: { formId: z.number().int() },
      annotations: READ
    },
    wrap(async (a) => admin.outline(a.formId))
  );
  server.registerTool(
    "list_rules",
    {
      title: "Configurator rules (admin)",
      description: "Admins: a configurator's rules in run order: name, on/off, categories and what each effect acts on.",
      inputSchema: { formId: z.number().int() },
      annotations: READ
    },
    wrap(async (a) => admin.listRules(a.formId))
  );
  server.registerTool(
    "get_rule",
    {
      title: "One rule (admin)",
      description: "Admins: one rule with its condition tree and effects, as config-panel stores it.",
      inputSchema: { formId: z.number().int(), ruleId: z.number().int() },
      annotations: READ
    },
    wrap(async (a) => admin.getRule(a.formId, a.ruleId))
  );
  if (!sessions.config.allowEdits) return;
  server.registerTool(
    "preview_form_edit",
    {
      title: "Preview a configurator edit (admin)",
      description: "Admins: plan changes to existing groups, elements and options (labels, help text, visible, required, limits, defaults, quantities, option prices, translations). Saves nothing: returns the exact changes and a confirmation token. Show the changes to the user; apply only after they say yes.",
      inputSchema: {
        formId: z.number().int(),
        edits: z.array(editSchema).min(1).max(50),
        reason: z.string().min(5).describe("Why, in the user's words")
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async (a) => admin.previewEdits(a.formId, a.edits, a.reason))
  );
  server.registerTool(
    "preview_rule_switch",
    {
      title: "Preview switching a rule on or off (admin)",
      description: "Admins: plan switching one rule on or off. Saves nothing; returns a confirmation token.",
      inputSchema: { formId: z.number().int(), ruleId: z.number().int(), active: z.boolean(), reason: z.string().min(5) },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(
      async (a) => admin.previewRuleActive(a.formId, a.ruleId, a.active, a.reason)
    )
  );
  server.registerTool(
    "list_form_backups",
    {
      title: "Configurator backups (admin)",
      description: "Backups this plugin took on this computer before each saved edit of a configurator, newest first.",
      inputSchema: { formId: z.number().int() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    wrap(async (a) => ({ formId: a.formId, folder: admin.backupDir(a.formId), backups: admin.listBackups(a.formId) }))
  );
  server.registerTool(
    "preview_restore_form",
    {
      title: "Preview restoring a backup (admin)",
      description: "Admins: plan putting a configurator's structure back to a backup. Saves nothing; returns the differences and a confirmation token.",
      inputSchema: { formId: z.number().int(), backupId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async (a) => admin.previewRestore(a.formId, a.backupId))
  );
  server.registerTool(
    "apply_form_change",
    {
      title: "Apply a previewed change (admin)",
      description: "Admins: save a change previewed with preview_form_edit, preview_rule_switch or preview_restore_form. It changes the live configurator for every shopper. Call only after the user explicitly confirmed that preview. Backs the configurator up first and checks the result.",
      inputSchema: { confirmationToken: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    wrap(async (a) => admin.apply(a.confirmationToken))
  );
}
function summarizeRequest(d) {
  const req = d?.request ?? d;
  return {
    id: req?.id,
    name: req?.name,
    email: req?.email,
    status: req?.status,
    total: req?.conf_total,
    vatIncluded: req?.vat_total,
    createdAt: req?.created_at,
    requestFields: (req?.extra_fields ?? []).map((g) => ({
      group: g.name,
      fields: Object.fromEntries((g.fields ?? []).map((f) => [f.slug ?? f.name, f.value]))
    })),
    configuration: d?.configuration ? { id: d.configuration.id, name: d.configuration.name } : void 0,
    lines: (d?.form_submissions ?? []).map((s) => ({
      form: s.form?.name ?? s.form_id,
      quantity: s.quantity,
      price: s.price ?? s.total,
      answers: (s.form?.data?.elements ?? s.data?.elements ?? []).map((e) => ({
        element: e.label ?? e.slug,
        value: e.options?.length ? e.options.map((o) => o.quantity && o.quantity !== 1 ? `${o.label} \xD7${o.quantity}` : o.label) : e.value
      }))
    }))
  };
}

// src/index.ts
var VERSION = true ? "0.1.1" : "dev";
var INSTRUCTIONS = `Tools for one Mercura config-panel (CPQ) installation: configure products, price them, and create quotes, look up quotes and the catalogue, and (for admins, when edits are switched on) change configurators.
- First, before anything else: call connection_status. It logs in with the user's saved login. If it fails, show its message and stop until the user has fixed the login in /plugin \u2192 Mercura config-panel \u2192 Configure.
- Never ask for, accept or repeat a username or password in the conversation. If the user pastes a password, do not use it; tell them to enter it in the plugin's settings instead and to consider changing it.
- A quote is built in a headless copy of the storefront: the configurator's own rules run, so visibility, required answers and prices are exactly what a shopper sees. Prices include VAT.
- Never submit a quote, save a configurator edit or restore a backup without showing the user what will happen and getting an explicit yes.`;
async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    const server2 = new McpServer({ name: "config-panel", version: VERSION }, { instructions: INSTRUCTIONS });
    server2.registerTool(
      "connection_status",
      {
        title: "Log in",
        description: "The plugin is not logged in to config-panel yet. Call this and show the user how to log in.",
        inputSchema: {}
      },
      async () => ({ isError: true, content: [{ type: "text", text: error.message }] })
    );
    await server2.connect(new StdioServerTransport());
    return;
  }
  const sessions = new SessionManager(config);
  const quote = new QuoteEngine(sessions);
  const admin = new AdminService(sessions);
  const server = new McpServer({ name: "config-panel", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, { sessions, quote, admin });
  console.log = (...args) => console.warn(...args);
  await server.connect(new StdioServerTransport());
}
main().catch((error) => {
  console.warn(error);
  process.exit(1);
});
