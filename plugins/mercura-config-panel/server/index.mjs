#!/usr/bin/env node
// Mercura config-panel Claude plugin 0.2.1 (2026-11-26). The plugin's own code; its source is server/src/ in this repository. Third-party code is in vendor.min.mjs.

// src/index.ts
import { McpServer } from "./vendor.min.mjs";
import { StdioServerTransport } from "./vendor.min.mjs";

// src/admin/admin.ts
import crypto from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
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
        'Edits are switched off for this login. To allow them, call connection_status with newLogin: true and give the user the link; they log in again with "Allow Claude to edit configurators" ticked.'
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
  // ---- create a new configurator (added in 1.1.0) ----
  async #newFormId(name, response) {
    const fromBuilder = createdIdFrom("form-builder", response) ?? createdIdFrom("form", response);
    if (fromBuilder) return fromBuilder;
    const d = response.data;
    if (d && typeof d === "object") {
      const id = d.id ?? d.data?.id ?? d.entry?.id;
      if (id) return Number(id);
    }
    const r = await this.sessions.json("GET", `/api/forms?size=100&page=1`).catch(() => null);
    const rows = (Array.isArray(r) ? r : r?.data ?? []).filter((f) => f.name === name).sort((a, b) => b.id - a.id);
    if (rows[0]) return Number(rows[0].id);
    throw new Error(`config-panel did not say which id the new configurator "${name}" got (HTTP ${response.status}). Check the configurator list before trying again, so you do not create it twice.`);
  }
  #buildStructure(spec, countries) {
    let next = 0;
    const nid = () => --next;
    const allCountryIds = countries.map((c) => c.id);
    const countryId = (key) => {
      const c = countries.find((x) => String(x.id) === String(key) || x.slug?.toLowerCase() === String(key).toLowerCase() || x.name?.toLowerCase() === String(key).toLowerCase());
      if (!c) throw new Error(`Unknown country "${key}". Known: ${countries.map((x) => x.slug).join(", ")}`);
      return c.id;
    };
    const priceRows = (prices) => {
      const entries = prices && Object.keys(prices).length ? Object.entries(prices).map(([k, v]) => [countryId(k), Number(v)]) : allCountryIds.map((id) => [id, 0]);
      if (!entries.length) throw new Error("This config-panel has no countries, so options cannot get a price row.");
      return entries.map(([country_id, price]) => ({ id: null, country_id, price, vat_id: null, type: "sales" }));
    };
    const option = (o, i) => ({
      id: nid(), label: o.label, active: true, order: i, is_default: Boolean(o.isDefault),
      sub_text: o.helpText ?? null, translation: null, image: null, model_3d: null, extra_fields: null,
      allow_quantity: Boolean(o.quantity), allow_dynamic_pricing: false,
      min_quantity: o.quantity ? o.quantity.min : null, max_quantity: o.quantity ? o.quantity.max : null,
      products: (o.productIds ?? []).map((id) => ({ id })),
      prices: o.productIds?.length && !o.prices ? [] : priceRows(o.prices)
    });
    const element = (e, i) => {
      const numeric = e.type === "number" || e.type === "range";
      if (numeric && (e.min == null || e.max == null)) throw new Error(`Question "${e.label}" is a ${e.type}; give it min and max.`);
      if (["radio", "select", "checkbox"].includes(e.type) && !(e.options ?? []).length) throw new Error(`Question "${e.label}" is a ${e.type} but has no options.`);
      return {
        id: nid(), label: e.label, type: e.type, state: e.required ? "required" : "open", active: true, order: i,
        placeholder: e.placeholder ?? null, image: null, model_3d: null,
        min: e.min ?? null, max: e.max ?? null, step: numeric ? String(e.step ?? 1) : null,
        format: null, default_value: e.defaultValue ?? null, sub_text: e.helpText ?? null, translation: null,
        price_type: ["radio", "select", "checkbox"].includes(e.type) ? "addition" : "none",
        dynamic_product_operator: null, multiplier: null, extra_fields: null, product_property_id: null,
        options: (e.options ?? []).map(option)
      };
    };
    const groups = spec.map((g, i) => ({
      id: nid(), label: g.label, active: true, order: i, type: "default", translation: null, image: null,
      description: g.description ?? null, data: null, extra_fields: null, is_repeatable: false, min_instances: 0, max_instances: null,
      elements: g.questions.map(element)
    }));
    // The same shape config-panel's own save takes for existing nodes (is_repeatable, min_instances, images, ...).
    const postable = groups.map((g) => {
      const pg = toPostableGroup(g);
      pg.elements.forEach((e, k) => {
        if (e.form_group_id != null && e.form_group_id < 0) delete e.form_group_id;
        const src = g.elements[k];
        e.step = src.step;
        e.options.forEach((o, j) => { o.prices = src.options[j].prices; });
      });
      return pg;
    });
    return { groups: postable, elements: [] };
  }
  async previewCreateForm(name, description, groupsSpec, active) {
    this.requireEditsEnabled();
    await this.requireAdmin();
    const countries = await this.countries();
    const data = this.#buildStructure(groupsSpec, countries);
    const qs = data.groups.reduce((n, g) => n + g.elements.length, 0);
    const os = data.groups.reduce((n, g) => n + g.elements.reduce((m, e) => m + e.options.length, 0), 0);
    const summary = [
      `New configurator "${name}"${active ? "" : " (inactive: shoppers do not see it until it is switched on)"}`,
      ...data.groups.map((g) => `Step "${g.label}": ${g.elements.map((e) => `${e.label} (${e.type}${e.state === "required" ? ", required" : ""}${e.options.length ? `, ${e.options.length} options` : ""})`).join("; ")}`),
      `In total ${data.groups.length} steps, ${qs} questions, ${os} options.`
    ];
    const pending = this.#remember({
      kind: "create",
      formId: null,
      summary,
      trial: { newForm: { name }, structure: data },
      run: async () => {
        const s = await this.sessions.ensure();
        const fd = new FormData();
        fd.set("_token", s.csrf);
        fd.set("name", name);
        fd.set("active", active ? "1" : "0");
        fd.set("order", "0");
        fd.set("price_calculation_strategy", "Standard");
        fd.set("_save_action", "save_and_edit");
        if (description) fd.set("description", description);
        const created = await this.sessions.request("POST", "/dashboard/form", { multipart: fd, headers: { Accept: "text/html,application/json" } });
        if (created.status >= 400) throw new ApiError(describeFailure("POST", "/dashboard/form", created.status, created.data), created.status, created.data);
        const formId = await this.#newFormId(name, created);
        try {
          await this.sessions.json("POST", `/dashboard/api/form/${formId}`, { json: { id: formId, data } });
        } catch (error) {
          throw new Error(`The configurator "${name}" was created with id ${formId}, but saving its steps failed: ${error.message}. It is empty now; fix the structure and use add_configurator_steps on form ${formId} instead of creating it again.`);
        }
        const after = await this.adminForm(formId);
        const gotGroups = (after.groups ?? []).length;
        const gotQs = (after.groups ?? []).reduce((n, g) => n + (g.elements ?? []).length, 0);
        return {
          created: true, formId, name,
          verified: gotGroups === data.groups.length && gotQs === qs,
          found: { steps: gotGroups, questions: gotQs },
          editIn: `${this.sessions.config.origin}/dashboard/form-builder/${formId}`,
          note: "No header image is set yet; the storefront shows a blank hero until one is added in the form-builder."
        };
      }
    });
    return { changes: summary, warnings: os && groupsSpec.some((g) => g.questions.some((q) => (q.options ?? []).some((o) => !o.prices && !o.productIds))) ? ["Options without a price get 0 in every country."] : [], confirmationToken: pending.token, next: "Show this to the user. Only after they confirm, call apply_form_change with the token." };
  }
  async previewAddSteps(formId, groupsSpec) {
    this.requireEditsEnabled();
    const live = await this.adminForm(formId);
    const data = toPostableForm(live);
    const countries = await this.countries();
    const added = this.#buildStructure(groupsSpec, countries);
    const base = data.groups.length;
    added.groups.forEach((g, i) => { g.order = base + i; });
    data.groups.push(...added.groups);
    const fp = fingerprint(live);
    const summary = added.groups.map((g) => `Add step "${g.label}" with ${g.elements.length} questions`);
    const pending = this.#remember({
      kind: "add-steps", formId, fingerprint: fp, summary, trial: { formId, structure: data },
      run: async () => {
        const again = await this.adminForm(formId);
        if (fingerprint(again) !== fp) throw new Error("The configurator changed since the preview. Nothing was saved. Preview again.");
        const backup = this.#writeBackup(formId, again, "Before adding steps");
        await this.sessions.json("POST", `/dashboard/api/form/${formId}`, { json: { id: formId, data } });
        const after = await this.adminForm(formId);
        return { saved: true, verified: (after.groups ?? []).length === data.groups.length, backupId: path.basename(backup, ".json"), undo: "To undo, call preview_restore_form with this backupId." };
      }
    });
    return { formId, changes: summary, confirmationToken: pending.token, next: "Show this to the user. Only after they confirm, call apply_form_change with the token." };
  }
  // ---- Backpack CRUD and catalogue helpers (added in 1.1.0) ----
  async #backpack(method, entity, id, fields) {
    const s = await this.sessions.ensure();
    const fd = new FormData();
    fd.set("_token", s.csrf);
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === void 0) continue;
      if (Array.isArray(v)) for (const x of v) fd.append(`${k}[]`, String(x));
      else fd.set(k, v === null ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    let path = `/dashboard/${entity}`;
    if (method === "update") { fd.set("_method", "PUT"); fd.set("id", String(id)); path += `/${id}`; }
    const r = method === "delete"
      ? await this.sessions.request("DELETE", `/dashboard/${entity}/${id}`)
      : await this.sessions.request("POST", path, { multipart: fd });
    if (r.status === 422) throw new Error(`config-panel refused this ${entity}: ${backpackErrorText(r.data)}`);
    if (r.status < 200 || r.status >= 400) throw new Error(`config-panel answered HTTP ${r.status} for ${method} ${entity}${id ? ` ${id}` : ""}: ${backpackErrorText(r.data)}`);
    if (method !== "create") return id;
    const newId = createdIdFrom(entity, r);
    if (newId == null) throw new Error(`config-panel created the ${entity} but did not say its id. Check the list before trying again.`);
    return newId;
  }
  async #syncFile(path, payload) {
    const s = await this.sessions.ensure();
    const fd = new FormData();
    fd.set("_token", s.csrf);
    fd.set("json_file", new Blob([JSON.stringify(payload)], { type: "application/json" }), "data.json");
    const r = await this.sessions.request("POST", path, { multipart: fd });
    if (r.status < 200 || r.status >= 400) throw new Error(`config-panel answered HTTP ${r.status} to ${path}: ${backpackErrorText(r.data)}`);
    return r.data;
  }
  #tenantBackup(name, data, note) {
    const dir = path.join(this.sessions.config.dataDir, "backups", this.sessions.config.host, name);
    fs.mkdirSync(dir, { recursive: true, mode: 448 });
    const file = path.join(dir, `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ note, takenAt: (/* @__PURE__ */ new Date()).toISOString(), data }, null, 1), { mode: 384 });
    return file;
  }
  async #needWrite() {
    this.requireEditsEnabled();
    await this.requireAdmin();
  }
  #pendingResult(summary, warnings, run, extra = {}) {
    const pending = this.#remember({ kind: extra.kind ?? "write", formId: extra.formId ?? null, summary, run, trial: extra.trial });
    return { ...extra.show, changes: summary, warnings, confirmationToken: pending.token, next: "Show this to the user. Only after they confirm, call apply_form_change with the token." };
  }
  // ---- form settings ----
  async previewFormSettings(formId, edit) {
    await this.#needWrite();
    const live = await this.adminForm(formId);
    const f = live?.form;
    if (!f) throw new Error(`Form ${formId} has no settings in config-panel's answer.`);
    const ids = (v) => (Array.isArray(v) ? v.map((x) => Number(x && typeof x === "object" ? x.id : x)).filter((n) => Number.isFinite(n)) : []);
    const before = {
      name: f.name ?? "", description: f.description ?? null, active: !(f.active === 0 || f.active === false || f.active === "0"), order: Number(f.order ?? 0),
      translation: f.translation ?? null, formCategories: ids(f.formCategories), images: ids(f.images), documentation_ids: ids(f.documentation_ids ?? f.documentations)
    };
    const after = { ...before };
    const summary = [];
    if (edit.name !== void 0) { after.name = edit.name.trim(); summary.push(`Name: "${before.name}" → "${after.name}"`); }
    if (edit.description !== void 0) { after.description = edit.description || null; summary.push(after.description ? "Set the description" : "Clear the description"); }
    if (edit.active !== void 0) { after.active = edit.active; summary.push(edit.active ? "Make it live in the storefront" : "Take it out of the storefront (inactive)"); }
    if (edit.order !== void 0) { after.order = edit.order; summary.push(`Order: ${before.order} → ${edit.order}`); }
    if (edit.categoryIds !== void 0) { after.formCategories = edit.categoryIds; summary.push(`Categories: [${before.formCategories}] → [${edit.categoryIds}]`); }
    if (edit.imageIds !== void 0) { after.images = edit.imageIds; summary.push(`Header pictures: [${before.images}] → [${edit.imageIds}]`); }
    if (edit.translation) { after.translation = { ...(before.translation ?? {}), ...edit.translation }; summary.push(`Translations: ${Object.keys(edit.translation).join(", ")}`); }
    if (!summary.length) throw new Error("Nothing to change.");
    const fp = fingerprint(live);
    return this.#pendingResult([`Form ${formId} "${before.name}": ` + summary.join("; ")], edit.active === false ? ["An inactive configurator cannot be opened in the storefront."] : [], async () => {
      const again = await this.adminForm(formId);
      if (fingerprint(again) !== fp) throw new Error("The configurator changed since the preview. Nothing was saved. Preview again.");
      const backup = this.#writeBackup(formId, again, "Before changing settings");
      await this.sessions.json("PUT", `/dashboard/forms/${formId}`, { json: after });
      const now = (await this.adminForm(formId))?.form ?? {};
      return { saved: true, verified: now.name === after.name && !(now.active === 0 || now.active === false) === after.active, backupId: path.basename(backup, ".json") };
    }, { formId, kind: "settings" });
  }
  // ---- rules ----
  #expression(node, where) {
    if (!node || typeof node !== "object") throw new Error(`${where}: expected a node.`);
    if (node.savedExpressionId) return { used_formula_saved_expression_id: node.savedExpressionId };
    if (node.op) {
      const kids = node.children ?? [];
      const two = ["lt", "lte", "eq", "neq", "gt", "gte", "sub", "div", "pow", "mod", "root", "log"];
      const one = ["not", "abs", "round", "ceil", "floor", "tan", "sin", "cos", "asin", "acos", "atan"];
      if (["substr", "includes", "replace"].includes(node.op)) throw new Error(`${where}: operation "${node.op}" breaks the storefront; use another one.`);
      if (two.includes(node.op) && kids.length !== 2) throw new Error(`${where}: "${node.op}" needs exactly 2 children.`);
      if (one.includes(node.op) && kids.length !== 1) throw new Error(`${where}: "${node.op}" needs exactly 1 child.`);
      if (!two.includes(node.op) && !one.includes(node.op) && kids.length < 2) throw new Error(`${where}: "${node.op}" needs 2 or more children.`);
      return { operation: node.op, children: kids.map((c, i) => ({ ...this.#expression(c, `${where}.${node.op}[${i}]`), order: i })) };
    }
    const v = node.value;
    if (!v?.type) throw new Error(`${where}: a leaf needs value.type.`);
    const needs = { option_selected: "optionId", quantity: "optionId", price: "optionId", cost_price: "optionId", value: "elementId", length: "elementId", is_empty: "elementId", num_selected: "elementId", num_options: "elementId", at_least_one_selected: "elementId", all_selected: "elementId", number: "constant", boolean: "constant", string: "constant", user_level: "constant", country: "countryId" };
    const need = needs[v.type];
    if (need && (v[need] === void 0 || v[need] === null)) throw new Error(`${where}: a "${v.type}" value needs ${need}.`);
    return { formula_value: { type: v.type, constant: v.constant != null ? String(v.constant) : null, form_element_id: v.elementId ?? null, form_option_id: v.optionId ?? null, country_id: v.countryId ?? null, user_id: v.userId ?? null, product_property_id: v.propertyId ?? null } };
  }
  async #createExpression(tree, owner, order = 0) {
    const created = await this.sessions.json("POST", "/dashboard/api/formula-expressions", {
      json: { order, ...owner, ...(tree.used_formula_saved_expression_id ? { used_formula_saved_expression_id: tree.used_formula_saved_expression_id } : tree.operation ? { operation: tree.operation } : {}) }
    });
    const id = resId(created);
    if (tree.formula_value) await this.sessions.json("POST", "/dashboard/api/formula-values", { json: { formula_expression_id: id, ...tree.formula_value } });
    for (const [i, child] of (tree.children ?? []).entries()) await this.#createExpression(child, { parent_id: id }, i);
    return id;
  }
  async previewCreateRule(formId, rule) {
    await this.#needWrite();
    const live = await this.adminForm(formId);
    const known = { group: new Set(), element: new Set(), option: new Set() };
    for (const g of live.groups ?? []) { known.group.add(g.id); for (const e of g.elements ?? []) { known.element.add(e.id); for (const o of e.options ?? []) known.option.add(o.id); } }
    for (const e of live.elements ?? []) { known.element.add(e.id); for (const o of e.options ?? []) known.option.add(o.id); }
    const scan = (n) => { if (!n || typeof n !== "object") return; const v = n.value; if (v?.elementId && !known.element.has(v.elementId)) throw new Error(`Element ${v.elementId} is not in form ${formId}.`); if (v?.optionId && !known.option.has(v.optionId)) throw new Error(`Option ${v.optionId} is not in form ${formId}.`); (n.children ?? []).forEach(scan); };
    scan(rule.condition);
    const condition = this.#expression(rule.condition, "condition");
    const effects = rule.effects.map((e, i) => {
      const targets = [e.groupId, e.elementId, e.optionId].filter((x) => x != null);
      if (targets.length !== 1) throw new Error(`Effect ${i + 1} (${e.type}) needs exactly one of groupId, elementId, optionId.`);
      if (e.groupId != null && !known.group.has(e.groupId)) throw new Error(`Group ${e.groupId} is not in form ${formId}.`);
      if (e.elementId != null && !known.element.has(e.elementId)) throw new Error(`Element ${e.elementId} is not in form ${formId}.`);
      if (e.optionId != null && !known.option.has(e.optionId)) throw new Error(`Option ${e.optionId} is not in form ${formId}.`);
      if (["require", "optional", "readonly"].includes(e.type) && e.elementId == null) throw new Error(`Effect ${i + 1}: "${e.type}" can only target an element.`);
      const needsExpr = ["set", "set_quantity", "set_price", "set_cost_price", "message", "warning", "success", "error"].includes(e.type);
      if (needsExpr && !e.expression) throw new Error(`Effect ${i + 1}: "${e.type}" needs an expression.`);
      if (e.expression) scan(e.expression);
      return { type: e.type, form_group_id: e.groupId ?? null, form_element_id: e.elementId ?? null, form_option_id: e.optionId ?? null, expression: e.expression ? this.#expression(e.expression, `effect ${i + 1}`) : null };
    });
    const warnings = [];
    const hidden = new Set(rule.effects.filter((e) => e.type === "hide" && e.elementId != null).map((e) => e.elementId));
    const optional = new Set(rule.effects.filter((e) => e.type === "optional").map((e) => e.elementId));
    for (const id of hidden) if (!optional.has(id)) warnings.push(`Element ${id} is hidden without an "optional" effect: if it is required, shoppers get stuck. Add optional on it in the same rule.`);
    if (!rule.order) warnings.push("Order 0 runs first; give rules an order so upstream rules run before downstream ones.");
    const summary = [`New rule "${rule.name}" on form ${formId} (order ${rule.order ?? 0}${rule.active === false ? ", off" : ""}): when ${describeExpr(rule.condition)} → ${rule.effects.map((e) => `${e.type} ${e.groupId != null ? "group " + e.groupId : e.elementId != null ? "element " + e.elementId : "option " + e.optionId}`).join(", ")}`];
    return this.#pendingResult(summary, warnings, async () => {
      const s = await this.sessions.ensure();
      const fd = new FormData();
      fd.set("_token", s.csrf); fd.set("name", rule.name); fd.set("description", rule.description ?? ""); fd.set("order", String(rule.order ?? 0)); fd.set("active", rule.active === false ? "0" : "1");
      const r = await this.sessions.request("POST", `/dashboard/form/${formId}/formula-constraint`, { multipart: fd });
      if (r.status >= 400) throw new Error(`config-panel refused the rule: HTTP ${r.status} ${backpackErrorText(r.data)}`);
      const ruleId = createdIdFrom("formula-constraint-builder", r);
      if (ruleId == null) throw new Error("config-panel created the rule but did not say its id. Check list_rules before trying again.");
      try {
        await this.#createExpression(condition, { formula_constraint_id: ruleId });
        for (const [i, e] of effects.entries()) {
          const eff = await this.sessions.json("POST", "/dashboard/api/formula-effects", { json: { type: e.type, formula_constraint_id: ruleId, order: i, form_group_id: e.form_group_id, form_element_id: e.form_element_id, form_option_id: e.form_option_id } });
          if (e.expression) await this.#createExpression(e.expression, { formula_effect_id: resId(eff) });
        }
      } catch (error) {
        throw new Error(`Rule ${ruleId} was created but its body failed: ${error.message}. Remove it with preview_remove_rule (rule ${ruleId}) and try again.`);
      }
      return { saved: true, ruleId, check: "Open the configurator in the storefront, or call get_rule, to see it work." };
    }, { formId, kind: "rule-create", show: { formId }, trial: { formId, addRule: { name: rule.name, description: rule.description, order: rule.order ?? 0, active: rule.active, condition, effects: effects.map((e) => ({ type: e.type, form_group_id: e.form_group_id, form_element_id: e.form_element_id, form_option_id: e.form_option_id, expression: e.expression })) } } });
  }
  async previewRemoveRule(formId, ruleId) {
    await this.#needWrite();
    const rule = await this.getRule(formId, ruleId);
    return this.#pendingResult([`Delete rule ${ruleId} "${rule.meta?.name ?? ""}" from form ${formId}`], ["Deleting a rule cannot be undone here. To pause it instead, switch it off with preview_rule_switch."], async () => {
      await this.sessions.json("DELETE", `/dashboard/api/formula-constraints/${ruleId}`);
      return { deleted: true, ruleId };
    }, { formId, kind: "rule-remove", trial: { formId, removeRuleIds: [ruleId] } });
  }
  // ---- products ----
  async previewSyncProducts(products) {
    await this.#needWrite();
    const countries = await this.countries();
    const cid = (k) => { const c = countries.find((x) => String(x.id) === String(k) || x.slug?.toLowerCase() === String(k).toLowerCase()); if (!c) throw new Error(`Unknown country "${k}".`); return c.id; };
    const payload = { products: [], sales_prices: [], cost_prices: [], attributes: [] };
    for (const p of products) {
      payload.products.push({ sku: p.sku, name: p.name, active: p.active ?? true, ...(p.description != null ? { description: p.description } : {}) });
      for (const [k, v] of Object.entries(p.prices ?? {})) payload.sales_prices.push({ sku: p.sku, price: v, country_id: cid(k), vat_id: null });
      for (const [k, v] of Object.entries(p.costPrices ?? {})) payload.cost_prices.push({ sku: p.sku, price: v, country_id: cid(k) });
    }
    const withAttrs = products.filter((p) => p.attributeIds?.length);
    let exported = null;
    if (withAttrs.length) {
      exported = await this.sessions.json("GET", "/dashboard/products/export");
      for (const p of withAttrs) {
        const keep = new Set((exported?.attributes ?? []).filter((a) => String(a.sku) === p.sku).map((a) => Number(a.product_property_attribute_id)));
        for (const id of p.attributeIds) keep.add(id);
        for (const id of keep) payload.attributes.push({ sku: p.sku, product_property_attribute_id: id });
      }
    }
    for (const k of Object.keys(payload)) if (!payload[k].length) delete payload[k];
    const summary = products.map((p) => `Product ${p.sku} "${p.name}"${p.prices ? `, prices ${Object.entries(p.prices).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}${p.attributeIds?.length ? `, add attributes ${p.attributeIds.join(", ")}` : ""}`);
    return this.#pendingResult(summary, ["Products are shared by every configurator. A SKU that exists is updated, a new SKU is added. Existing attributes on a SKU are kept."], async () => {
      const backup = this.#tenantBackup("products", exported ?? await this.sessions.json("GET", "/dashboard/products/export").catch(() => null), "Before product sync");
      const body = await this.#syncFile("/dashboard/products/sync", payload);
      return { sent: true, answer: body, backupFile: path.basename(backup), note: "config-panel imports in the background; check with list_products in a minute." };
    }, { kind: "products" });
  }
  // ---- properties ----
  async previewCreateProperty(p) {
    await this.#needWrite();
    const summary = [`New product property "${p.name}" (${p.type}, slug ${p.slug}) with values: ${(p.values ?? []).join(", ") || "none"}`];
    return this.#pendingResult(summary, [], async () => {
      const id = await this.#backpack("create", "product-property", null, { name: p.name, slug: p.slug, type: p.type, description: p.description ?? "", active: true });
      const values = [];
      for (const v of p.values ?? []) {
        const s = await this.sessions.ensure();
        const fd = new FormData();
        fd.set("_token", s.csrf); fd.set("productProperty", String(id)); fd.set("value", p.type === "boolean" ? (v === "true" ? "1" : "0") : v);
        const r = await this.sessions.request("POST", "/dashboard/product-property-attribute/inline/create", { multipart: fd });
        if (r.status >= 400) throw new Error(`Property ${id} was created, but adding the value "${v}" failed: HTTP ${r.status} ${backpackErrorText(r.data)}`);
        values.push({ value: v, id: createdIdFrom("product-property-attribute", r) });
      }
      return { created: true, propertyId: id, values };
    }, { kind: "property" });
  }
  // ---- VAT and discount groups ----
  async previewVat(op, v) {
    await this.#needWrite();
    const countries = await this.countries();
    const country = v.country != null ? countries.find((c) => String(c.id) === String(v.country) || c.slug?.toLowerCase() === String(v.country).toLowerCase()) : null;
    if (op !== "remove" && !country) throw new Error(`Unknown country "${v.country}".`);
    const fields = op === "remove" ? null : { name: v.name, country: country.id, vat: String(v.rate), description: v.description ?? "" };
    const summary = [op === "create" ? `New VAT rate "${v.name}" ${v.rate}% for ${country.slug}` : op === "update" ? `VAT rate ${v.id}: "${v.name}" ${v.rate}% for ${country.slug}` : `Delete VAT rate ${v.id}`];
    return this.#pendingResult(summary, ["VAT rates are shared by every price that names them."], async () => {
      const id = await this.#backpack(op === "remove" ? "delete" : op, "vat", v.id, fields);
      return { saved: true, id };
    }, { kind: "vat" });
  }
  async previewDiscountGroup(op, g) {
    await this.#needWrite();
    const warnings = [];
    if (g.priceChange && !/^[-+]/.test(g.priceChange)) warnings.push(`"${g.priceChange}" without a sign is not a discount. Ten percent off is "-10%".`);
    const fields = op === "remove" ? null : { name: g.name, description: g.description ?? "", active: g.active ?? true, price_change: g.priceChange };
    const summary = [op === "create" ? `New discount group "${g.name}" (${g.priceChange})` : op === "update" ? `Discount group ${g.id}: "${g.name}" (${g.priceChange})` : `Delete discount group ${g.id}`];
    return this.#pendingResult(summary, warnings, async () => {
      const id = await this.#backpack(op === "remove" ? "delete" : op, "discount-group", g.id, fields);
      return { saved: true, id };
    }, { kind: "discount-group" });
  }
  // ---- 1.2.0: bill of materials, documents, saved expressions, categories, media, users, appearance ----
  async #raw(method, p, { json, multipart, binary } = {}) {
    const s = await this.sessions.ensure();
    const headers = { Cookie: await this.sessions.cookieHeader(), "X-CSRF-TOKEN": s.csrf, "X-Requested-With": "XMLHttpRequest", Accept: binary ? "*/*" : "application/json" };
    let body;
    if (json !== void 0) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); } else if (multipart) body = multipart;
    const url = new URL(p, this.sessions.config.origin);
    if (url.origin !== this.sessions.config.origin) throw new Error("Refusing a request outside the configured config-panel.");
    const r = await fetch(url, { method, headers, body, redirect: "manual" });
    this.sessions.absorb?.(r.headers);
    return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
  }
  #readLocalFile(filePath, allowed, maxBytes) {
    if (!path.isAbsolute(filePath)) throw new Error("Give the file's full path on this computer.");
    if (!fs.existsSync(filePath)) throw new Error(`No file at ${filePath}.`);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!allowed.includes(ext)) throw new Error(`A .${ext} file is not accepted here; use ${allowed.join(", ")}.`);
    const bytes = fs.readFileSync(filePath);
    if (!bytes.length) throw new Error("The file is empty.");
    if (bytes.length > maxBytes) throw new Error(`The file is ${bytes.length} bytes; the limit is ${maxBytes}.`);
    return { bytes, filename: path.basename(filePath), ext };
  }
  // -- bill of materials
  async readBom(formId) {
    await this.requireAdmin();
    const e = await this.sessions.json("GET", `/dashboard/form/${formId}/export-table`);
    const rowsOf = (v) => (Array.isArray(v) ? v : []);
    const bom = Array.isArray(e.bom) ? e.bom[0] : e.bom;
    if (!bom || !bom.id) return { formId, exists: false, note: "This configurator has no bill of materials yet; preview_bom creates one." };
    const hidden = (x) => ["pdf", "excel", "checkout", "email"].filter((c) => x[`hide_on_${c}`] === 1 || x[`hide_on_${c}`] === true);
    const byOrder = (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0);
    const summary = Array.isArray(e.bom_summary) ? e.bom_summary[0] : e.bom_summary;
    return {
      formId, bomId: bom.id, hiddenOn: hidden(bom),
      tables: rowsOf(e.bom_tables).sort(byOrder).map((t) => ({
        id: t.id, label: t.label, hiddenOn: hidden(t),
        columns: rowsOf(e.bom_columns).filter((c) => Number(c.bom_table_id ?? c.table_id) === Number(t.id)).sort(byOrder).map((c) => ({ id: c.id, field: c.field, label: c.label, width: c.width, format: c.format, alignment: c.alignment, propertyId: c.product_property_id ?? void 0 })),
        groups: rowsOf(e.bom_groups).filter((g) => Number(g.bom_table_id ?? g.table_id) === Number(t.id)).sort(byOrder).map((g) => ({
          id: g.id, label: g.label,
          rows: rowsOf(e.bom_elements).filter((x) => Number(x.bom_group_id) === Number(g.id)).sort(byOrder).map((x) => ({ id: x.id, type: x.type, elementId: x.form_element_id ?? void 0, label: x.label ?? void 0, content: x.content ?? void 0 }))
        }))
      })),
      summary: summary ? { id: summary.id, label: summary.label, rows: rowsOf(e.bom_summary_rows).sort(byOrder).map((r) => ({ id: r.id, label: r.label, field: r.column_name })) } : null
    };
  }
  async previewBom(formId, edit) {
    await this.#needWrite();
    const live = await this.adminForm(formId);
    const elements = new Map();
    for (const g of live.groups ?? []) for (const e of g.elements ?? []) elements.set(e.id, e);
    for (const e of live.elements ?? []) elements.set(e.id, e);
    const current = await this.readBom(formId);
    const hide = (list) => Object.fromEntries(["pdf", "excel", "checkout", "email"].map((c) => [`hide_on_${c}`, (list ?? []).includes(c)]));
    const priceFields = ["sales_price", "cost_price", "margin", "discount"];
    const summary = [];
    const warnings = [];
    if (edit.channels) summary.push(`Show the bill of materials on: ${Object.entries(edit.channels).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing"}`);
    for (const id of edit.removeTableIds ?? []) {
      const t = current.tables?.find((x) => x.id === id);
      if (!t) throw new Error(`Table ${id} is not in this bill of materials.`);
      summary.push(`Delete table "${t.label}" with its columns, groups and rows`);
    }
    const startOrder = (current.tables?.length ?? 0) - (edit.removeTableIds?.length ?? 0);
    for (const t of edit.addTables ?? []) {
      const sum = t.columns.reduce((n, c) => n + (c.width ?? 0), 0);
      if (sum > 100) throw new Error(`Table "${t.label}": column widths add up to ${sum}%; keep them at 100 or less.`);
      for (const c of t.columns) if (c.field === "property" && !c.propertyId) throw new Error(`Column "${c.label}" shows a property; give propertyId.`);
      for (const g of t.groups) for (const r of g.rows) {
        if (r.elementId != null) {
          const el = elements.get(r.elementId);
          if (!el) throw new Error(`Element ${r.elementId} is not in form ${formId}.`);
          if (t.columns.some((c) => priceFields.includes(c.field)) && el.price_type !== "addition") warnings.push(`"${el.label}" does not add to the price, so its price columns stay empty.`);
        }
      }
      summary.push(`Add table "${t.label}": columns ${t.columns.map((c) => c.label).join(", ")}; groups ${t.groups.map((g) => `"${g.label}" (${g.rows.length} rows)`).join(", ")}`);
    }
    if (!summary.length) throw new Error("Nothing to change.");
    if (current.exists === false || (current.hiddenOn?.length === 4 && !edit.channels)) warnings.push("The bill of materials is hidden on every channel until you choose where to show it (channels).");
    return this.#pendingResult([`Form ${formId} bill of materials: ` + summary.join("; ")], warnings, async () => {
      const opened = await this.sessions.json("GET", `/dashboard/api/form/${formId}/bom`);
      const bomId = resId(opened);
      const created = [];
      if (edit.channels) await this.sessions.json("PUT", `/dashboard/api/form/${formId}/bom/${bomId}`, { json: hide(["pdf", "excel", "checkout", "email"].filter((c) => !edit.channels[c])) });
      for (const id of edit.removeTableIds ?? []) await this.sessions.request("DELETE", `/dashboard/api/bom/${bomId}/table/${id}`);
      for (const [ti, t] of (edit.addTables ?? []).entries()) {
        const table = resId(await this.sessions.json("POST", `/dashboard/api/bom/${bomId}/table`, { json: { label: t.label, order: startOrder + ti, ...hide(t.hiddenOn) } }));
        const width = Math.floor(100 / Math.max(1, t.columns.length));
        for (const [ci, c] of t.columns.entries()) {
          const money = ["sales_price", "cost_price", "margin", "discount"].includes(c.field);
          await this.sessions.json("POST", `/dashboard/api/bom-table/${table}/column`, { json: {
            order: ci, field: c.field, label: c.label, width: c.width ?? width, alignment: c.alignment ?? (money || c.field === "quantity" ? "right" : "left"),
            format: c.format ?? (money ? "currency" : c.field === "quantity" ? "number" : "text"), product_property_id: c.propertyId ?? null,
            include_in_subtotal: c.includeInSubtotal ?? money, multiply_by_quantity: ["sales_price", "cost_price"].includes(c.field), ...hide(c.hiddenOn)
          } });
        }
        for (const [gi, g] of t.groups.entries()) {
          const group = resId(await this.sessions.json("POST", `/dashboard/api/bom-table/${table}/group`, { json: { label: g.label, order: gi, ...hide(g.hiddenOn) } }));
          for (const [ri, r] of g.rows.entries()) {
            const type = r.elementId != null ? "form_element" : r.subtotal != null ? "subtotal" : "text";
            await this.sessions.json("POST", `/dashboard/api/bom-group/${group}/element`, { json: { type, order: ri, label: r.subtotal ?? null, content: r.text ?? null, form_element_id: r.elementId ?? null, show_descriptions: Boolean(r.showDescriptions), ...hide([]) } });
          }
        }
        created.push({ label: t.label, tableId: table });
      }
      return { saved: true, bomId, tablesAdded: created };
    }, { formId, kind: "bom" });
  }
  // -- document templates
  async listDocumentTemplates() {
    await this.requireAdmin();
    const r = await this.sessions.json("GET", "/dashboard/api/template-previewer/templates");
    return (r?.data ?? (Array.isArray(r) ? r : [])).map((t) => ({ id: t.id, name: t.name, outputFormat: t.output_format, hasFile: Boolean(t.has_file), filename: t.filename ?? null }));
  }
  async downloadDocumentTemplate(id, saveTo) {
    await this.requireAdmin();
    const r = await this.#raw("GET", `/dashboard/api/template-previewer/templates/${id}`, { binary: true });
    if (r.status !== 200) throw new Error(`config-panel answered HTTP ${r.status} for template ${id}'s file.`);
    const t = (await this.listDocumentTemplates()).find((x) => x.id === id);
    const target = saveTo ?? path.join(this.sessions.config.dataDir, "templates", `${id}-${t?.filename ?? "template"}`);
    if (!path.isAbsolute(target)) throw new Error("saveTo must be a full path.");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, r.buffer);
    return { id, name: t?.name, savedTo: target, bytes: r.buffer.length };
  }
  async previewDocumentTemplate(op, a) {
    await this.#needWrite();
    const list = await this.listDocumentTemplates();
    const existing = a.id != null ? list.find((t) => t.id === a.id) : null;
    if (op !== "create" && !existing) throw new Error(`No document template ${a.id}.`);
    let file = null;
    if (op === "create" || op === "replace_file") file = this.#readLocalFile(a.filePath ?? "", ["docx", "odt", "xlsx", "ods", "html"], 5 * 1024 * 1024);
    let languageId = null;
    if (op === "create") {
      const langs = await this.sessions.json("GET", "/api/localization/languages");
      const list2 = Array.isArray(langs) ? langs : langs?.data ?? [];
      const lang = list2.find((l) => String(l.id) === String(a.language) || String(l.slug ?? l.code ?? "").toLowerCase() === String(a.language ?? "en").toLowerCase()) ?? null;
      if (!lang) throw new Error(`Unknown language "${a.language}". Known: ${list2.map((l) => l.slug ?? l.code).join(", ")}`);
      languageId = lang.id;
    }
    const summary = [op === "create" ? `New quote document "${a.name}" (${a.outputFormat}, ${a.selectionMode ?? "selected"}) from ${file.filename}` : op === "replace_file" ? `Replace the file of template ${a.id} "${existing.name}" with ${file.filename}` : `Delete template ${a.id} "${existing.name}"`];
    const warnings = op === "replace_file" ? ["Every other template that shares this file changes too."] : op === "remove" ? ["Quotes can no longer be sent with this template."] : [];
    let backup = null;
    if (op !== "create" && existing?.hasFile) backup = await this.downloadDocumentTemplate(a.id, path.join(this.sessions.config.dataDir, "backups", this.sessions.config.host, "templates", `${a.id}-${Date.now()}-${existing.filename ?? "template"}`)).catch(() => null);
    return this.#pendingResult(summary, warnings, async () => {
      const dataUri = file ? `data:${file.ext === "html" ? "text/html" : "application/octet-stream"};base64,${file.bytes.toString("base64")}` : null;
      if (op === "remove") { await this.sessions.request("DELETE", `/dashboard/document-template/${a.id}`); return { deleted: true, backupOfFile: backup?.savedTo ?? null }; }
      if (op === "replace_file") { await this.sessions.json("PUT", `/dashboard/api/template-previewer/templates/${a.id}`, { json: { data_uri: dataUri } }); return { saved: true, backupOfFile: backup?.savedTo ?? null }; }
      const before = new Set(list.map((t) => t.id));
      const unique = `${path.basename(file.filename, "." + file.ext)}-${Date.now()}.${file.ext}`;
      const up = await this.sessions.json("POST", "/dashboard/api/media-uploads", { json: { files: [{ name: unique, size: file.bytes.length }] } });
      const key = up?.policies?.[0]?.key;
      const uploads = await this.sessions.json("GET", "/dashboard/api/media-uploads");
      const row = (Array.isArray(uploads) ? uploads : uploads?.data ?? []).find((u) => u.relative_url === key || String(u.url ?? "").endsWith(key ?? "\0") || String(u.key ?? "") === key || u.filename === unique);
      if (!row) throw new Error("config-panel did not create the media entry for the template file. Nothing else was saved.");
      const s = await this.sessions.ensure();
      const fd = new FormData();
      fd.set("_token", s.csrf); fd.set("name", a.name); fd.set("output_format", a.outputFormat); fd.set("output_filename", a.outputFilename ?? "");
      fd.set("selection_mode", a.selectionMode ?? "selected"); fd.set("language_id", String(languageId)); fd.append("mediaUploadDocuments[]", String(row.id));
      fd.set("users", ""); for (const u of a.userIds ?? []) fd.append("users[]", String(u));
      fd.set("forms", ""); for (const f of a.excludedFormIds ?? []) fd.append("forms[]", String(f));
      fd.set("_save_action", "save_and_back");
      const r = await this.sessions.request("POST", "/dashboard/document-template", { multipart: fd });
      if (r.status >= 400) throw new Error(`config-panel refused the template: HTTP ${r.status} ${backpackErrorText(r.data)}`);
      const made = (await this.listDocumentTemplates()).filter((t) => !before.has(t.id) && t.name === a.name);
      if (made.length !== 1) throw new Error(`config-panel answered HTTP ${r.status} but no new template "${a.name}" is listed.`);
      await this.sessions.json("PUT", `/dashboard/api/template-previewer/templates/${made[0].id}`, { json: { data_uri: dataUri } });
      return { created: true, templateId: made[0].id };
    }, { kind: "template" });
  }
  // -- saved expressions
  async listSavedExpressions(formId) {
    await this.requireAdmin();
    const r = await this.sessions.json("GET", `/dashboard/api/formula-saved-expressions?form_id=${formId}`);
    const list = r?.data ?? (Array.isArray(r) ? r : []);
    return list.map((x) => ({ id: x.id, name: x.name, description: x.description ?? null, rootExpressionId: x.formula_expression?.id ?? x.formula_expression_id ?? null }));
  }
  async previewSavedExpression(formId, op, a) {
    await this.#needWrite();
    const list = await this.listSavedExpressions(formId);
    const cur = a.id != null ? list.find((x) => x.id === a.id) : null;
    if (op !== "create" && !cur) throw new Error(`No saved expression ${a.id} on form ${formId}.`);
    if (a.expression?.savedExpressionId) throw new Error("A saved expression cannot itself be just a reference to another one.");
    const tree = a.expression ? this.#expression(a.expression, "expression") : null;
    if (op === "create" && !tree) throw new Error("Give the expression.");
    const summary = [op === "create" ? `New saved expression "${a.name}" on form ${formId}: ${describeExpr(a.expression)}` : op === "update" ? `Saved expression ${a.id} "${cur.name}": ${[a.name && `rename to "${a.name}"`, a.description !== void 0 && "description", tree && `new expression ${describeExpr(a.expression)}`].filter(Boolean).join(", ")}` : `Delete saved expression ${a.id} "${cur.name}"`];
    const warnings = op === "update" && tree ? ["Every rule that uses it evaluates the new expression at once."] : op === "remove" ? ["config-panel refuses this while a rule still uses it."] : [];
    return this.#pendingResult(summary, warnings, async () => {
      if (op === "remove") { await this.sessions.json("DELETE", `/dashboard/api/formula-saved-expressions/${a.id}`); return { deleted: true }; }
      let id = a.id;
      if (op === "create") id = resId(await this.sessions.json("POST", "/dashboard/api/formula-saved-expressions", { json: { name: a.name, form_id: formId, description: a.description ?? null } }));
      else if (a.name || a.description !== void 0) await this.sessions.json("PUT", `/dashboard/api/formula-saved-expressions/${id}`, { json: { name: a.name ?? cur.name, description: a.description ?? cur.description } });
      if (tree) {
        if (op === "update" && cur.rootExpressionId) await this.sessions.json("DELETE", `/dashboard/api/formula-expressions/${cur.rootExpressionId}`);
        await this.#createExpression(tree, { formula_saved_expression_id: id });
      }
      return { saved: true, savedExpressionId: id, use: `In a rule, use {savedExpressionId: ${id}} as the condition or as one child.` };
    }, { formId, kind: "saved-expression" });
  }
  // -- form categories
  async listFormCategories() {
    const levels = { category: "/api/form-categories", super: "/api/form-super-categories", master: "/api/form-master-categories" };
    const parent = { category: "form_super_category_id", super: "form_master_category_id", master: null };
    const out = {};
    for (const [level, url] of Object.entries(levels)) {
      const r = await this.sessions.request("GET", `${url}?size=all&language=en`);
      if (r.status === 404) { out[level] = null; continue; }
      const list = Array.isArray(r.data) ? r.data : r.data?.data ?? [];
      out[level] = list.map((x) => ({ id: x.id, name: x.name, active: x.active == null ? true : x.active === true || x.active === 1 || x.active === "1", order: Number(x.order ?? 0), ...(parent[level] && x[parent[level]] != null ? { parentId: Number(x[parent[level]]) } : {}) }));
    }
    return { levelsInUse: out.master ? 3 : out.super ? 2 : out.category ? 1 : 0, categories: out.category ?? [], superCategories: out.super ?? void 0, masterCategories: out.master ?? void 0, assignToConfigurator: "preview_form_settings with categoryIds" };
  }
  async previewFormCategory(level, op, a) {
    await this.#needWrite();
    const slug = { category: "form-category", super: "form-super-category", master: "form-master-category" }[level];
    const parentField = { category: "form_super_category_id", super: "form_master_category_id", master: null }[level];
    const tree = await this.listFormCategories();
    const list = { category: tree.categories, super: tree.superCategories, master: tree.masterCategories }[level];
    if (!list) throw new Error(`This config-panel does not use ${level} categories.`);
    let detail = null;
    if (op !== "create") {
      if (!list.some((c) => c.id === a.id)) throw new Error(`No ${level} category ${a.id}.`);
      const r = await this.sessions.request("GET", `/dashboard/${slug}/${a.id}/edit`, { headers: { Accept: "text/html" } });
      if (r.status !== 200) throw new Error(`Reading ${level} category ${a.id} failed: HTTP ${r.status}`);
      detail = parseCategoryEdit(String(r.data), parentField);
    }
    if (op === "remove" && level === "category") {
      const forms = await this.sessions.json("GET", `/api/forms?category_id=${a.id}&size=100&language=en`).catch(() => null);
      const n = (forms?.data ?? (Array.isArray(forms) ? forms : [])).length;
      if (n) throw new Error(`Category ${a.id} still holds ${n} configurator(s); move them first with preview_form_settings.`);
    }
    if (op === "remove" && level !== "category") {
      const childList = level === "super" ? tree.categories : tree.superCategories;
      if ((childList ?? []).some((c) => c.parentId === a.id)) throw new Error(`This ${level} category still has categories under it.`);
    }
    const after = op === "remove" ? null : {
      name: a.name ?? detail?.name, description: a.description ?? detail?.description ?? "", active: a.active ?? detail?.active ?? true, order: a.order ?? detail?.order ?? 0,
      translation: { ...(detail?.translation ?? {}), ...(a.translation ?? {}) }, image: a.imageId !== void 0 ? a.imageId : detail?.image ?? null, parentId: a.parentId !== void 0 ? a.parentId : detail?.parentId ?? null
    };
    if (after && !after.name) throw new Error("Give a name.");
    const words = { category: "category", super: "super category", master: "master category" }[level];
    const summary = [op === "create" ? `New ${words} "${after.name}"` : op === "update" ? `${words} ${a.id} "${detail.name}": change ${Object.keys(a).filter((k) => k !== "id").join(", ")}` : `Delete ${words} ${a.id} "${detail.name}"`];
    return this.#pendingResult(summary, [], async () => {
      if (op === "remove") { await this.#backpack("delete", slug, a.id); return { deleted: true }; }
      const s = await this.sessions.ensure();
      const fd = new FormData();
      fd.set("_token", s.csrf);
      if (op === "update") { fd.set("_method", "PUT"); fd.set("id", String(a.id)); }
      fd.set("name", after.name); fd.set("description", after.description); fd.set("active", after.active ? "1" : "0"); fd.set("order", String(after.order));
      fd.set("translation", JSON.stringify(after.translation)); for (const [k, v] of Object.entries(after.translation)) fd.set(k, v);
      if (parentField) fd.set(parentField, after.parentId == null ? "" : String(after.parentId));
      if (after.image != null) fd.append("mediaUploadImages[]", String(after.image)); else fd.set("mediaUploadImages", "");
      const r = await this.sessions.request("POST", op === "update" ? `/dashboard/${slug}/${a.id}` : `/dashboard/${slug}`, { multipart: fd });
      if (r.status >= 400) throw new Error(`config-panel refused the ${level} category: HTTP ${r.status} ${backpackErrorText(r.data)}`);
      return { saved: true, id: op === "update" ? a.id : createdIdFrom(slug, r) };
    }, { kind: "category" });
  }
  // -- media library
  async listMedia(folderId) {
    await this.requireAdmin();
    const r = await this.sessions.json("GET", `/dashboard/api/${folderId == null ? "media-folders" : `media-folders/${folderId}`}?visibility=public`);
    const list = (v) => (Array.isArray(v) ? v : v?.data ?? []);
    return { folderId: folderId ?? null, folders: list(r.folders).map((f) => ({ id: f.id, name: f.name })), uploads: list(r.uploads).map((u) => ({ id: u.id, filename: u.filename, mimeType: u.mime_type, url: u.url })) };
  }
  async previewMediaUpload(filePath, folderId) {
    await this.#needWrite();
    const file = this.#readLocalFile(filePath, ["jpg", "jpe", "jpeg", "png", "gif", "webp", "svg", "gltf", "glb", "pdf", "docx", "xlsx", "odt", "ods", "csv", "html", "htm", "ttf", "woff", "woff2"], 1e7);
    const level = await this.listMedia(folderId);
    if (level.uploads.some((u) => u.filename === file.filename)) throw new Error(`"${file.filename}" already exists in that folder; uploading it again would replace it everywhere it is shown. Rename the file first.`);
    const warnings = ["jpg", "jpe", "jpeg", "png", "gif", "webp", "svg", "ttf", "woff", "woff2"].includes(file.ext) && file.bytes.length > 5e6 ? ["Pictures and fonts over 5 MB are slow in the storefront."] : [];
    return this.#pendingResult([`Upload ${file.filename} (${Math.round(file.bytes.length / 1024)} KB) to the media library${folderId != null ? ` folder ${folderId}` : ""}`], warnings, async () => {
      const answer = await this.sessions.json("POST", `/dashboard/api/${folderId == null ? "media-uploads" : `media-folders/${folderId}/media-uploads`}?visibility=public`, { json: { files: [{ name: file.filename, size: file.bytes.length }] } });
      const policy = (answer?.policies ?? [])[0];
      const action = policy?.formAttributes?.action;
      let host = "";
      try { host = new URL(action).hostname; } catch {}
      if (!action || !action.startsWith("https://") || !/(^|\.)s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/i.test(host)) throw new Error(`config-panel named an unexpected storage address (${host || "none"}); the file was not sent.`);
      const fd = new FormData();
      for (const [k, v] of Object.entries(policy.formInputs ?? {})) fd.append(k, v);
      fd.append("file", new Blob([file.bytes]), file.filename);
      const res = await fetch(action, { method: (policy.formAttributes.method ?? "POST").toUpperCase(), body: fd, redirect: "manual" });
      if (res.status < 200 || res.status >= 300) throw new Error(`The file storage refused the file: HTTP ${res.status}.`);
      const row = (await this.listMedia(folderId)).uploads.find((u) => u.filename === file.filename);
      if (!row) throw new Error(`${file.filename} was sent but is not listed in the folder.`);
      return { uploaded: true, mediaId: row.id, url: row.url, use: "Use this id for header pictures (preview_form_settings imageIds), category pictures, or appearance image fields." };
    }, { kind: "media" });
  }
  async previewMediaDelete(ids) {
    await this.#needWrite();
    return this.#pendingResult([`Delete media ${ids.join(", ")} from the library`], ["Anything that shows these files (configurators, options, products, appearance) shows nothing afterwards."], async () => {
      await this.sessions.json("DELETE", "/dashboard/api/media-uploads", { json: { ids } });
      return { deleted: ids };
    }, { kind: "media-delete" });
  }
  // -- users
  async listUsers() {
    await this.requireAdmin();
    const r = await this.sessions.json("GET", "/api/users");
    return (r?.users ?? []).map((u) => ({ id: u.id, name: u.name, username: u.username, email: u.email, level: u.level, active: u.active === true || u.active === 1 || u.active === "1", languageId: u.language_id ?? null, discountGroupId: u.discount_group_id ?? null }));
  }
  async previewUser(op, a) {
    await this.#needWrite();
    const me = await this.currentUser();
    const meRaw = await this.sessions.json("GET", "/api/user");
    const myId = (meRaw?.user ?? meRaw)?.id;
    const rank = ["customer", "user", "admin", "super_admin", "dev"];
    if (a.level && rank.indexOf(a.level) > rank.indexOf(me.level)) throw new Error(`You cannot give a level above your own (${me.level}).`);
    const users = await this.listUsers();
    const cur = a.id != null ? users.find((u) => u.id === a.id) : null;
    if (op !== "create" && !cur) throw new Error(`No user ${a.id}.`);
    if (op !== "create" && a.id === myId) throw new Error("This tool does not change or delete the user you are logged in as; do that in config-panel.");
    const after = op === "remove" ? null : { active: a.active ?? cur?.active ?? true, name: a.name ?? cur?.name, username: a.username ?? cur?.username, email: a.email ?? cur?.email, level: a.level ?? cur?.level ?? "customer", language_id: a.languageId ?? cur?.languageId ?? "", discountGroup: a.discountGroupId !== void 0 ? a.discountGroupId : cur?.discountGroupId ?? "" };
    if (after && (!after.name || !after.username || !after.email)) throw new Error("Give name, username and e-mail.");
    const summary = [op === "create" ? `New ${after.level} user "${after.name}" <${after.email}>` : op === "update" ? `User ${a.id} "${cur.name}": ${Object.keys(a).filter((k) => k !== "id").join(", ")}` : `Delete user ${a.id} "${cur.name}" <${cur.email}>`];
    const warnings = op === "create" ? ["The new user gets a random password nobody sees; they set their own with \"Forgot password\" on the login page."] : op === "remove" ? ["Deleting a user cannot be undone here; switching them off (active false) keeps their quotes linked."] : [];
    return this.#pendingResult(summary, warnings, async () => {
      if (op === "remove") { await this.#backpack("delete", "user", a.id); return { deleted: true }; }
      const fields = { ...after, ...(op === "create" ? { password: crypto.randomBytes(24).toString("base64url") } : {}) };
      const id = await this.#backpack(op, "user", a.id, fields);
      return { saved: true, userId: id };
    }, { kind: "user" });
  }
  // -- appearance
  async readAppearance() {
    await this.requireAdmin();
    const [tabs, fields, values] = await Promise.all(["/api/appearance-field-tabs", "/api/appearance-fields", "/api/appearance-field-values"].map((p) => this.sessions.json("GET", p)));
    const list = (v) => (Array.isArray(v) ? v : v?.data ?? []);
    const vals = new Map(list(values).map((v) => [Number(v.appearance_field_id), v]));
    const out = [];
    for (const f of list(fields)) {
      const options = f.type === "select" || f.type === "radio" ? list(await this.sessions.json("GET", `/api/appearance-fields/${f.id}/appearance-field-options`)).map((o) => ({ id: o.id, label: o.label })) : void 0;
      const v = vals.get(Number(f.id));
      out.push({ id: f.id, tabId: f.appearance_field_tab_id, slug: f.slug, label: f.label, type: f.type, value: v ? v.value : null, ...(options ? { options } : {}) });
    }
    return { tabs: list(tabs).map((t) => ({ id: t.id, label: t.label, slug: t.slug })), fields: out.filter((f) => f.type !== "header") };
  }
  async previewAppearance(changes) {
    await this.#needWrite();
    const state = await this.readAppearance();
    const writes = [];
    const summary = [];
    for (const c of changes) {
      const f = state.fields.find((x) => String(x.id) === String(c.field) || x.slug === c.field || x.label?.toLowerCase() === String(c.field).toLowerCase());
      if (!f) throw new Error(`Unknown appearance field "${c.field}". Call read_appearance for the list.`);
      let value = c.value == null ? "" : String(c.value);
      if (f.type === "color" && value && !/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) throw new Error(`${f.label}: a colour is #RRGGBB or #RRGGBBAA.`);
      if (f.type === "toggle") value = value === "true" || value === "1" ? "true" : "false";
      if ((f.type === "select" || f.type === "radio") && !f.options.some((o) => String(o.id) === value || o.label === value)) throw new Error(`${f.label}: choose one of ${f.options.map((o) => o.label).join(", ")}.`);
      if (f.type === "select" || f.type === "radio") value = String(f.options.find((o) => String(o.id) === value || o.label === value).id);
      const key = { image: "images", document: "documents", font: "fonts" }[f.type];
      if (key && !c.mediaIds?.length) throw new Error(`${f.label} is a ${f.type} field; give mediaIds (upload with preview_media_upload).`);
      writes.push({ id: 0, appearance_field_id: f.id, value, ...(key ? { [key]: c.mediaIds } : {}) });
      summary.push(`${f.label}: ${f.value ?? "(none)"} → ${key ? `media ${c.mediaIds.join(", ")}` : value}`);
    }
    const backup = this.#tenantBackup("appearance", state, "Before appearance change");
    return this.#pendingResult(summary, ["Appearance changes show in the storefront at once, for every shopper."], async () => {
      const s = await this.sessions.ensure();
      const r = await this.sessions.request("POST", "/api/appearance-field-values", { json: { appearanceFieldValues: writes, _token: s.csrf } });
      if (r.status === 422) throw new Error(`config-panel refused the values: ${backpackErrorText(r.data)}`);
      if (r.status < 200 || r.status >= 300) throw new Error(`config-panel answered HTTP ${r.status}.`);
      return { saved: true, backupFile: path.basename(backup) };
    }, { kind: "appearance" });
  }
  #remember(p) {
    for (const [k, v] of this.#pending) if (Date.now() - v.createdAt > PENDING_TTL_MS) this.#pending.delete(k);
    const token = crypto.randomBytes(6).toString("hex");
    const full = { ...p, token, createdAt: Date.now() };
    this.#pending.set(token, full);
    return full;
  }
  peek(token) {
    const p = this.#pending.get(token);
    return p && Date.now() - p.createdAt <= PENDING_TTL_MS ? p : null;
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
      trial: { formId, structure: data },
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
      trial: { formId, structure: target },
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
      trial: { formId, switchRule: { id: ruleId, active } },
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
var HOW_TO_LOG_IN = "Call connection_status: it gives a link to a login page that runs on this computer. Give the user that link; they enter their config-panel address, username and password there (never in the chat), then come back and say they are done. Do not type the password into the chat.";
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
    throw new NotConfiguredError(`The config-panel address must use https (got ${url.hostname} over http).`);
  }
  return url.origin;
}
function hasLogin(config) {
  return Boolean(config.origin && config.username && config.password);
}
function applyLogin(config, login) {
  let origin;
  try {
    origin = normalizeOrigin(login.address);
  } catch (error) {
    if (error instanceof NotConfiguredError) throw error;
    throw new NotConfiguredError(`"${login.address}" is not a valid config-panel address.`);
  }
  config.origin = origin;
  config.host = new URL(origin).host;
  config.username = login.username.trim();
  config.password = login.password;
  if (login.allowEdits !== void 0) config.allowEdits = login.allowEdits;
}
function loadConfig(env = process.env) {
  const config = {
    origin: "",
    host: "",
    username: void 0,
    password: void 0,
    dataDir: clean(env.CONFIG_PANEL_DATA_DIR) ?? `${env.HOME ?? env.USERPROFILE ?? "."}/.config-panel-plugin`,
    allowEdits: /^(1|true|yes|on)$/i.test(clean(env.CONFIG_PANEL_ALLOW_EDITS) ?? "")
  };
  const address = clean(env.CONFIG_PANEL_HOST);
  const username = clean(env.CONFIG_PANEL_USERNAME);
  const password = clean(env.CONFIG_PANEL_PASSWORD);
  if (address && username && password) applyLogin(config, { address, username, password });
  return config;
}

// src/login-page.ts
import crypto2 from "node:crypto";
import fs2 from "node:fs";
import http from "node:http";
import path2 from "node:path";
var MAX_BODY = 16 * 1024;
var esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var ICONS = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.6-3.3 8.3-8 9-4.7-.7-8-4.4-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.8l8.5 4.7v9L12 21.2l-8.5-4.7v-9L12 2.8z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9.2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.5-4.5"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>'
};
var LOGO_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAQDAwMDAgQDAwMEBAQFBgoGBgUFBgwICQcKDgwPDg4MDQ0PERYTDxAVEQ0NExoTFRcYGRkZDxIbHRsYHRYYGRj/2wBDAQQEBAYFBgsGBgsYEA0QGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBj/wAARCACwALADASIAAhEBAxEB/8QAHQAAAwEBAAMBAQAAAAAAAAAAAAECCAcDBAUGCf/EAEMQAAEDAwIEAwQECQwDAAAAAAEAAgMEBREGBxIhMUEIE1EUImFxMoGxsxUjRFJidJGhwQkWJjM2QmNkZZLD4XJz0f/EABoBAQACAwEAAAAAAAAAAAAAAAABAgQFBgP/xAA4EQACAQIDBgIGCAcAAAAAAAAAAQIDEQQFEgYTITFBYVGxImKBssHwBxQVMnGRocIWJUJjc4LR/9oADAMBAAIRAxEAPwDE6fJJNdsacSEIQDCEIQCTwkmgBCEIATSTQAkeqaXJACOSEIAwjCEIA7oQhAHdL5JpIATwgJoBYRhNCASE0IBYRhPKEAkd08eqfxQCwhPCWEAkAJ4CMIAwkU0Z5oBAIwmhALCMJoQC7oTQgEOiaQ6JoAQhCAO6MZ5p9SnhALCAOarCYCmwuLHJAHNMIwliLiwjCeE8YSwuTwhItCpCWFyMcksDurwghQTcj5IVFSUAIQhACR6JoQCHRNIJoATARhUAgFhUgJhTYi4fWjkD1RgL6VhubLLqSjuklDBWtp5A8084y1//AH3B7EBRNtRbirvwL0oxlOMZuyb4vnZeNuxFys11s5pxdKCek9oiE0XmtxxtPf8A66juvRwtSS0umd0dBtcx5kgk5skAHnUkuOefRw7joQs5al05cdLajns9yYBJH7zJGj3ZWHo9vwP7jkdlqcrzZYxypVFpqR5r5/U6faPZl5WoYjDy3lCdrS/7bx6HyAMIVAY6oOMLc2OUJXu26zXa8e0fgugnq/ZojNN5Tc8DB3/66le5pjTVx1XqKK021g4ne9JK4e7CwdXO/wDnc4C0XFTaZ2t0IZJHGKCPm5/LzquXHb1cew6AfBaXNM2WEapUlqqPkvn9DrNnNmXmcZ4nES3dCF7y79r+HVmWcpr6N+ujL1qSsurKGCibUymQQQDDWZ/j3J7klfOW3g24pyVmcvVjGM5Rg7pPg+V+9u4iMqSFXNB5qWUR4z8EKiFJ5KCQQhCAB0QkFQCAYTwgdE1KIYJhACalEAPimAvbtYtzr1Si7vmZQGVvnugGXhmeeF3fcTQdruG3cddYaWGOW2QeZT+QOUkGOJzc9+XvA+ufVa7GZlTwlanSqL73Xojf5Vs/WzLC18TRkr0lfT1fyr28XwOU7f6zqNG6qjqi577fORHWQD+8z84D85vUfWO67du3pSHU+3rrzQNbLV2+P2qCRnPzYSMvaPUY94fL4rM2M8wtT7I3cXzaiKkqj5j7fK6ifxc+KPAcwf7XcP1LSbRUnhZ08xo/ei0n3Xzw9p0uxmLWOo1skxLvCabj2fW3vLuu5lnHLqkV9bU9pNh1pdbNggUlXJC3P5oceH92F59GWht+3Cs1oeOKOoq42yD9AHLv3ArqHXgqO+/ptf2WucFHC1HiFhrelq0+29vM0Ftjpal0btuLpcg2CpqovbayZ4/qow3ia0/BrefzJXBtd6yrNaankrpC+OiiJZSUxPKJmep/SPUn6ugXed+bw+07YNt8DuCS51IgOOX4to43D9zR9azAfiuZ2covEOeY1uMpN27Lt5fgju9tcasJClkuGdqdNJvu+l/P8X2J6o7LQu32grTbduZKy/0sMklyg82pNQOUUGOJrc9uQDiRzzj0XBbk23tvNU20vmfQiV3kOnADyzPInHdbrB5nTxdWpTpp2h16M5zNdn62WYahiK0leor6eq+U1+D4HqJFUQpPRbBmgJKleRSQoZZEIQRzQoADomPRIdFSAodEI7JgclJDGE0lQAwrIgXQrUez077ttFb4qr8Z5T5aPn3YHYA/Y7H1LLmFqXYSLj2mhP8An5vtauY2sSWCUvCS8md59HdRxzOUejg7/mjMddTikulTStOWxTPjB+DXEfwXffDS5z7fqSI82tlp3AfEteP4BcLvTf6S3H9am+8cu8+GFhdT6n/86b7JF67Su+Uzb9X3kYGx9oZ7TS5en7sjmO8kQi3y1A1veWN5+ZiYSr2WjbJvjYw4ZwZj9YhevJvY3h341A39OL7lirZBud97GP8A3fcvXs3/ACW/9r9hjxt/ES/zfvP3viX4mRaYjz7ual2Pj+LC4RbqcVd4pKV/0Zp44z8nOA/iu++J9nCNLfH2n/jXCrCP6V2vl+WQ/eNXls47ZTTkvCXvM99rbTz2onyvH3YmkN4p32rZ+vjpfxfnyRUnu8sMLuY/Y3H1rLmOa1Lv3Hw7RSnH5fB9rllrmCvDZKzwTl4yfkjP+kSo5ZpFN8FBebEkeafVJdQcISUFPCRHJVZKIIS7JlT6qCQC8gUBUMoClSSY6qxUY6ppdU8KwDstX+HuPi2gidj8vn+1qyj2WufDpHxbMwn/AFCf7Wrk9snbL7+svJna7AS05o36r+Ble9/2nuf63N945d+8LTc02qen06b7JFwO+f2quf65N945e3YNX6o0q2obp291dtFQWmYU7gOMtzjOQemT+1bXNcBPH4B4am0nJLn2afwNJlOYwy7MliqibUXLl3TXxP0+94A381Djpxw/csXk2Lwd/LED/j/cPX4a63a53y8T3W8VstbWzkGWeU5c/AAGfqAH1J2m8XOw3iK62auloq2HPlzwnDm5BBx8wSF7PAT+zvqd1q0ab9L6bfkeCzCH2n9ds9O812621X/M774pgB/NUDH5V/xLgtgAOrbSP87B941ezqDV+p9VCn/nFe6u5ezcXk+0OB8vixxYwB1wP2L1tO89ZWj9eg+9avHLMDPAZesNUabiny5cW38T3zTMIZhmbxUE0pOPPnwSXwNN+ISPg2dkP+oQfa5ZQ6rXPiMZw7MSn/UIPtcsjFarY13y/wD2fkjd7fS1Zon6q+IkimThSusOKFjkl9aZ5Jc8KoJKj5qzyCgqpYYzhWM4UjonkqQUCVQUhNSVKx8UZ5ICYwrABnGFoTZ3eHReiNto7Jfn3EVbauWYinpfMbwuIxzyOfJZ8yEcitfmWW0cwpbite178DPyzM62W1t/Qtqtbj3PdudTFWX2uq4c+VNUSSs4hg8LnkjI+RXqgqR0THMrYRiopJGBKTk3J9SvkjkCl0KeVYqBC9uz1UVDqS31s/F5UFVFM/hGTwteCcDvyC9POUlWcVKLi+paEnGSkuhoDeTeHRWt9t32OwvuLqt1ZFOPaKXy28LS7PPJ58ws+c0/il8lr8ty2jl1HcUL2vfiZ+Z5nWzKtv69tVrcOwKe6Z6JLPMARQemUFInkqslEkqFRKnsoJHzwqHRSmFILA5J5wEgnlEQyuyO6kFNWIPqad09e9WapotOacts9xuldKIaelgGXSO6/IAAEknAABJIAWxtM+AWKn09HcdyNyY7ZO4DjprbCzy4SR9EzSkBx+TQPTK9v+T50ZbpINW7g1UDJK2KWO00sjhkws4BLKR6F2Yxn0b8VmHezdbUO7e610vl4rp5LfHUyRW23uefKpadriGBrOnEQAXOxkkntgDXTqVa1Z0qT0qPNmQoxhBSkr3NA6+8BV8t2nZLztrrCPUZYwyC3VsLYJZh6RStJY53oCGg+qzLt7o12tt4rDoSqq5LY66XBtBJP5Ye6nJJBPCSMkEYxleXSu6+4eitLXfTemdV3C32q6wGnqaVkmWAHq6PP9W8jLS5mDgn4Y+14dcDxW7fADA/DcA+1e0FWp0565XtyZRuEpLSrGoX/wAntZoyBJu7VsyMgOtMY/5l+F3L8CustJ6Xqb9orUsGrIqaMzS0JpTTVTmgZJiAc5shxz4cgntk8l7Xj8pq6bfTTBpaeqkaNPgExRvcM+0y+gXRfATSbi02mNTO1DHdYtLPfB+DGXAPDTNl/mmAP5hnDwZI90nGOYKwN/iIUVXdS/ayPfRTc9Gn2mAWMkllbFEx0kjyGtY1pJcScAAdSc8sLXG2/gT1RftORX3cfUrNJxSMEot0MDZqljSM/jXOcGRnH933iO+DyXh8NujtN6v8f+qrpBDBNZ7BV3C60EWMsL/ajHC4D0bxlw+LWnsvi+M/dvUept87nt9Bcain03YHMp/YonlrKmoLGvfLIB9Mgv4Wg8gGk9SVlVa9SrUVGk7cLtnlCnGMdc+J0S+eAS2V1hkrNvt0BW1LAQyK4wRvhkd6GWE5Z/tcse6y0bqXb/WlZpXVtrlt10pHASQv5hzT9F7HDk9hHMOHI/PIX0ttdzdVbT64pdU6VuE1OYXg1FIHEQVkQIL4pG9HAjv1aSCMFbM8dGnrPqTYnSW6dFCGVcVRDA2UjDn0tTGXhrj34XtaR6cTvVVjUq0KsadSWpS5PuWcYVIuUVZowH8UieSeeSRWyZjCUnqqKklVZKIPVCZ6pKCRgckFAR2QDB5KlCoHmgKQllMFTcg2j4A9xrba9Q6h21udQyCe6OZcbbxnAlkYzgljHq7gDHAdw13ouV76+GfcLb/cu6VFh0xc73pirqX1FBW22ndU+Ux7i4RStYC5rm54ckYcACD1A4TR1lXb7hBX0FVNS1VPI2WGeB5Y+J7TkOa4cwQeYIWntIeO/dmwWaO36gtVk1O6Joa2sqQ+mqHAfnuj91x+PCCVgVKNWnVdWjxvzRkRnGUdM+h+K0N4T959c6cuV5i03LZYaWndLSx3lpppa+QdIomOHEMjPvuAbnAzz5fA8P0E9L4udB0tTC+KeG/RRyRvGHMc0uBaR6gghfutx/Gfu5r6xT2Oh/B+lbfUMMc/4J4zUSsPVpmectB/QDT8VxLROqq7Qu4dl1ja6enqKy0VbKuGGpBMb3N6B3CQcc+xC9YKvOEt5ZX5Io3CLWk/pD4g/FNJsVr21aaZolt8FdbhX+ebh7PwfjHM4eHy3Z+hnOe6zJuZ44twtb6ZqtP6astHpKlq2GKepgqHVNUWEYLWSENEeQeobn0IXI95d5tSb3awoNR6mttroamiovYY47c17WOZxufk8bnHOXHuuc915YbL6UIxc4+kWqV5NtJ8DvPhC3Gtu3PiSo33upZS2q90z7RPPIcMhc9zXROcezeNgaT2489l1PxgeHDWlVunW7n6HsdXfLddWsfcKWhjMs9JOxgYX+WPecxzWtOWg4PFkYIKxmQCMdloHbTxjbubdWKCxTy0Gp7XTsEcEV4DzNCwdGtmaQ4gdAHcWByHJWr0Kkau+o8+TXiRTnFx0TNG7IbeaE3d8KA2w1htPe9KTWx3HJW1FHJA+epcMGsgqJGgmQ4w5hyAMNwW4XxfHrqJti2w0dtrbrdUx0U04q3VJjPlNZTxmOOIP6F3v8Rb1AaD3XMdV+PPdi92aWgsFlsWm3yNLTWQh9VOzP5hkPC0/EtK51un4ltw929trHo3Uz6NtPbyJauenZwvuMzchksg6M4Wn6LcAuJPoBiUsJW3yqTXC97X5HrKrDS4rmccyknlIrcGIIlIoU5UEjxlLumOiRQAFXZSEZQDI7oHzRlHxQDzhPKkFPPNAWjKkKlJA0JZRlSQNGeaSClwPKMqcoQDykglLPNRcmw8qTlIn1QTlQSHVJCEAIQjqgP/2Q==";
// ---- OS credential store (1.4.0): remember the login on this computer ----
var KEYCHAIN_SERVICE = "mercura-config-panel";
function keychainRun(cmd, args, input) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnChild(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); } catch { resolve({ code: -1, out: "" }); return; }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -1, out: "" }); }, 10000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, out: "" }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin.end(input ?? "");
  });
}
var psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
var PS_VAULT = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;";
function keychainName() {
  return process.platform === "darwin" ? "the macOS Keychain" : process.platform === "win32" ? "Windows Credential Manager" : "the system keyring";
}
async function keychainSet(account, secret) {
  if (/[\r\n]/.test(secret)) return false;
  if (process.platform === "darwin") {
    const hex = Buffer.from(secret, "utf8").toString("hex");
    const acct = account.replace(/["\\\s]/g, "_");
    const r = await keychainRun("/usr/bin/security", ["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${acct} -l Mercura_config-panel -X ${hex}\n`);
    return r.code === 0 && (await keychainGet(account)) === secret;
  }
  if (process.platform === "win32") {
    const script = `${PS_VAULT}try{$o=$v.Retrieve(${psQuote(KEYCHAIN_SERVICE)},${psQuote(account)});$v.Remove($o)}catch{};$v.Add((New-Object Windows.Security.Credentials.PasswordCredential(${psQuote(KEYCHAIN_SERVICE)},${psQuote(account)},${psQuote(secret)})))\n`;
    const r = await keychainRun("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], script);
    return r.code === 0;
  }
  const r = await keychainRun("secret-tool", ["store", "--label=Mercura config-panel", "service", KEYCHAIN_SERVICE, "account", account], secret);
  return r.code === 0;
}
async function keychainGet(account) {
  if (process.platform === "darwin") {
    const r = await keychainRun("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account.replace(/["\\\s]/g, "_"), "-w"]);
    return r.code === 0 ? r.out.replace(/\n$/, "") : null;
  }
  if (process.platform === "win32") {
    const r = await keychainRun("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], `${PS_VAULT}$c=$v.Retrieve(${psQuote(KEYCHAIN_SERVICE)},${psQuote(account)});$c.RetrievePassword();[Console]::Out.Write($c.Password)\n`);
    return r.code === 0 && r.out ? r.out : null;
  }
  const r = await keychainRun("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", account]);
  return r.code === 0 && r.out ? r.out.replace(/\n$/, "") : null;
}
async function keychainDelete(account) {
  if (process.platform === "darwin") return (await keychainRun("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account.replace(/["\\\s]/g, "_")])).code === 0;
  if (process.platform === "win32") return (await keychainRun("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], `${PS_VAULT}$o=$v.Retrieve(${psQuote(KEYCHAIN_SERVICE)},${psQuote(account)});$v.Remove($o)\n`)).code === 0;
  return (await keychainRun("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", account])).code === 0;
}
function rememberedLoginFile(config) {
  return path2.join(config.dataDir, "login.json");
}
/** At start: the login remembered in the OS credential store, if the user asked for that. */
async function restoreRememberedLogin(config) {
  if (hasLogin(config)) return false;
  let r;
  try { r = JSON.parse(fs2.readFileSync(rememberedLoginFile(config), "utf8")); } catch { return false; }
  if (!r?.remember || !r.address || !r.username) return false;
  let origin;
  try { origin = normalizeOrigin(r.address); } catch { return false; }
  const password = await keychainGet(`${new URL(origin).host}|${r.username}`);
  if (!password) return false;
  applyLogin(config, { address: r.address, username: r.username, password, allowEdits: Boolean(r.allowEdits) });
  return true;
}
async function forgetRememberedLogin(config) {
  let r = {};
  try { r = JSON.parse(fs2.readFileSync(rememberedLoginFile(config), "utf8")); } catch {}
  if (r.address && r.username) {
    try { await keychainDelete(`${new URL(normalizeOrigin(r.address)).host}|${r.username}`); } catch {}
  }
  try { fs2.writeFileSync(rememberedLoginFile(config), JSON.stringify({ address: r.address, username: r.username, allowEdits: r.allowEdits, remember: false }, null, 1), { mode: 384 }); } catch {}
}
var LoginPage = class {
  #sessions;
  #onLogin;
  #server = null;
  #url = null;
  #token = "";
  #port = 0;
  #lastError = null;
  #nonce = "";
  #waiters = [];
  /** Resolves true as soon as the user has logged in on the page, false after ms. */
  waitForLogin(ms) {
    return new Promise((resolve) => {
      const w = { resolve, timer: setTimeout(() => { this.#waiters = this.#waiters.filter((x) => x !== w); resolve(false); }, ms) };
      this.#waiters.push(w);
    });
  }
  #wake() {
    for (const w of this.#waiters.splice(0)) { clearTimeout(w.timer); w.resolve(true); }
  }
  constructor(sessions, onLogin) {
    this.#sessions = sessions;
    this.#onLogin = onLogin;
  }
  get #config() {
    return this.#sessions.config;
  }
  get #rememberFile() {
    return path2.join(this.#config.dataDir, "login.json");
  }
  /** The last login error shown on the page, if the user tried and failed. */
  get lastError() {
    return this.#lastError;
  }
  /** Start the page (once) and return its link. */
  async start({ fresh = false } = {}) {
    if (fresh && this.#server) {
      this.#token = crypto2.randomBytes(24).toString("hex");
      this.#url = `http://127.0.0.1:${this.#port}/login/${this.#token}`;
      this.#lastError = null;
      return this.#url;
    }
    if (this.#url) return this.#url;
    this.#token = crypto2.randomBytes(24).toString("hex");
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) this.#send(res, 500, this.#page("Something went wrong. Close this tab and ask Claude for a new login link."));
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    this.#server = server;
    this.#port = server.address().port;
    this.#url = `http://127.0.0.1:${this.#port}/login/${this.#token}`;
    return this.#url;
  }
  stop() {
    this.#server?.close();
    this.#server = null;
    this.#url = null;
  }
  #remembered() {
    try {
      return JSON.parse(fs2.readFileSync(this.#rememberFile, "utf8"));
    } catch {
      return {};
    }
  }
  #remember(r) {
    try {
      fs2.mkdirSync(this.#config.dataDir, { recursive: true });
      fs2.writeFileSync(this.#rememberFile, JSON.stringify(r, null, 1), { mode: 384 });
    } catch {
    }
  }
  async #handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const host = req.headers.host ?? "";
    const origin = req.headers.origin;
    const okHosts = ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${this.#port}`);
    if (!okHosts.includes(host.toLowerCase())) {
      this.#send(res, 404, this.#page("This page only opens from this computer. Open the exact link Claude gave you."));
      return;
    }
    const m = url.pathname.replace(/\/+$/, "").match(/^\/login\/([0-9a-f]+)$/i);
    const given = m ? Buffer.from(m[1].toLowerCase()) : Buffer.alloc(0);
    const want = Buffer.from(this.#token);
    if (given.length !== want.length || !crypto2.timingSafeEqual(given, want)) {
      this.#send(res, 404, this.#page("This login link is no longer valid. Ask Claude for a new login link."));
      return;
    }
    if (origin && !okHosts.some((h) => origin.toLowerCase() === `http://${h}`)) {
      this.#send(res, 403, this.#page("This login was sent from another page and was blocked. Open the link Claude gave you and log in there."));
      return;
    }
    if (req.method === "GET") {
      this.#send(res, 200, this.#form());
      return;
    }
    if (req.method !== "POST") {
      this.#send(res, 405, this.#page("Not allowed."));
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      this.#send(res, 413, this.#page("Too much data."));
      return;
    }
    const f = new URLSearchParams(body);
    const address = (f.get("address") ?? "").trim();
    const username = (f.get("username") ?? "").trim();
    const password = f.get("password") ?? "";
    const allowEdits = f.get("allow_edits") === "on";
    if (!address || !username || !password) {
      this.#send(res, 400, this.#form({ address, username, allowEdits }, "Enter the address, your username and your password."));
      return;
    }
    try {
      applyLogin(this.#config, { address, username, password, allowEdits });
      await this.#sessions.ensure({ force: true });
    } catch (error) {
      this.#config.password = void 0;
      this.#sessions.logout();
      const message = error instanceof Error ? error.message.replace(/ Call connection_status:.*$/s, "") : String(error);
      this.#lastError = message;
      this.#send(res, 200, this.#form({ address, username, allowEdits, remember: f.get("remember") === "on" }, error instanceof NotConfiguredError || error instanceof Error ? message : "Login failed."));
      return;
    }
    this.#lastError = null;
    const account = `${this.#config.host}|${username}`;
    let remembered = false;
    if (f.get("remember") === "on") remembered = await keychainSet(account, password).catch(() => false);
    else await keychainDelete(account).catch(() => false);
    this.#remember({ address, username, allowEdits, remember: remembered });
    this.#onLogin();
    this.#wake();
    this.#send(
      res,
      200,
      this.#success({ username, allowEdits })
    );
    setTimeout(() => this.stop(), 1e3).unref();
  }
  #success({ username, allowEdits }) {
    const host = esc(this.#config.host ?? "");
    const card = (icon, title, text, prompts) => `
<section class="cap">
  <div class="cap-h"><span class="cap-i">${icon}</span><h3>${title}</h3></div>
  <p>${text}</p>
  <ul>${prompts.map((p) => `<li><button type="button" class="ask" data-copy="${esc(p)}"><span>“${esc(p)}”</span><i>Copy</i></button></li>`).join("")}</ul>
</section>`;
    const caps = [
      card(
        ICONS.cube,
        "Configure &amp; quote",
        "Answer a configurator in plain language and see the live price. Your rules, required answers and country prices apply exactly as in your storefront.",
        ["Which configurators do we have?", "Configure one for a customer in Denmark and tell me the price.", "Turn that into a quote and save it as a draft."]
      ),
      card(
        ICONS.search,
        "Look things up",
        "Find quotes, drafts, totals, products, SKUs, countries and languages without clicking through config-panel.",
        ["What did we quote last week?", "Show me the lines and total of our latest quote.", "Find the product with SKU … and its price."]
      ),
      card(
        ICONS.pen,
        "Edit configurators" + (allowEdits ? ' <em class="on">On</em>' : ' <em>Off</em>'),
        allowEdits
          ? "Rename, translate, re-price, hide or require options and switch rules. Every change is previewed, needs your yes, is backed up and can be undone."
          : "Admins can let Claude rename, translate, re-price and hide options. To switch this on, ask Claude to log in again and tick “Allow Claude to edit configurators”.",
        allowEdits
          ? ["Rename the option Essential to Essential+.", "Translate this configurator's labels into German.", "Undo my last configurator edit."]
          : ["Log me in again with edits on."]
      )
    ].join("");
    return this.#page(
      `
<div class="done">
  <div class="tick" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg></div>
  <h1>You're connected</h1>
  <p class="sub">Claude can now work in your config-panel as you. You can close this tab and go back to Claude.</p>
  <div class="chips">
    <span class="chip">${ICONS.globe}${host}</span>
    <span class="chip">${ICONS.user}${esc(username)}</span>
    <span class="chip ${allowEdits ? "ok" : ""}">${ICONS.pen}${allowEdits ? "Edits on" : "Read &amp; quote only"}</span>
  </div>
</div>
<h2 class="caps-title">What you can ask Claude</h2>
<div class="caps">${caps}</div>
<p class="copied" role="status" aria-live="polite"></p>`,
      { wide: true }
    );
  }
  #form(values = {}, error) {
    const r = this.#remembered();
    const address = values.address ?? r.address ?? "";
    const username = values.username ?? r.username ?? "";
    const allowEditsChecked = values.allowEdits ?? r.allowEdits ?? false;
    const rememberChecked = values.remember ?? r.remember ?? true;
    return this.#page(`
<h1>Log in to config-panel</h1>
<p class="sub">Connect Claude to your Mercura configurators.</p>
${error ? `<div class="err" role="alert">${ICONS.alert}<span>${esc(error)}</span></div>` : ""}
<form method="post" autocomplete="on" id="f">
  <label>config-panel address
    <span class="field">${ICONS.globe}<input name="address" required placeholder="acme.config.mercura.io" spellcheck="false" autocapitalize="off" value="${esc(address)}" ${address ? "" : "autofocus"}></span>
  </label>
  <label>Username or e-mail
    <span class="field">${ICONS.user}<input name="username" required autocomplete="username" spellcheck="false" autocapitalize="off" value="${esc(username)}" ${address && !username ? "autofocus" : ""}></span>
  </label>
  <label>Password
    <span class="field">${ICONS.lock}<input name="password" id="pw" type="password" required autocomplete="current-password" ${address && username ? "autofocus" : ""}><button type="button" class="peek" id="peek" aria-label="Show password">Show</button></span>
  </label>
  <label class="toggle">
    <input type="checkbox" name="allow_edits" ${allowEditsChecked ? "checked" : ""}>
    <span class="sw" aria-hidden="true"></span>
    <span class="tl"><b>Allow Claude to edit configurators</b><small>Admins only. Every edit is previewed and needs your confirmation.</small></span>
  </label>
  <label class="toggle">
    <input type="checkbox" name="remember" ${rememberChecked ? "checked" : ""}>
    <span class="sw" aria-hidden="true"></span>
    <span class="tl"><b>Remember me on this computer</b><small>Your password is kept in ${keychainName()}, so you stay logged in when Claude restarts. Untick to forget it.</small></span>
  </label>
  <button type="submit" class="go" id="go"><span class="lbl">Log in</span><span class="spin" aria-hidden="true"></span></button>
</form>
<ul class="trust">
  <li>${ICONS.shield}Runs only on this computer</li>
  <li>${ICONS.eye}Your password is never shown to Claude</li>
</ul>`);
  }
  #page(inner, { wide = false } = {}) {
    if (!/[<>]/.test(inner)) {
      inner = `<div class="notice">${ICONS.alert}<div><h1>${/link/i.test(inner) ? "Link not valid" : "Can\u2019t continue"}</h1><p>${esc(inner)}</p></div></div>`;
    }
    this.#nonce = crypto2.randomBytes(16).toString("base64");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Mercura \xB7 Connect Claude</title>
<link rel="icon" href="data:image/jpeg;base64,${LOGO_B64}"><style>
:root{--navy:#041445;--navy2:#0b2266;--coral:#f2505a;--orange:#f28a60;--ink:#0d1533;--muted:#5d6684;--line:#dfe3ee;--bg:#f6f7fb;--ok:#14a06b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font:15px/1.5 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--navy);
background-image:radial-gradient(900px 500px at 85% -10%,rgba(242,80,90,.28),transparent 60%),radial-gradient(800px 600px at -10% 110%,rgba(242,138,96,.18),transparent 60%),linear-gradient(160deg,#041445 0%,#071a55 55%,#041445 100%);
display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 18px;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:12px;color:#fff;margin-bottom:22px;text-decoration:none}
.brand img{width:44px;height:44px;border-radius:11px;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.brand b{font-size:20px;letter-spacing:-.01em}.brand span{display:block;font-size:12.5px;color:#aab3d6;font-weight:500;letter-spacing:.02em}
.bar{height:4px;background:linear-gradient(90deg,var(--coral),var(--orange));border-radius:12px 12px 0 0}
main{width:100%;max-width:440px;background:#fff;border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.15);overflow:hidden;animation:rise .45s cubic-bezier(.2,.8,.2,1)}
main.wide{max-width:860px}
.in{padding:34px 38px 30px}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
h1{font-size:25px;line-height:1.2;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 24px}
label{display:block;font-weight:600;font-size:13.5px;margin:0 0 16px}
.field{position:relative;display:flex;align-items:center;margin-top:6px}
.field>svg{position:absolute;left:12px;width:17px;height:17px;color:#8a92ad;pointer-events:none}
.field input{width:100%;padding:11px 12px 11px 38px;border:1.5px solid var(--line);border-radius:10px;font:inherit;font-weight:400;color:var(--ink);background:#fbfcfe;transition:border-color .15s,box-shadow .15s,background .15s}
.field input:hover{border-color:#c6ccdd}
.field input:focus{outline:0;border-color:var(--coral);background:#fff;box-shadow:0 0 0 4px rgba(242,80,90,.14)}
.field input::placeholder{color:#a8afc4}
.peek{position:absolute;right:6px;border:0;background:transparent;color:var(--muted);font:inherit;font-weight:600;font-size:12.5px;padding:6px 8px;border-radius:7px;cursor:pointer}
.peek:hover{background:#eef0f6;color:var(--ink)}
#pw{padding-right:64px}
.toggle{display:flex;gap:12px;align-items:flex-start;font-weight:400;padding:12px 14px;border:1.5px solid var(--line);border-radius:10px;cursor:pointer;margin:4px 0 20px;transition:border-color .15s,background .15s}
.toggle:hover{border-color:#c6ccdd}
.toggle input{position:absolute;opacity:0;width:1px;height:1px}
.sw{flex:none;width:38px;height:22px;border-radius:22px;background:#d3d8e6;position:relative;margin-top:1px;transition:background .2s}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}
.toggle input:checked+.sw{background:linear-gradient(90deg,var(--coral),var(--orange))}
.toggle input:checked+.sw::after{transform:translateX(16px)}
.toggle input:focus-visible+.sw{box-shadow:0 0 0 4px rgba(242,80,90,.2)}
.toggle:has(input:checked){border-color:rgba(242,80,90,.45);background:#fff7f6}
.tl b{display:block;font-size:13.5px}.tl small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
.go{position:relative;width:100%;padding:13px;border:0;border-radius:10px;background:linear-gradient(90deg,var(--coral),var(--orange));color:#fff;font:inherit;font-weight:700;font-size:15px;letter-spacing:.01em;cursor:pointer;box-shadow:0 8px 22px rgba(242,80,90,.35);transition:transform .12s,box-shadow .15s,filter .15s}
.go:hover{filter:brightness(1.05);box-shadow:0 10px 26px rgba(242,80,90,.45)}
.go:active{transform:translateY(1px)}
.go:focus-visible{outline:3px solid rgba(242,80,90,.35);outline-offset:2px}
.spin{display:none;position:absolute;right:16px;top:50%;width:18px;height:18px;margin-top:-9px;border:2.5px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}
.busy .spin{display:block}.busy{pointer-events:none;filter:saturate(.85)}
@keyframes sp{to{transform:rotate(360deg)}}
.err{display:flex;gap:10px;align-items:flex-start;background:#fff1f1;border:1px solid #ffd2d2;color:#a3202a;padding:11px 13px;border-radius:10px;font-size:13.5px;margin:-6px 0 18px}
.err svg{flex:none;width:18px;height:18px;margin-top:1px}
.trust{list-style:none;display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:center;margin:20px 0 0;padding:16px 0 0;border-top:1px solid #eef0f5;color:var(--muted);font-size:12.5px}
.trust li{display:flex;gap:6px;align-items:center}.trust svg{width:15px;height:15px;color:var(--ok)}
.notice{display:flex;gap:14px;align-items:flex-start}.notice>svg{flex:none;width:28px;height:28px;color:var(--coral);margin-top:2px}.notice h1{font-size:21px}.notice p{margin:0;color:var(--muted)}
.done{text-align:center;padding:6px 0 4px}
.tick{width:64px;height:64px;margin:0 auto 14px}
.tick svg{width:64px;height:64px}
.tick circle{fill:none;stroke:var(--ok);stroke-width:3;stroke-dasharray:151;stroke-dashoffset:151;animation:draw .6s .1s ease-out forwards}
.tick path{fill:none;stroke:var(--ok);stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:36;stroke-dashoffset:36;animation:draw .35s .6s ease-out forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.done .sub{max-width:520px;margin:0 auto 18px}
.chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.chip{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;background:#f1f3f9;color:var(--ink);font-size:13px;font-weight:600}
.chip svg{width:14px;height:14px;color:var(--muted)}.chip.ok{background:#e8f7f0;color:#0d7a51}.chip.ok svg{color:#0d7a51}
.caps-title{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:30px 0 12px;text-align:center}
.caps{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
.cap{border:1.5px solid var(--line);border-radius:12px;padding:16px 16px 12px;display:flex;flex-direction:column;transition:border-color .15s,box-shadow .15s}
.cap:hover{border-color:#cfd5e4;box-shadow:0 8px 24px rgba(4,20,69,.07)}
.cap-h{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.cap-i{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--coral),var(--orange));color:#fff}
.cap-i svg{width:17px;height:17px}
.cap h3{font-size:15px;margin:0;display:flex;align-items:center;gap:8px}
.cap h3 em{font-style:normal;font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:#eef0f6;color:var(--muted)}.cap h3 em.on{background:#e8f7f0;color:#0d7a51}
.cap p{color:var(--muted);font-size:13px;margin:0 0 10px}
.cap ul{list-style:none;margin:auto 0 0;padding:0;display:grid;gap:6px}
.ask{width:100%;display:flex;justify-content:space-between;align-items:center;gap:8px;text-align:left;border:0;background:#f6f7fb;border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;line-height:1.35;color:var(--ink);cursor:pointer;transition:background .15s}
.ask:hover{background:#ffeeec}.ask i{font-style:normal;font-size:11.5px;font-weight:700;color:var(--coral);opacity:0;transition:opacity .15s}.ask:hover i,.ask:focus-visible i{opacity:1}
.ask.ok i{opacity:1;color:var(--ok)}
.copied{height:18px;text-align:center;font-size:12.5px;color:var(--ok);margin:12px 0 0}
footer{margin-top:22px;color:#8f99c2;font-size:12.5px;text-align:center}footer a{color:#cdd3ee;text-decoration:none}footer a:hover{color:#fff}
@media (max-width:520px){.in{padding:26px 22px 22px}h1{font-size:22px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.tick circle,.tick path{stroke-dashoffset:0}}
</style></head><body>
<div class="brand"><img src="data:image/jpeg;base64,${LOGO_B64}" alt=""><div><b>Mercura</b><span>config-panel \xB7 for Claude</span></div></div>
<main class="${wide ? "wide" : ""}"><div class="bar"></div><div class="in">${inner}</div></main>
<footer>\xA9 Mercura ApS \xB7 <a href="https://mercura.io" target="_blank" rel="noopener noreferrer">mercura.io</a></footer>
<script nonce="${this.#nonce}">
(function(){
var f=document.getElementById("f");
if(f){f.addEventListener("submit",function(){var g=document.getElementById("go");g.classList.add("busy");g.querySelector(".lbl").textContent="Logging in…";});}
var pk=document.getElementById("peek"),pw=document.getElementById("pw");
if(pk&&pw){pk.addEventListener("click",function(){var s=pw.type==="password";pw.type=s?"text":"password";pk.textContent=s?"Hide":"Show";pk.setAttribute("aria-label",s?"Hide password":"Show password");pw.focus();});}
var st=document.querySelector(".copied");
document.querySelectorAll(".ask").forEach(function(b){b.addEventListener("click",function(){
  var t=b.getAttribute("data-copy");
  var ok=function(){document.querySelectorAll(".ask.ok").forEach(function(x){x.classList.remove("ok");x.querySelector("i").textContent="Copy";});b.classList.add("ok");b.querySelector("i").textContent="Copied";if(st)st.textContent="Copied. Paste it into Claude.";};
  if(navigator.clipboard){navigator.clipboard.writeText(t).then(ok,function(){});}
});});
})();
</script>
</body></html>`;
  }
  #send(res, status, html) {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // same-origin, not no-referrer: with no-referrer, browsers send "Origin: null" on the form post.
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${this.#nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
    });
    res.end(html);
  }
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// src/engine/quote.ts
import { createSDKStore, sdkQueryClient } from "./vendor.min.mjs";

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
var gatewayOverrides = /* @__PURE__ */ new Map();
var gatewayRecent = [];
function gatewayNote(entry) {
  gatewayRecent.push({ at: (/* @__PURE__ */ new Date()).toISOString().slice(11, 19), ...entry });
  if (gatewayRecent.length > 40) gatewayRecent.shift();
}
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
    const override = gatewayOverrides.get(url.pathname);
    if (override && (init?.method ?? (input instanceof Request ? input.method : "GET")) === "GET") {
      const live = async () => {
        let r = await send(await sessions.cookieHeader());
        if (r.status === 401) { await sessions.ensure({ force: true }); r = await send(await sessions.cookieHeader()); }
        sessions.absorb(r.headers);
        if (r.status !== 200) return null;
        try { return await r.json(); } catch { return null; }
      };
      return json(200, await override(url, live));
    }
    let response = await send(await sessions.cookieHeader());
    if (response.status === 401) {
      await sessions.ensure({ force: true });
      response = await send(await sessions.cookieHeader());
    }
    sessions.absorb(response.headers);
    gatewayNote({ path: url.pathname + url.search, status: response.status });
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
    const timer = setTimeout(() => {
      const recent = gatewayRecent.slice(-12).map((r) => `${r.at} ${r.status} ${r.path}`).join("; ");
      const errs = (waitFor.errors?.() ?? []).slice(-3).join(" | ");
      finish(new EngineError(`Timed out waiting for ${label}.${errs ? ` The storefront engine reported: ${errs}.` : ""}${recent ? ` Its last requests: ${recent}.` : " It made no requests to config-panel."}`));
    }, TIMEOUT_MS);
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
  waitFor.errors = () => errors;
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
    await this.sessions.ensure();
    installPolyfill(this.sessions.config.origin);
    installGateway(this.sessions);
    if (this.#store) await this.#reset();
    // The SDK persists its state (each configuration's loaded configurator and rules, keyed by configuration number) to
    // browser storage and reloads it into every new store. Numbers restart at 1, so a new quote would get an earlier
    // quote's configurator and rules. Every quote starts from empty storage; stores already open keep their own state.
    // The SDK also keeps one query cache for the whole process (configurators fresh for 5 minutes, failed loads too):
    // a configurator changed a minute ago would still be served from it. Every quote starts with an empty cache.
    try { globalThis.localStorage?.clear?.(); globalThis.sessionStorage?.clear?.(); sdkQueryClient?.clear?.(); } catch {}
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
  /** Drop any quote in progress (on a new login). */
  async discard() {
    if (this.#store) await this.#reset();
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
  /** An address, username and password are known (the session may still have to be opened). */
  get hasLogin() {
    return hasLogin(this.config);
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
    if (!hasLogin(this.config)) throw new NotConfiguredError(`You are not logged in to config-panel yet. ${HOW_TO_LOG_IN}`);
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
// ---- helpers for 1.1.0 write tools ----
function resId(res) {
  const d = res && typeof res === "object" && res.data != null ? res.data : res;
  const id = Number(d?.id);
  if (!Number.isFinite(id) || id <= 0) throw new Error(`config-panel's answer has no id: ${JSON.stringify(res).slice(0, 200)}`);
  return id;
}
function createdIdFrom(entity, r) {
  const re = new RegExp(`/${entity}/(\\d+)`);
  const d = r.data;
  if (d && typeof d === "object") {
    const id = Number(d.data?.id ?? d.id);
    if (Number.isSafeInteger(id) && id > 0) return id;
    const m = re.exec(String(d.redirect_url ?? ""));
    if (m) return Number(m[1]);
  }
  const m2 = re.exec(r.headers.get("location") ?? "") ?? (typeof d === "string" ? re.exec(d) : null);
  return m2 ? Number(m2[1]) : null;
}
function backpackErrorText(data) {
  if (data && typeof data === "object") {
    const msgs = Object.values(data.errors ?? {}).flat().map(String);
    if (msgs.length) return msgs.join(" ").slice(0, 300);
    if (data.message) return String(data.message).replace(/\bSQL:[\s\S]*$/, "").slice(0, 300);
  }
  return String(data ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
function describeExpr(n) {
  if (!n) return "?";
  if (n.savedExpressionId) return `saved expression ${n.savedExpressionId}`;
  if (n.op) return `${n.op}(${(n.children ?? []).map(describeExpr).join(", ")})`;
  const v = n.value ?? {};
  return v.optionId != null ? `${v.type} option ${v.optionId}` : v.elementId != null ? `${v.type} element ${v.elementId}` : `${v.type} ${v.constant ?? v.countryId ?? ""}`.trim();
}
// ---- customer dashboard page (added in 1.1.0) ----
var DOCS_BASE = "https://docs.config.mercura.io";
var DOCS_SECTIONS = [
  { title: "Getting started", blurb: "What the CPQ platform does and how it fits together.", links: [["Introduction", "/introduction"], ["Quotes", "/quotes"], ["Drafts", "/drafts"], ["FAQ", "/other/1-faq/"]] },
  { title: "Configurators", blurb: "Build the forms your customers fill in, the rules behind them and the parts list.", links: [["Form Builder", "/configurator/1-form-builder/"], ["Rule Builder", "/configurator/2-rule-builder/"], ["BoM Builder", "/configurator/3-bom-builder/"], ["Rule categories", "/categories/1-categories/"]] },
  { title: "Products", blurb: "Your catalogue, its properties and the queries that pick products.", links: [["Products", "/product-modelling/1-products/"], ["Properties & Attributes", "/product-modelling/2-properties/"], ["Product Queries", "/product-modelling/3-product-queries/"]] },
  { title: "Pricing", blurb: "VAT rates and customer-specific discounts.", links: [["VAT", "/pricing/1-vat/"], ["Discount Groups", "/pricing/2-discount-groups/"]] },
  { title: "Settings", blurb: "Users, sign-in, e-mails, languages, look and integrations.", links: [["Users", "/settings/2-users/"], ["Single Sign-On", "/settings/single-sign-on/0-overview/"], ["Request Fields", "/settings/1-request-fields/"], ["Email Templates", "/settings/3-email-templates/"], ["Localization", "/settings/4-localization/"], ["Appearance", "/settings/6-appearance/"], ["Webhooks", "/settings/7-webhooks/"], ["System Settings", "/settings/5-system-settings/"]] },
  { title: "Quote documents", blurb: "Design the PDF, Word and Excel documents your quotes are sent as.", links: [["Getting Started", "/document-templates/1-getting-started/"], ["Data Reference", "/document-templates/2-data-reference/"], ["Example Quote", "/document-templates/10-example-quote/"], ["Troubleshooting", "/document-templates/11-troubleshooting/"]] },
  { title: "Examples", blurb: "A car configurator built step by step.", links: [["Introduction", "/examples/1-introduction/"], ["Form Builder example", "/examples/2-form-builder-example-car/"], ["Simple rules example", "/examples/3-formula-constraint-example-car/"], ["Advanced rules example", "/examples/4-adv-formula-constraint-example-car/"]] },
  { title: "Developers", blurb: "Custom frontends, the Form SDK and pre-filled links.", links: [["Developer overview", "/dev/"], ["Frontend Form SDK", "/dev/sdk/"], ["Implementation flow", "/dev/sdk/flow/"], ["SDK API reference", "/dev/sdk/apis/"], ["Pre-filled links", "/dev/2-prefiller/"]] }
];
function escHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function renderCustomerDashboard(d) {
  const origin = d.origin.replace(/\/$/, "");
  const host = origin.replace(/^https?:\/\//, "");
  const company = d.companyName || host;
  const forms = d.configurators ?? [];
  const active = forms.filter((f) => f.active).length;
  const quotes = d.quotes ?? [];
  const money = (n) => (n == null || n === "" || isNaN(Number(n)) ? "" : Number(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const day = (s) => { const t = Date.parse(s); return isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10); };
  const since = Date.now() - 30 * 864e5;
  const recent30 = quotes.filter((q) => Date.parse(q.createdAt) >= since).length;
  const generated = new Date(d.generatedAt ?? Date.now()).toISOString().slice(0, 16).replace("T", " ");
  const formRows = forms.map((f) => `<li class="form" data-name="${escHtml((f.name + " " + (f.description ?? "")).toLowerCase())}" data-active="${f.active ? 1 : 0}">
      <div class="form-main"><span class="dot ${f.active ? "on" : "off"}" title="${f.active ? "Live" : "Inactive"}"></span>
        <div><div class="form-name">${escHtml(f.name)}</div>${f.description ? `<div class="form-desc">${escHtml(f.description)}</div>` : ""}</div></div>
      <div class="form-actions"><span class="pill ${f.active ? "pill-on" : "pill-off"}">${f.active ? "Live" : "Inactive"}</span>
        <a class="btn-ghost" href="${escHtml(origin)}/dashboard/form-builder/${Number(f.id)}" target="_blank" rel="noopener">Edit</a></div></li>`).join("");
  const withConf = quotes.some((q) => q.configuration);
  const quoteRows = quotes.slice(0, 8).map((q) => `<tr><td>#${escHtml(q.id)}</td>${withConf ? `<td>${escHtml(q.configuration ?? "")}</td>` : ""}<td class="num">${escHtml(money(q.total))}</td><td>${escHtml(day(q.createdAt))}</td></tr>`).join("");
  const docCards = DOCS_SECTIONS.map((s) => `<section class="doc"><h3>${escHtml(s.title)}</h3><p>${escHtml(s.blurb)}</p><ul>${s.links.map(([t, p]) => `<li><a href="${DOCS_BASE}${p}" target="_blank" rel="noopener">${escHtml(t)}</a></li>`).join("")}</ul></section>`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(company)} · Configurator dashboard</title>
<style>
:root{--ink:#141a2e;--muted:#5d6479;--line:#e4e6ee;--bg:#f6f7fb;--card:#fff;--brand:#13234f;--accent:#e46b4f;--ok:#1f8a5b;--off:#9aa0b0}
@media (prefers-color-scheme:dark){:root{--ink:#e9ebf3;--muted:#a3a9bb;--line:#2a3045;--bg:#0f1322;--card:#171c2e;--brand:#9fb3ff;--accent:#ff8a6e;--ok:#4fd19a;--off:#6b7186}}
*{box-sizing:border-box}[hidden]{display:none!important}.grid>*{min-width:0}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}header{background:#13234f;color:#fff;padding:28px 0 72px}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
h1{margin:6px 0 4px;font-size:30px;letter-spacing:-.01em}header p{margin:0;opacity:.8}
.links{display:flex;gap:10px;flex-wrap:wrap}.links a{color:#fff;text-decoration:none;border:1px solid rgba(255,255,255,.35);padding:8px 14px;border-radius:999px;font-size:14px}
.links a.primary{background:var(--accent);border-color:var(--accent)}.links a:hover{background:rgba(255,255,255,.12)}.links a.primary:hover{filter:brightness(1.05);background:var(--accent)}
main{margin-top:-48px;padding-bottom:56px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.kpi b{display:block;font-size:28px;letter-spacing:-.02em}.kpi span{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;margin-top:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
.card h2{margin:0 0 12px;font-size:18px}.card-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}.card-head h2{margin:0}
.tools{display:flex;gap:8px}input[type=search],select{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
ul.forms{list-style:none;margin:0;padding:0;max-height:560px;overflow:auto}
li.form{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 4px;border-top:1px solid var(--line)}li.form:first-child{border-top:0}
.form-main{display:flex;gap:10px;align-items:flex-start;min-width:0}.form-name{font-weight:600}.form-desc{color:var(--muted);font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dot{width:9px;height:9px;border-radius:50%;margin-top:7px;flex:none}.dot.on{background:var(--ok)}.dot.off{background:var(--off)}
.form-actions{display:flex;gap:8px;align-items:center;flex:none}.pill{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.pill-on{color:var(--ok);border-color:currentColor}
.btn-ghost{font-size:13px;text-decoration:none;padding:5px 10px;border:1px solid var(--line);border-radius:8px}.btn-ghost:hover{border-color:var(--brand)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-top:1px solid var(--line)}th{color:var(--muted);font-weight:500;border-top:0}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.empty{color:var(--muted);padding:12px 0}
.docs{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:12px}
.doc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.doc h3{margin:0 0 4px;font-size:16px}.doc p{margin:0 0 10px;color:var(--muted);font-size:13px}.doc ul{margin:0;padding-left:18px}.doc li{margin:3px 0;font-size:14px}
.section-title{display:flex;justify-content:space-between;align-items:baseline;margin:36px 0 0}.section-title h2{margin:0;font-size:20px}
footer{color:var(--muted);font-size:13px;padding:24px 0 40px;border-top:1px solid var(--line)}
@media (max-width:900px){.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.docs{grid-template-columns:repeat(2,1fr)}}
@media (max-width:560px){.docs{grid-template-columns:1fr}h1{font-size:24px}.tools{width:100%}.tools input{flex:1;min-width:0}li.form{flex-wrap:wrap}.form-actions{margin-left:19px}}
</style></head><body>
<header><div class="wrap top"><div><div class="eyebrow">Configurator dashboard</div><h1>${escHtml(company)}</h1><p>${escHtml(host)}</p></div>
<nav class="links"><a class="primary" href="${escHtml(origin)}/dashboard" target="_blank" rel="noopener">Open config-panel</a><a href="${escHtml(origin)}/" target="_blank" rel="noopener">Storefront</a><a href="${DOCS_BASE}/introduction" target="_blank" rel="noopener">Documentation</a></nav></div></header>
<main class="wrap">
<div class="kpis">
<div class="kpi"><b>${forms.length}</b><span>Configurators</span></div>
<div class="kpi"><b>${active}</b><span>Live in the storefront</span></div>
<div class="kpi"><b>${d.quoteTotal ?? quotes.length}</b><span>Quotes in total</span></div>
<div class="kpi"><b>${recent30}</b><span>Quotes in the last 30 days${quotes.length && d.quoteTotal > quotes.length && Math.min(...quotes.map((q) => Date.parse(q.createdAt) || 0)) >= since ? " (at least)" : ""}</span></div>
</div>
<div class="grid">
<div class="card"><div class="card-head"><h2>Your configurators</h2><div class="tools"><input id="q" type="search" placeholder="Search…" aria-label="Search configurators"><select id="f" aria-label="Filter"><option value="all">All</option><option value="1">Live</option><option value="0">Inactive</option></select></div></div>
${forms.length ? `<ul class="forms" id="forms">${formRows}</ul><div class="empty" id="none" hidden>No configurator matches.</div>` : `<div class="empty">No configurators yet.</div>`}</div>
<div class="card"><h2>Latest quotes</h2>${quoteRows ? `<table><thead><tr><th>Quote</th>${withConf ? "<th>Configuration</th>" : ""}<th class="num">Total</th><th>Date</th></tr></thead><tbody>${quoteRows}</tbody></table>` : `<div class="empty">No quotes yet.</div>`}
<p style="margin:14px 0 0"><a href="${escHtml(origin)}/dashboard" target="_blank" rel="noopener">See all quotes in config-panel →</a></p></div>
</div>
<div class="section-title"><h2>Documentation</h2><a href="${DOCS_BASE}/introduction" target="_blank" rel="noopener">docs.config.mercura.io →</a></div>
<div class="docs">${docCards}</div>
</main>
<footer><div class="wrap">Generated ${escHtml(generated)} UTC from ${escHtml(host)} · Powered by Mercura · Figures are a snapshot; config-panel always has the current numbers.</div></footer>
<script>(function(){var q=document.getElementById("q"),f=document.getElementById("f"),none=document.getElementById("none");if(!q)return;function run(){var t=q.value.trim().toLowerCase(),s=f.value,n=0;document.querySelectorAll("li.form").forEach(function(li){var ok=(!t||li.dataset.name.indexOf(t)>-1)&&(s==="all"||li.dataset.active===s);li.hidden=!ok;if(ok)n++});if(none)none.hidden=n>0}q.addEventListener("input",run);f.addEventListener("change",run)})();</script>
</body></html>`;
}
function decodeHtmlEntities(v) {
  return v.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function htmlInputValue(html, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(new RegExp(`<input[^>]*\\bname="${n}"[^>]*\\bvalue="([^"]*)"`, "i")) ?? html.match(new RegExp(`<input[^>]*\\bvalue="([^"]*)"[^>]*\\bname="${n}"`, "i"));
  if (m) return decodeHtmlEntities(m[1]);
  const t = html.match(new RegExp(`<textarea[^>]*\\bname="${n}"[^>]*>([\\s\\S]*?)</textarea>`, "i"));
  return t ? decodeHtmlEntities(t[1]) : null;
}
function parseCategoryEdit(html, parentField) {
  const hiddenActive = html.match(/<input[^>]*\btype="hidden"[^>]*\bname="active"[^>]*\bvalue="([^"]*)"/i)?.[1];
  const translation = {};
  for (const m of html.matchAll(/\bname="([a-z]{2}_(?:name|description))"/gi)) {
    const v = htmlInputValue(html, m[1]);
    if (v != null) translation[m[1]] = v;
  }
  const media = html.match(/<div[^>]*data-media-browser-field[^>]*data-field-name="mediaUploadImages"[^>]*>/i)?.[0]?.match(/\bdata-initial-value="([^"]*)"/i)?.[1];
  let parentId = null;
  if (parentField) {
    const sel = html.match(new RegExp(`<select[^>]*\\bname="${parentField}"[^>]*>([\\s\\S]*?)</select>`, "i"))?.[1];
    const v = sel?.match(/<option[^>]*\bselected[^>]*\bvalue="([^"]*)"/i)?.[1] ?? sel?.match(/<option[^>]*\bvalue="([^"]*)"[^>]*\bselected/i)?.[1];
    parentId = v && Number(v) > 0 ? Number(v) : null;
  }
  return {
    name: htmlInputValue(html, "name") ?? "", description: htmlInputValue(html, "description") ?? "",
    active: hiddenActive === void 0 ? /<input[^>]*\bname="active"[^>]*\bchecked/i.test(html) : hiddenActive === "1" || hiddenActive === "true",
    order: Number(htmlInputValue(html, "order") ?? 0) || 0, translation, image: media && Number(media) > 0 ? Number(media) : null, parentId
  };
}
// ---- trial mode (1.3.0): try a previewed change in the storefront's own form engine, locally ----
function trialActive(v) {
  return v === false || v === 0 || v === "0" ? 0 : 1;
}
function trialPublicForm(structure, live, ctx) {
  const now = ctx.now;
  const liveRoot = live && typeof live === "object" && live.data && live.data.groups ? live.data : live;
  const liveEls = new Map();
  const liveOpts = new Map();
  const liveGroups = new Map();
  for (const g of liveRoot?.groups ?? []) {
    liveGroups.set(Number(g.id), g);
    for (const e of g.elements ?? []) { liveEls.set(Number(e.id), e); for (const o of e.options ?? []) liveOpts.set(Number(o.id), o); }
  }
  for (const e of liveRoot?.elements ?? []) { liveEls.set(Number(e.id), e); for (const o of e.options ?? []) liveOpts.set(Number(o.id), o); }
  const anyCurrency = [...liveOpts.values()].find((o) => o.currency)?.currency ?? ctx.currency ?? null;
  const formId = ctx.formId;
  const option = (o, elId) => {
    const known = liveOpts.get(Number(o.id));
    const base = known ?? { image: null, model_3d: null, products: [], images: [], models_3d: [], documentations: [], prices: [], price: 0, base_price: 0, vat: 0, created_at: now, updated_at: now };
    const rowOf = (list) => (list ?? []).find((p) => Number(p.country_id) === ctx.countryId && (p.type ?? "sales") === "sales");
    const row = rowOf(o.prices);
    const oldRow = rowOf(base.prices);
    let price = base.price, basePrice = base.base_price, vat = base.vat;
    if (!known || Number(row?.price ?? 0) !== Number(oldRow?.price ?? 0)) {
      const p = Number(row?.price ?? 0);
      const ratio = Number(base.base_price) > 0 ? Number(base.price) / Number(base.base_price) : 1;
      basePrice = p;
      price = Math.round(p * ratio * 100) / 100;
      vat = Math.round((price - basePrice) * 100) / 100;
    }
    return {
      ...base, id: Number(o.id), active: trialActive(o.active), label: o.label ?? "", order: Number(o.order ?? 0), sub_text: o.sub_text ?? null,
      is_default: Boolean(o.is_default), allow_quantity: Boolean(o.allow_quantity), min_quantity: o.min_quantity ?? null, max_quantity: o.max_quantity ?? null,
      allow_dynamic_pricing: Boolean(o.allow_dynamic_pricing), extra_fields: o.extra_fields ?? null, translation: o.translation ?? null, form_element_id: elId,
      prices: (o.prices ?? []).map((p, i) => ({ id: p.id ?? -(Number(Math.abs(o.id)) * 10 + i), priceable_id: Number(o.id), priceable_type: "App\\Models\\FormOption", type: p.type ?? "sales", price: Number(p.price ?? 0), vat_id: p.vat_id ?? null, country_id: p.country_id, created_at: now, updated_at: now })),
      currency: base.currency ?? anyCurrency, price, base_price: basePrice, vat
    };
  };
  const element = (e, groupId) => {
    const base = liveEls.get(Number(e.id)) ?? { image: null, model_3d: null, is_attribute_element: false, attributes: [], created_at: now, updated_at: now };
    return {
      ...base, id: Number(e.id), label: e.label ?? "", active: trialActive(e.active), placeholder: e.placeholder ?? null, state: e.state ?? "open",
      min: e.min ?? null, max: e.max ?? null, step: e.step == null || e.step === "" ? null : Number(e.step), order: Number(e.order ?? 0), type: e.type,
      format: e.format ?? null, default_value: e.default_value ?? null, sub_text: e.sub_text ?? null, translation: e.translation ?? null,
      price_type: e.price_type ?? "none", dynamic_product_operator: e.dynamic_product_operator ?? null, multiplier: e.multiplier ?? null,
      extra_fields: e.extra_fields ?? null, form_id: formId, form_group_id: groupId, options: (e.options ?? []).map((o) => option(o, Number(e.id)))
    };
  };
  const group = (g) => {
    const base = liveGroups.get(Number(g.id)) ?? { image: null, images: [], created_at: now, updated_at: now };
    return {
      ...base, id: Number(g.id), active: trialActive(g.active), label: g.label ?? "", translation: g.translation ?? null, order: Number(g.order ?? 0),
      type: g.type ?? "default", is_repeatable: Boolean(g.is_repeatable), min_instances: g.min_instances ?? 0, max_instances: g.max_instances ?? null,
      description: g.description ?? null, data: g.data ?? null, extra_fields: g.extra_fields ?? null, form_id: formId,
      elements: (g.elements ?? []).map((e) => element(e, Number(g.id)))
    };
  };
  const form = liveRoot?.form ?? ctx.formMeta ?? {
    id: formId, active: 1, order: 0, created_by: 1, name: ctx.newFormName ?? "New configurator", description: null, translation: null, layout_type: "default",
    price_calculation_strategy: "Standard", url: null, extra_fields: null, form_category_id: null, thumbnail: null, created_at: now, updated_at: now, deleted_at: null,
    images: [], formCategories: [], documentations: []
  };
  const body = { form, elements: (structure.elements ?? []).map((e) => element(e, null)), groups: (structure.groups ?? []).map(group) };
  return live && live.data && live.data.groups ? { ...live, data: body } : body;
}
function trialExpr(node, ctx, order = 0) {
  if (node.used_formula_saved_expression_id) throw new Error("Trial mode cannot run a rule that uses a saved expression yet; try it on a sandbox config-panel instead.");
  const v = node.formula_value;
  const constant = !v ? null : v.constant == null ? null : v.type === "number" ? Number(v.constant) : v.type === "boolean" ? v.constant === true || v.constant === "true" || v.constant === "1" : String(v.constant);
  return {
    id: ctx.next(), name: null, description: null, operation: node.operation ?? null, form_id: ctx.formId, order, created_at: ctx.now, updated_at: ctx.now,
    formula_value: v ? { id: ctx.next(), type: v.type, constant, form_element_id: v.form_element_id ?? null, form_option_id: v.form_option_id ?? null, user_id: v.user_id ?? null, country_id: v.country_id ?? null, product_property_id: v.product_property_id ?? null, product_queryable: null, created_at: ctx.now, updated_at: ctx.now } : null,
    children: (node.children ?? []).map((c, i) => trialExpr(c, ctx, i))
  };
}
function trialRule(rule, ctx) {
  const expr = trialExpr(rule.condition, ctx);
  return {
    id: ctx.next(), active: rule.active === false ? 0 : 1, name: rule.name, description: rule.description ?? null, order: Number(rule.order ?? 0), form_id: ctx.formId,
    formula_expression_id: expr.id, created_at: ctx.now, updated_at: ctx.now, formula_expression: expr,
    formula_effects: rule.effects.map((e, i) => {
      const ex = e.expression ? trialExpr(e.expression, ctx) : null;
      return { id: ctx.next(), type: e.type, name: null, description: null, formula_expression_id: ex?.id ?? null, form_group_id: e.form_group_id ?? null, form_element_id: e.form_element_id ?? null, form_option_id: e.form_option_id ?? null, created_at: ctx.now, updated_at: ctx.now, order: i, product_queryable: null, formula_expression: ex };
    })
  };
}
function trialView(view) {
  const els = new Map();
  for (const s of view.sections ?? []) for (const e of s.elements ?? []) els.set(e.id, { ...e, group: s.label, groupHidden: s.hidden });
  return els;
}
function trialDiff(live, trial) {
  const out = [];
  const a = trialView(live), b = trialView(trial);
  const name = (e) => `"${e.label}" (${e.id})`;
  const val = (e) => (Array.isArray(e.value) ? e.value.map((v) => v.label + (v.quantity ? ` ×${v.quantity}` : "")).join(", ") || "nothing" : e.value ?? "empty");
  for (const [id, e] of b) {
    const o = a.get(id);
    if (!o) { out.push(`New question ${name(e)} in "${e.group}"${e.hidden ? " (hidden by the rules)" : ""}${e.required ? ", required" : ""}`); continue; }
    if (o.label !== e.label) out.push(`Question ${o.id}: label "${o.label}" → "${e.label}"`);
    if (Boolean(o.hidden) !== Boolean(e.hidden)) out.push(`${name(e)} is now ${e.hidden ? "hidden" : "shown"}`);
    if (Boolean(o.required) !== Boolean(e.required)) out.push(`${name(e)} is now ${e.required ? "required" : "optional"}`);
    if (Boolean(o.readonly) !== Boolean(e.readonly)) out.push(`${name(e)} is now ${e.readonly ? "read-only (set by the rules)" : "editable"}`);
    if (val(o) !== val(e)) out.push(`${name(e)} value: ${val(o)} → ${val(e)}`);
    const ao = new Map((o.options ?? []).map((x) => [x.id, x]));
    for (const x of e.options ?? []) {
      const y = ao.get(x.id);
      if (!y) { out.push(`New option "${x.label}" on ${name(e)}${x.price ? `, price ${x.price}` : ""}`); continue; }
      if (y.label !== x.label) out.push(`Option ${x.id} of ${name(e)}: "${y.label}" → "${x.label}"`);
      if (Boolean(y.hidden) !== Boolean(x.hidden)) out.push(`Option "${x.label}" of ${name(e)} is now ${x.hidden ? "hidden" : "shown"}`);
      if ((y.price ?? 0) !== (x.price ?? 0)) out.push(`Option "${x.label}" price: ${y.price ?? 0} → ${x.price ?? 0}`);
    }
    for (const y of o.options ?? []) if (!(e.options ?? []).some((x) => x.id === y.id)) out.push(`Option "${y.label}" of ${name(e)} is gone`);
  }
  for (const [id, o] of a) if (!b.has(id)) out.push(`Question ${name(o)} is gone`);
  const t = (v) => v.total?.formatted ?? "n/a";
  if (t(live) !== t(trial)) out.push(`Total: ${t(live)} → ${t(trial)}`);
  const mr = (v) => (v.missingRequired ?? []).map((m) => m.label).join(", ") || "none";
  if (mr(live) !== mr(trial)) out.push(`Still to answer: ${mr(live)} → ${mr(trial)}`);
  const msgs = (v) => new Set((v.messages ?? []).map((m) => `${m.type}: ${m.message}`));
  const ma = msgs(live), mb = msgs(trial);
  for (const m of mb) if (!ma.has(m)) out.push(`New message ${m}`);
  for (const m of ma) if (!mb.has(m)) out.push(`Message gone: ${m}`);
  return out;
}
function trialCompact(view) {
  return {
    total: view.total?.formatted ?? null,
    stillToAnswer: (view.missingRequired ?? []).map((m) => m.label),
    messages: view.messages,
    questions: (view.sections ?? []).flatMap((s) => (s.elements ?? []).filter((e) => !e.hidden && !s.hidden).map((e) => ({
      id: e.id, group: s.label, label: e.label, ...(e.required ? { required: true } : {}), ...(e.readonly ? { readonly: true } : {}),
      value: Array.isArray(e.value) ? e.value.map((v) => v.label) : e.value, ...(e.options ? { options: e.options.filter((o) => !o.hidden).map((o) => o.label + (o.price ? ` (${o.price})` : "")) } : {})
    })))
  };
}
async function runTrialSide(sessions, formId, answers, opts) {
  const q = new QuoteEngine(sessions);
  try {
    await q.start({ country: opts.country, language: opts.language });
    const configId = await q.addConfiguration(formId);
    const notes = [];
    for (const ans of answers ?? []) {
      try { for (const n of await q.setAnswers(configId, [ans])) if (n !== "Nothing changed.") notes.push(n); }
      catch (error) { notes.push(`Answer for "${ans.element}" not applied: ${error.message}`); }
    }
    return { view: q.describe(configId, { includeHidden: true, maxOptions: 300 }), notes };
  } finally {
    await q.discard().catch(() => {});
  }
}
var trialSeq = 0;
async function runTrial(sessions, admin, a) {
  const p = admin.peek(a.confirmationToken);
  if (!p) throw new Error("Unknown or expired confirmation token. Preview the change again.");
  if (!p.trial) throw new Error("This kind of change cannot be tried locally. Trial mode covers configurator structure (questions, options, prices, visibility, required) and rules; for the rest, use a sandbox config-panel.");
  const t = p.trial;
  const isNew = Boolean(t.newForm);
  const realId = isNew ? null : t.formId;
  const countriesRaw = await sessions.json("GET", "/api/localization/countries").catch(() => null);
  const countries = Array.isArray(countriesRaw) ? countriesRaw : countriesRaw?.data ?? [];
  let seq = -1000000;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  trialSeq += 1;
  const stamp = (Date.now() % 1e5) * 10 + (trialSeq % 10);
  const liveId = 910000000 + stamp;
  const trialId = 920000000 + stamp;
  const ctxFor = (url, formId) => {
    const slug = (url.searchParams.get("country") ?? a.country ?? countries[0]?.slug ?? "").toLowerCase();
    const c = countries.find((x) => String(x.slug).toLowerCase() === slug) ?? countries[0];
    return { formId, now, next: () => --seq, countryId: Number(c?.id), currency: c?.currency ?? null, newFormName: t.newForm?.name };
  };
  const real = async (suffix, url) => (realId == null ? null : sessions.json("GET", `/api/form/${realId}${suffix}${url.search}`).catch(() => null));
  // An inactive configurator is not served by the storefront: build its storefront data from the stored one instead.
  let stored = null;
  let usedStored = false;
  const storedAsPublic = async (url, id) => {
    stored ??= await sessions.json("GET", `/dashboard/api/form/${realId}`);
    usedStored = true;
    const meta = stored?.form ?? {};
    const formMeta = {
      ...meta, id, active: 1, created_by: Number(meta.created_by ?? 1), name: String(meta.name ?? ""), layout_type: meta.layout_type ?? "default",
      price_calculation_strategy: meta.price_calculation_strategy ?? "Standard", url: meta.url ?? null, thumbnail: meta.thumbnail ?? null,
      images: [], formCategories: [], documentations: [], deleted_at: null
    };
    return trialPublicForm(toPostableForm(stored), null, { ...ctxFor(url, id), formMeta });
  };
  const liveOrStored = async (url, id) => (await real("", url)) ?? (realId != null ? await storedAsPublic(url, id) : null);
  const unwrapRules = (got) => (Array.isArray(got) ? got : Array.isArray(got?.data) ? got.data : []);
  const withFormId = (body, id) => {
    if (!body) return body;
    const root = body.data && body.data.groups ? body.data : body;
    root.form = { ...(root.form ?? {}), id };
    for (const g of root.groups ?? []) { g.form_id = id; for (const e of g.elements ?? []) e.form_id = id; }
    for (const e of root.elements ?? []) e.form_id = id;
    return body;
  };
  let switchedOn = null;
  if (t.switchRule?.active) {
    const body = await sessions.json("GET", `/dashboard/api/formula-constraints/${t.switchRule.id}`);
    switchedOn = { ...(body?.data ?? body), active: 1 };
  }
  const changeRules = (rules, url, id) => {
    let out = rules.map((r) => ({ ...r, form_id: id }));
    if (t.removeRuleIds) out = out.filter((r) => !t.removeRuleIds.includes(Number(r.id)));
    if (t.switchRule) {
      out = out.filter((r) => Number(r.id) !== t.switchRule.id);
      if (switchedOn) out.push({ ...switchedOn, form_id: id });
    }
    if (t.addRule) out.push(trialRule(t.addRule, ctxFor(url, id)));
    return out.sort((x, y) => Number(x.order ?? 0) - Number(y.order ?? 0));
  };
  const overrides = new Map();
  const side = (id, changed) => {
    overrides.set(`/api/form/${id}`, async (url) => {
      const live = await liveOrStored(url, id);
      if (!changed || !t.structure) return withFormId(live ?? { form: null, elements: [], groups: [] }, id);
      return withFormId(trialPublicForm(structuredClone(t.structure), live, ctxFor(url, id)), id);
    });
    overrides.set(`/api/form/${id}/formula-constraints`, async (url) => {
      const rules = unwrapRules(await real("/formula-constraints", url));
      return changed ? changeRules(rules, url, id) : rules.map((r) => ({ ...r, form_id: id }));
    });
    overrides.set(`/api/form/${id}/queries`, async (url) => (await real("/queries", url)) ?? { formula_values: [], formula_effects: [] });
    overrides.set(`/api/form/${id}/product-properties/usage`, async (url) => (await real("/product-properties/usage", url)) ?? { properties: [] });
    overrides.set(`/api/form/${id}/bom`, async (url) => (await real("/bom", url)) ?? { data: EMPTY_BOM });
  };
  if (!isNew) side(liveId, false);
  side(trialId, true);
  const opts = { country: a.country, language: a.language };
  for (const [k, v] of overrides) gatewayOverrides.set(k, v);
  let live = null;
  let trial;
  try {
    if (!isNew) live = await runTrialSide(sessions, liveId, a.answers, opts);
    trial = await runTrialSide(sessions, trialId, a.answers, opts);
  } finally {
    for (const k of overrides.keys()) gatewayOverrides.delete(k);
  }
  for (const v of [live?.view, trial.view]) if (v?.form) v.form.id = realId;
  return {
    tried: p.summary,
    savedNothing: true,
    answers: a.answers ?? [],
    differences: live ? trialDiff(live.view, trial.view) : ["(a new configurator: there is no live version to compare with)"],
    withChange: trialCompact(trial.view),
    notes: [
      ...(usedStored ? ["The configurator is inactive, so the storefront does not serve it: both runs were built from config-panel's stored version. Rules already on it are included only once it is active."] : []),
      ...(live?.notes ?? []).map((n) => `Live: ${n}`), ...trial.notes.map((n) => `With the change: ${n}`)
    ],
    caveats: [
      "Run in the storefront's own form engine on this computer, with the same answers on the live configurator and on the changed one.",
      "Not covered: config-panel's own checks when a quote is submitted, and products, catalogue, VAT or appearance changes.",
      ...(t.structure ? ["Changed option prices are shown with the configurator's VAT ratio; the exact VAT is set by config-panel."] : [])
    ],
    next: "Show the differences to the user. If they are happy, apply with apply_form_change and the same token."
  };
}
function registerTools(server, { sessions, quote, admin, loginPage }) {
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
      description: "Call this first in every conversation. When the user is logged in it shows which config-panel, which user and level, and whether edits are on. When not, it returns loginUrl: a login page on the user's own computer. Give the user that link as a clickable link (send it to them first), then call this tool again with waitSeconds (e.g. 150): it answers as soon as they have logged in, so they do not have to tell you. Never ask for the username or password in the chat. Use newLogin to switch user, to turn edits on or off, or to forget a remembered login.",
      inputSchema: {
        again: z.boolean().optional().describe("Log in again with the same login even if already logged in"),
        newLogin: z.boolean().optional().describe("Forget the current login (also the one remembered on this computer) and give a brand-new login link (to switch user, to turn edits on or off, or when the user says the login link has expired)"),
        waitSeconds: z.number().int().min(1).max(170).optional().describe("When not logged in: wait up to this long for the user to log in on the page, then answer")
      },
      annotations: READ
    },
    wrap(async ({ again, newLogin, waitSeconds }) => {
      if (newLogin) {
        sessions.logout();
        sessions.config.password = void 0;
        await quote.discard();
        await forgetRememberedLogin(sessions.config);
      }
      if (!sessions.hasLogin && waitSeconds && !newLogin) {
        await loginPage.start();
        await loginPage.waitForLogin(waitSeconds * 1e3);
      }
      if (!sessions.hasLogin) {
        const loginUrl = await loginPage.start({ fresh: newLogin === true });
        return {
          loggedIn: false,
          loginUrl,
          lastLoginError: loginPage.lastError ?? void 0,
          tellTheUser: waitSeconds ? "Still waiting for the login. Remind the user of the link, then call connection_status with waitSeconds again." : "Open this link to log in to your config-panel. It is a page on your own computer: enter your config-panel address, username and password there (never in this chat). Then call connection_status with waitSeconds to be told as soon as they are logged in."
        };
      }
      await sessions.ensure({ force: again === true });
      const user = await admin.currentUser();
      return {
        loggedIn: true,
        tenant: sessions.config.origin,
        user,
        loggedInAt: sessions.loggedInAt,
        editsAllowed: sessions.config.allowEdits,
        rememberedOnThisComputer: (() => { try { return Boolean(JSON.parse(fs2.readFileSync(rememberedLoginFile(sessions.config), "utf8")).remember); } catch { return false; } })(),
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
  server.registerTool(
    "list_vat_and_discount_groups",
    {
      title: "VAT rates and discount groups",
      description: "The VAT rates and discount groups of this config-panel, with ids.",
      inputSchema: {},
      annotations: READ
    },
    wrap(async () => {
      const [vats, groups] = await Promise.all([
        sessions.json("GET", "/api/vats?size=100").catch(() => null),
        sessions.json("GET", "/api/discountgroups").catch(() => null)
      ]);
      return {
        vatRates: (vats?.data ?? (Array.isArray(vats) ? vats : [])).map((v) => ({ id: v.id, name: v.name, rate: v.vat ?? v.rate, country: v.country?.slug ?? v.country_id })),
        discountGroups: (groups?.data ?? []).map((g) => ({ id: g.id, name: g.name, priceChange: g.price_change, active: !(g.active === 0 || g.active === false) }))
      };
    })
  );
  server.registerTool(
    "build_customer_dashboard",
    {
      title: "Build the customer dashboard page",
      description: "Build a self-contained, shareable HTML dashboard for this config-panel: its configurators (live/inactive, edit links), quote figures and the latest quotes (no customer names or e-mails), quick links, and the Mercura documentation (docs.config.mercura.io). Returns the HTML: write it to a file and publish it as a page for the user.",
      inputSchema: { companyName: z.string().optional().describe("Shown as the page title; defaults to the config-panel's address") },
      annotations: READ
    },
    wrap(async (a) => {
      const formsResp = await sessions.json("GET", "/api/forms?size=100&page=1");
      const forms = (Array.isArray(formsResp) ? formsResp : formsResp?.data ?? []).map((f) => ({ id: f.id, name: f.name, description: f.description ? String(f.description).replace(/<[^>]+>/g, "").slice(0, 240) : null, active: f.active !== 0 && f.active !== false }));
      const quotesResp = await sessions.json("GET", "/api/requests?size=50&page=1&direction=desc").catch(() => null);
      const quotes = (Array.isArray(quotesResp) ? quotesResp : quotesResp?.data ?? []).map((q) => ({ id: q.id, total: q.conf_total, createdAt: q.created_at, configuration: q.configuration_name ?? q.configuration?.name }));
      const html = renderCustomerDashboard({ origin: sessions.config.origin, companyName: a.companyName, configurators: forms, quotes, quoteTotal: quotesResp?.total ?? quotes.length, generatedAt: Date.now() });
      return { configurators: forms.length, quotesShown: Math.min(quotes.length, 8), html, next: "Write html to a file and publish it as a page; give the user the link." };
    })
  );
  server.registerTool("get_bom", { title: "Read a configurator's bill of materials", description: "Tables, columns, groups, rows and summary of a configurator's bill of materials (parts list on the quote), with ids and the channels it is hidden on.", inputSchema: { formId: z.number().int() }, annotations: READ }, wrap(async (a) => admin.readBom(a.formId)));
  server.registerTool("list_document_templates", { title: "Quote document templates", description: "The quote document templates (PDF, Word, Excel...) with ids, output format and file name.", inputSchema: {}, annotations: READ }, wrap(async () => ({ templates: await admin.listDocumentTemplates() })));
  server.registerTool("download_document_template", { title: "Download a template's file", description: "Save a quote document template's file (docx, xlsx, odt, ods, html) on this computer so it can be opened or edited. saveTo is a full path; default is the plugin's data folder.", inputSchema: { templateId: z.number().int(), saveTo: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, wrap(async (a) => admin.downloadDocumentTemplate(a.templateId, a.saveTo)));
  server.registerTool("list_saved_expressions", { title: "Saved expressions", description: "A configurator's saved expressions (named conditions several rules reuse), with ids.", inputSchema: { formId: z.number().int() }, annotations: READ }, wrap(async (a) => ({ savedExpressions: await admin.listSavedExpressions(a.formId) })));
  server.registerTool("list_form_categories", { title: "Configurator categories", description: "The categories the storefront groups configurators by (and super and master categories when used), with ids.", inputSchema: {}, annotations: READ }, wrap(async () => admin.listFormCategories()));
  server.registerTool("list_media", { title: "Media library", description: "One folder of the media library: its sub-folders and files, with ids (use the ids for pictures). Omit folderId for the top level.", inputSchema: { folderId: z.number().int().optional() }, annotations: READ }, wrap(async (a) => admin.listMedia(a.folderId)));
  server.registerTool("list_users", { title: "Users", description: "The config-panel users (no passwords): id, name, username, e-mail, level, active, language, discount group.", inputSchema: {}, annotations: READ }, wrap(async () => ({ users: await admin.listUsers() })));
  server.registerTool("read_appearance", { title: "Appearance settings", description: "The storefront's appearance fields (colours, logos, fonts, texts, toggles) with their current values, grouped by tab; select fields list their options.", inputSchema: {}, annotations: READ }, wrap(async () => admin.readAppearance()));
  const editTools = [];
  const reg = server.registerTool.bind(server);
  server.registerTool = (...args) => {
    const t = reg(...args);
    editTools.push(t);
    return t;
  };
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
      description: "Admins: save a change previewed with any preview_* tool (configurator edits, new configurators and steps, settings, rules, products, properties, VAT, discount groups, restores). It changes the live configurator for every shopper. Call only after the user explicitly confirmed that preview. Backs the configurator up first and checks the result.",
      inputSchema: { confirmationToken: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    wrap(async (a) => admin.apply(a.confirmationToken))
  );
  const optionSpec = z.object({
    label: z.string().min(1),
    helpText: z.string().optional(),
    isDefault: z.boolean().optional(),
    prices: z.record(z.string(), z.number()).optional().describe("Country slug/name/id -> price incl. VAT. Omitted: 0 in every country."),
    productIds: z.array(z.number().int()).optional().describe("Catalogue product ids this option adds"),
    quantity: z.object({ min: z.number().int().min(0), max: z.number().int().min(1) }).optional().describe("Let the shopper pick a quantity")
  });
  const questionSpec = z.object({
    label: z.string().min(1),
    type: z.enum(["radio", "select", "checkbox", "text", "number", "range"]),
    required: z.boolean().optional(),
    helpText: z.string().optional(),
    placeholder: z.string().optional(),
    min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),
    defaultValue: z.union([z.string(), z.number()]).optional(),
    options: z.array(optionSpec).optional()
  });
  const stepSpec = z.object({ label: z.string().min(1), description: z.string().optional(), questions: z.array(questionSpec).min(1) });
  server.registerTool(
    "preview_create_configurator",
    {
      title: "Preview creating a new configurator (admin)",
      description: "Admins: plan a brand-new configurator (Form) with its steps, questions and options. Saves nothing: returns a summary and a confirmation token. Show it to the user; create only after they say yes, with apply_form_change.",
      inputSchema: {
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        active: z.boolean().optional().describe("Default false, so shoppers do not see it before it is checked"),
        steps: z.array(stepSpec).min(1).max(60)
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async (a) => admin.previewCreateForm(a.name, a.description, a.steps, a.active ?? false))
  );
  server.registerTool(
    "preview_add_configurator_steps",
    {
      title: "Preview adding steps to a configurator (admin)",
      description: "Admins: plan adding new steps (groups) with questions and options at the end of an existing configurator. Saves nothing; returns a confirmation token for apply_form_change.",
      inputSchema: { formId: z.number().int(), steps: z.array(stepSpec).min(1).max(60) },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async (a) => admin.previewAddSteps(a.formId, a.steps))
  );
  const valueSpec = z.object({
    type: z.enum(["option_selected", "at_least_one_selected", "all_selected", "is_empty", "value", "length", "num_selected", "num_options", "quantity", "price", "cost_price", "number", "boolean", "string", "user_level", "country", "is_user"]),
    optionId: z.number().int().optional(), elementId: z.number().int().optional(), countryId: z.number().int().optional(), userId: z.number().int().optional(),
    constant: z.union([z.string(), z.number(), z.boolean()]).optional()
  });
  const exprSpec = z.lazy(() => z.object({
    op: z.enum(["and", "or", "xor", "not", "lt", "lte", "eq", "neq", "gt", "gte", "add", "sub", "mul", "div", "pow", "mod", "min", "max", "avg", "median", "abs", "round", "ceil", "floor", "concat"]).optional(),
    children: z.array(exprSpec).optional(),
    value: valueSpec.optional(),
    savedExpressionId: z.number().int().optional()
  }));
  // Published without $ref (some hosts do not follow references and pass the value on as text): an object, or the same as
  // JSON text; checked against exprSpec inside.
  const exprIn = z.union([z.string(), z.object({}).passthrough()]).describe('An expression tree: {op, children} or {value: {type, ...}} or {savedExpressionId}, as an object or as JSON text');
  const parseExpr = (v, where) => {
    let x = v;
    if (typeof x === "string") { try { x = JSON.parse(x); } catch { throw new Error(`${where} is not valid JSON.`); } }
    const r = exprSpec.safeParse(x);
    if (!r.success) throw new Error(`${where} is not a valid expression: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return r.data;
  };
  server.registerTool(
    "preview_form_settings",
    {
      title: "Preview changing a configurator's settings (admin)",
      description: "Admins: plan a configurator's name, description, live/inactive, order, categories, header pictures (media ids) or translations (keys like da_name). Saves nothing; returns a token for apply_form_change.",
      inputSchema: { formId: z.number().int(), name: z.string().min(1).max(255).optional(), description: z.string().optional(), active: z.boolean().optional(), order: z.number().int().min(0).optional(), categoryIds: z.array(z.number().int()).optional(), imageIds: z.array(z.number().int()).optional(), translation: z.record(z.string(), z.string()).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async ({ formId, ...edit }) => admin.previewFormSettings(formId, edit))
  );
  server.registerTool(
    "preview_create_rule",
    {
      title: "Preview a new rule (admin)",
      description: "Admins: plan a new rule on a configurator: a condition tree and effects. Leaves are {value:{type,...}}: option_selected needs optionId; value/is_empty/num_selected need elementId; number/boolean/string need constant. Operations: and/or/not, comparisons (2 children), arithmetic, concat. Effects: show/hide (group, element or option), require/optional/readonly (element only), set (with expression), set_price/set_quantity (option, with expression), message/warning/error (with a concat or string expression). Pair every hide on an element with optional on it. Always-on rule: condition {value:{type:'boolean',constant:true}}. Saves nothing; returns a token for apply_form_change.",
      inputSchema: {
        formId: z.number().int(), name: z.string().min(1), description: z.string().optional(), order: z.number().int().min(0).optional(), active: z.boolean().optional(),
        condition: exprIn,
        effects: z.array(z.object({ type: z.enum(["show", "hide", "require", "optional", "readonly", "unset", "set", "set_quantity", "set_price", "set_cost_price", "message", "warning", "success", "error"]), groupId: z.number().int().optional(), elementId: z.number().int().optional(), optionId: z.number().int().optional(), expression: exprIn.optional() })).min(1)
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async ({ formId, ...rule }) => admin.previewCreateRule(formId, {
      ...rule,
      condition: parseExpr(rule.condition, "condition"),
      effects: rule.effects.map((e, i) => (e.expression === void 0 ? e : { ...e, expression: parseExpr(e.expression, `effect ${i + 1} expression`) }))
    }))
  );
  server.registerTool(
    "preview_remove_rule",
    {
      title: "Preview deleting a rule (admin)",
      description: "Admins: plan deleting one rule. Saves nothing; returns a token for apply_form_change. Prefer preview_rule_switch to pause a rule.",
      inputSchema: { formId: z.number().int(), ruleId: z.number().int() },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async (a) => admin.previewRemoveRule(a.formId, a.ruleId))
  );
  server.registerTool(
    "preview_sync_products",
    {
      title: "Preview adding or updating products (admin)",
      description: "Admins: plan adding or updating catalogue products by SKU: name, active, description, sales prices and cost prices per country slug, and property values (attribute ids, added to what the SKU has). Saves nothing; returns a token for apply_form_change.",
      inputSchema: { products: z.array(z.object({ sku: z.string().min(1), name: z.string().min(1), active: z.boolean().optional(), description: z.string().optional(), prices: z.record(z.string(), z.number()).optional(), costPrices: z.record(z.string(), z.number()).optional(), attributeIds: z.array(z.number().int()).optional() })).min(1).max(500) },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async (a) => admin.previewSyncProducts(a.products))
  );
  server.registerTool(
    "preview_create_property",
    {
      title: "Preview a new product property (admin)",
      description: "Admins: plan a product property (e.g. colour, width) with its values. Saves nothing; returns a token for apply_form_change.",
      inputSchema: { name: z.string().min(1), slug: z.string().regex(/^[a-z0-9_-]+$/), type: z.enum(["string", "number", "boolean"]), description: z.string().optional(), values: z.array(z.string()).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async (a) => admin.previewCreateProperty(a))
  );
  server.registerTool(
    "preview_vat_rate",
    {
      title: "Preview a VAT rate change (admin)",
      description: "Admins: plan creating, updating or deleting a VAT rate (name, country slug, rate in percent). Saves nothing; returns a token for apply_form_change.",
      inputSchema: { op: z.enum(["create", "update", "remove"]), id: z.number().int().optional(), name: z.string().optional(), country: z.string().optional(), rate: z.number().min(0).max(100).optional(), description: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async ({ op, ...v }) => {
      if (op !== "create" && v.id == null) throw new Error("Give the id of the VAT rate.");
      if (op !== "remove" && (!v.name || v.country == null || v.rate == null)) throw new Error("Give name, country and rate.");
      return admin.previewVat(op, v);
    })
  );
  server.registerTool(
    "preview_discount_group",
    {
      title: "Preview a discount group change (admin)",
      description: 'Admins: plan creating, updating or deleting a discount group. priceChange like "-10%" (ten percent off) or "-50" (fifty off). Saves nothing; returns a token for apply_form_change.',
      inputSchema: { op: z.enum(["create", "update", "remove"]), id: z.number().int().optional(), name: z.string().optional(), description: z.string().optional(), active: z.boolean().optional(), priceChange: z.string().regex(/^[-+]?(\d*[,.])?\d+%?$/).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async ({ op, ...g }) => {
      if (op !== "create" && g.id == null) throw new Error("Give the id of the discount group.");
      if (op !== "remove" && (!g.name || !g.priceChange)) throw new Error("Give name and priceChange.");
      return admin.previewDiscountGroup(op, g);
    })
  );
  const hiddenSpec = z.array(z.enum(["pdf", "excel", "checkout", "email"])).optional().describe("Channels to hide this on");
  server.registerTool("preview_bom", {
    title: "Preview a bill of materials change (admin)",
    description: "Admins: plan a configurator's bill of materials: which channels show it (pdf, excel, checkout, email), tables to add (columns: label, value, name, description, sku, quantity, sales_price, cost_price, margin, discount, property; groups of rows: {elementId} lists the chosen options of a question, {subtotal: label}, {text}), tables to delete. Saves nothing; returns a token for apply_form_change.",
    inputSchema: {
      formId: z.number().int(),
      channels: z.object({ pdf: z.boolean(), excel: z.boolean(), checkout: z.boolean(), email: z.boolean() }).optional(),
      addTables: z.array(z.object({
        label: z.string().min(1).max(255), hiddenOn: hiddenSpec,
        columns: z.array(z.object({ field: z.enum(["label", "value", "name", "description", "sku", "quantity", "sales_price", "cost_price", "margin", "discount", "property"]), label: z.string().min(1), width: z.number().int().min(1).max(100).optional(), alignment: z.enum(["left", "center", "right"]).optional(), format: z.enum(["text", "currency", "percentage", "number", "markdown"]).optional(), propertyId: z.number().int().optional(), includeInSubtotal: z.boolean().optional(), hiddenOn: hiddenSpec })).min(1),
        groups: z.array(z.object({ label: z.string().min(1).max(255), hiddenOn: hiddenSpec, rows: z.array(z.object({ elementId: z.number().int().optional(), subtotal: z.string().optional(), text: z.string().optional(), showDescriptions: z.boolean().optional() })) })).min(1)
      })).optional(),
      removeTableIds: z.array(z.number().int()).optional()
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, wrap(async ({ formId, ...edit }) => admin.previewBom(formId, edit)));
  server.registerTool("preview_document_template", {
    title: "Preview a quote document template change (admin)",
    description: "Admins: plan a quote document template. create: name, outputFormat (pdf, docx, odt, xlsx, ods), filePath (a .docx, .xlsx, .odt, .ods or .html on this computer, max 5 MB), language slug, selectionMode (locked, selected, deselected), optional outputFilename, excludedFormIds, userIds. replace_file: id + filePath. remove: id. The current file is backed up first. Saves nothing; returns a token for apply_form_change.",
    inputSchema: { op: z.enum(["create", "replace_file", "remove"]), id: z.number().int().optional(), name: z.string().optional(), outputFormat: z.enum(["pdf", "docx", "odt", "xlsx", "ods"]).optional(), filePath: z.string().optional(), language: z.string().optional(), selectionMode: z.enum(["locked", "selected", "deselected"]).optional(), outputFilename: z.string().optional(), excludedFormIds: z.array(z.number().int()).optional(), userIds: z.array(z.number().int()).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, wrap(async ({ op, ...a }) => {
    if (op === "create" && (!a.name || !a.outputFormat || !a.filePath)) throw new Error("Give name, outputFormat and filePath.");
    if (op !== "create" && a.id == null) throw new Error("Give the template id.");
    return admin.previewDocumentTemplate(op, a);
  }));
  server.registerTool("preview_saved_expression", {
    title: "Preview a saved expression change (admin)",
    description: "Admins: plan a saved expression on a configurator (a named condition rules can reuse with {savedExpressionId}). create: name + expression (same tree as preview_create_rule's condition). update: id + name/description/expression. remove: id. Saves nothing; returns a token for apply_form_change.",
    inputSchema: { formId: z.number().int(), op: z.enum(["create", "update", "remove"]), id: z.number().int().optional(), name: z.string().optional(), description: z.string().optional(), expression: exprIn.optional() },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, wrap(async ({ formId, op, ...a }) => {
    if (a.expression !== void 0) a.expression = parseExpr(a.expression, "expression");
    if (op === "create" && !a.name) throw new Error("Give a name.");
    if (op !== "create" && a.id == null) throw new Error("Give the saved expression's id.");
    return admin.previewSavedExpression(formId, op, a);
  }));
  server.registerTool("preview_form_category", {
    title: "Preview a configurator category change (admin)",
    description: "Admins: plan a storefront category (level category, super or master): create, update (only the fields given change) or remove (refused while it holds configurators or sub-categories). imageId is a media library id. Assign configurators with preview_form_settings categoryIds. Saves nothing; returns a token for apply_form_change.",
    inputSchema: { level: z.enum(["category", "super", "master"]).optional(), op: z.enum(["create", "update", "remove"]), id: z.number().int().optional(), name: z.string().optional(), description: z.string().optional(), active: z.boolean().optional(), order: z.number().int().min(0).optional(), parentId: z.number().int().nullable().optional(), imageId: z.number().int().nullable().optional(), translation: z.record(z.string(), z.string()).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, wrap(async ({ level, op, ...a }) => {
    if (op !== "create" && a.id == null) throw new Error("Give the category id.");
    return admin.previewFormCategory(level ?? "category", op, a);
  }));
  server.registerTool("preview_media_upload", {
    title: "Preview uploading a file to the media library (admin)",
    description: "Admins: plan uploading a file from this computer (full path; pictures, 3D models, pdf/docx/xlsx documents, fonts; max 10 MB) to the media library, optionally into folderId. The answer of apply_form_change gives the new media id. Saves nothing now; returns a token.",
    inputSchema: { filePath: z.string(), folderId: z.number().int().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, wrap(async (a) => admin.previewMediaUpload(a.filePath, a.folderId)));
  server.registerTool("preview_media_delete", {
    title: "Preview deleting media (admin)",
    description: "Admins: plan deleting files from the media library by id. Saves nothing; returns a token for apply_form_change.",
    inputSchema: { ids: z.array(z.number().int()).min(1).max(100) },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, wrap(async (a) => admin.previewMediaDelete(a.ids)));
  server.registerTool("preview_user", {
    title: "Preview a user change (admin)",
    description: "Admins: plan a config-panel user: create (name, username, email, level customer/user/admin/super_admin; a random password nobody sees, they use Forgot password), update (only the fields given), or remove. Never touches passwords or the logged-in user. Saves nothing; returns a token for apply_form_change.",
    inputSchema: { op: z.enum(["create", "update", "remove"]), id: z.number().int().optional(), name: z.string().min(2).max(255).optional(), username: z.string().min(2).max(255).optional(), email: z.string().email().optional(), level: z.enum(["customer", "user", "admin", "super_admin"]).optional(), active: z.boolean().optional(), languageId: z.number().int().optional(), discountGroupId: z.number().int().nullable().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, wrap(async ({ op, ...a }) => {
    if (op !== "create" && a.id == null) throw new Error("Give the user's id.");
    return admin.previewUser(op, a);
  }));
  server.registerTool("preview_appearance", {
    title: "Preview appearance changes (admin)",
    description: "Admins: plan storefront appearance values: each change names a field (slug, id or label from read_appearance) and a value (colour #RRGGBB, text, number, true/false, or an option for select fields) or mediaIds for image, document and font fields. Other fields keep their values. Saves nothing; returns a token for apply_form_change.",
    inputSchema: { changes: z.array(z.object({ field: z.union([z.string(), z.number()]), value: z.union([z.string(), z.number(), z.boolean()]).optional(), mediaIds: z.array(z.number().int()).optional() })).min(1).max(50) },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, wrap(async (a) => admin.previewAppearance(a.changes)));
  server.registerTool(
    "trial_change",
    {
      title: "Try a previewed change locally",
      description: "Try a previewed configurator or rule change before saving it: runs the storefront's own form engine on this computer twice, on the live configurator and on the changed one, with the same answers, and reports what differs (questions shown or hidden, required, values set by rules, option visibility and prices, total, messages). Works for preview_form_edit, preview_create_configurator, preview_add_configurator_steps, preview_restore_form, preview_create_rule, preview_rule_switch and preview_remove_rule. Saves nothing; the token stays valid for apply_form_change.",
      inputSchema: {
        confirmationToken: z.string(),
        answers: z.array(answerSchema).max(50).optional().describe("Answers to set, as with set_answers; new questions can be named by label"),
        country: z.string().optional(),
        language: z.string().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    wrap(async (a) => runTrial(sessions, admin, a))
  );
  server.registerTool = reg;
  const syncEditTools = () => {
    // Always listed: some hosts read a plugin's tool list only once, at start, so tools switched on after the
    // login never reach them. Every edit tool refuses on its own while edits are off (requireEditsEnabled).
    for (const t of editTools) if (!t.enabled) t.enable();
  };
  syncEditTools();
  return syncEditTools;
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
var VERSION = true ? "0.6.5" : "dev";
var INSTRUCTIONS = `Tools for one Mercura config-panel (CPQ) installation: configure products, price them, and create quotes, look up quotes and the catalogue, and (for admins, when edits are switched on) change configurators.
- First, before anything else: call connection_status. If the user is not logged in yet it returns loginUrl, a login page on the user's own computer: send the user that link, then call connection_status with waitSeconds (e.g. 150); it answers as soon as they have logged in. A login the user chose to remember is restored automatically when the plugin starts.
- Never ask for, accept or repeat a username or password in the conversation. If the user pastes a password, do not use it; tell them to use the login link instead and to consider changing the password.
- A quote is built in a headless copy of the storefront: the configurator's own rules run, so visibility, required answers and prices are exactly what a shopper sees. Prices include VAT.
- Never submit a quote, save a configurator edit or restore a backup without showing the user what will happen and getting an explicit yes.
- Before applying a change to a configurator's questions, options, prices or rules, offer to try it with trial_change: it runs the storefront's own form engine on this computer on the changed configurator and saves nothing.`;
async function main() {
  const config = loadConfig();
  await restoreRememberedLogin(config).catch(() => false);
  const sessions = new SessionManager(config);
  const quote = new QuoteEngine(sessions);
  const admin = new AdminService(sessions);
  const server = new McpServer({ name: "config-panel", version: VERSION }, { instructions: INSTRUCTIONS });
  let syncEditTools = () => {
  };
  const loginPage = new LoginPage(sessions, () => syncEditTools());
  syncEditTools = registerTools(server, { sessions, quote, admin, loginPage });
  console.log = (...args) => console.warn(...args);
  await server.connect(new StdioServerTransport());
}
main().catch((error) => {
  console.warn(error);
  process.exit(1);
});
