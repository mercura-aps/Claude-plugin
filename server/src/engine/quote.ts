// One quote in progress: Mercura's own frontend-form-sdk store, run headless, so that
// rules, visibility, prices and the submit payload are exactly the storefront's.
// One store holds every configuration of the quote (as the storefront does); starting
// a new quote resets it. Waiting logic adapted from mercura-aps/form-sdk-cli.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createSDKStore } from "@mercura-aps/frontend-form-sdk";
import type { SessionManager } from "../session.ts";
import { installGateway, gatewayLog } from "./gateway.ts";
import { installPolyfill } from "./polyfill.ts";

type Store = ReturnType<typeof createSDKStore>[0];
type State = ReturnType<Store["getState"]>;

const TIMEOUT_MS = 45_000;

export class EngineError extends Error {}

function waitFor<T>(
  store: Store,
  selector: (s: State) => T,
  predicate: (v: T) => boolean,
  label: string,
  failure?: (s: State) => string | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const unsubs: Array<() => void> = [];
    const finish = (err: Error | null, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubs.forEach((u) => u());
      if (err) reject(err);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new EngineError(`Timed out waiting for ${label}.`)), TIMEOUT_MS);
    unsubs.push((store as any).subscribe(selector, (v: T) => predicate(v) && finish(null, v)));
    if (failure) unsubs.push((store as any).subscribe(failure, (m: string | undefined) => m && finish(new EngineError(m))));
    const now = selector(store.getState());
    if (predicate(now)) return finish(null, now);
    const failed = failure?.(store.getState());
    if (failed) finish(new EngineError(failed));
  });
}

/** The SDK reports failures by console.error; collect them so a tool can say what went wrong. */
function captureSdkErrors() {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(
      args
        .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")
        .slice(0, 500),
    );
  };
  return { errors, restore: () => (console.error = original) };
}

const isShown = (active: unknown) => active !== 0 && active !== false;
const labelOf = (node: any): string => String(node?.label ?? node?.name ?? node?.id ?? "");
const slugOf = (node: any): string | undefined => {
  const v = node?.extra_fields?.slug;
  return typeof v === "string" && v ? v : undefined;
};

export type Answer = {
  /** Element id, Slug or exact label. */
  element: string | number;
  /** Option id/Slug/label (or a list for a checkbox); a number or text for input elements; null clears. */
  value: string | number | Array<string | number> | null;
  /** Option id/Slug/label → quantity, for options that allow a quantity. */
  quantities?: Record<string, number>;
};

export class QuoteEngine {
  #store: Store | null = null;
  readonly sessions: SessionManager;

  constructor(sessions: SessionManager) {
    this.sessions = sessions;
  }

  get store(): Store {
    if (!this.#store) throw new EngineError("No quote in progress. Call start_quote first.");
    return this.#store;
  }

  get active(): boolean {
    return this.#store !== null;
  }

  /** Start a new quote (resets any quote in progress). */
  async start(options: { country?: string; language?: string } = {}): Promise<void> {
    installPolyfill(this.sessions.config.origin);
    installGateway(this.sessions);
    if (this.#store) await this.#reset();
    const [store] = createSDKStore({ formSubstoreConfig: { debugMode: true } } as any);
    this.#store = store;
    const cap = captureSdkErrors();
    try {
      await waitFor(store, (s) => s.localizationSubstore.selectedCountry, Boolean, "the Tenant's countries", () =>
        cap.errors.find((e) => /401|Unauthorized|logged in/i.test(e))
          ? "config-panel answered that this user is not logged in. Call connection_status with again: true to log in again."
          : undefined,
      );
      const loc = store.getState().localizationSubstore as any;
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

  countries(): string[] {
    const loc = this.store.getState().localizationSubstore as any;
    const list = loc.availableCountries?.data ?? loc.countries ?? [];
    return (Array.isArray(list) ? list : []).map((c: any) => c.slug);
  }

  async #reset(): Promise<void> {
    const store = this.#store!;
    await new Promise<void>((resolve) => {
      const reset = (store.getState() as any).resetSubstore;
      reset.setAfterReset(() => resolve());
      reset.reset();
    });
    this.#store = null;
  }

  /** Add a configuration of a Form to the quote; resolves once its rules have run. */
  async addConfiguration(formId: number, name?: string): Promise<number> {
    const store = this.store;
    const cap = captureSdkErrors();
    try {
      const label = name ?? `Form ${formId}`;
      const configId = store.getState().configsSubstore.addConfig({
        formId,
        name: label,
        formName: label,
        configQuantity: 1,
      } as any);
      if (!configId) throw new EngineError(`Form id ${formId} is not valid.`);
      store.getState().configsSubstore.setCurrentConfigId(configId);
      await waitFor(
        store,
        (s) => s.formSubstore.fromConfigs[configId],
        (f: any) => Boolean(f && !f.isLoading && f.constraintsCheckedFormData && f.form),
        `form ${formId} to load`,
        (s) =>
          s.configsSubstore.configs.some((c) => c.id === configId)
            ? undefined
            : `Form ${formId} did not load: it does not exist on this Tenant, is inactive, or this user may not open it. ${cap.errors.join(" ")}`.trim(),
      );
      await this.#bomSettled(configId);
      const form = store.getState().formSubstore.fromConfigs[configId] as any;
      if (form?.form?.name && !name) store.getState().configsSubstore.updateConfig(configId, { name: form.form.name } as any);
      return configId;
    } finally {
      cap.restore();
    }
  }

  removeConfiguration(configId: number): void {
    this.#config(configId);
    this.store.getState().configsSubstore.removeConfig(configId);
  }

  setConfigurationQuantity(configId: number, quantity: number): void {
    this.#config(configId);
    this.store.getState().configsSubstore.updateConfig(configId, { configQuantity: quantity } as any);
  }

  #config(configId: number) {
    const config = this.store.getState().configsSubstore.configs.find((c) => c.id === configId);
    if (!config) throw new EngineError(`There is no configuration ${configId} in this quote.`);
    return config;
  }

  configurationIds(): number[] {
    return this.store.getState().configsSubstore.configs.map((c) => c.id);
  }

  async #bomSettled(configId: number) {
    await waitFor(
      this.store,
      (s) => (s as any).bomSubstore.bomConfigs[configId]?.bomConfig,
      (b: any) => Boolean(b && !b.isLoading),
      "the bill of materials",
    );
  }

  #elements(configId: number): any[] {
    const data = (this.store.getState().formSubstore.fromConfigs[configId] as any)?.constraintsCheckedFormData;
    if (!data) throw new EngineError(`Configuration ${configId} has not loaded.`);
    const out: any[] = [];
    for (const el of data.elements ?? []) out.push(el);
    for (const g of data.groups ?? []) for (const el of g.elements ?? []) out.push({ ...el, __group: g });
    return out;
  }

  #findElement(configId: number, ref: string | number): any {
    const els = this.#elements(configId);
    const key = String(ref).trim();
    const hit =
      els.find((e) => String(e.id) === key) ??
      els.find((e) => slugOf(e) === key) ??
      els.filter((e) => String(e.label ?? "").toLowerCase() === key.toLowerCase());
    if (Array.isArray(hit)) {
      if (hit.length === 1) return hit[0];
      if (hit.length > 1) throw new EngineError(`"${key}" matches ${hit.length} elements (${hit.map((e) => e.id).join(", ")}); use the id.`);
      throw new EngineError(`No element "${key}" in configuration ${configId}. Read the configuration to see the elements and their ids.`);
    }
    return hit;
  }

  #findOption(element: any, ref: string | number): any {
    const key = String(ref).trim();
    const opts: any[] = element.options ?? [];
    const hit =
      opts.find((o) => String(o.id) === key) ??
      opts.find((o) => slugOf(o) === key || o.attribute_slug === key) ??
      opts.filter((o) => labelOf(o).toLowerCase() === key.toLowerCase());
    const found = Array.isArray(hit) ? (hit.length === 1 ? hit[0] : undefined) : hit;
    if (!found) {
      throw new EngineError(
        `"${key}" is not an option of "${element.label}" (${element.id}). Options: ${opts
          .filter((o) => isShown(o.active))
          .slice(0, 30)
          .map((o) => `${o.id} ${labelOf(o)}`)
          .join("; ")}`,
      );
    }
    if (!isShown(found.active)) throw new EngineError(`Option "${labelOf(found)}" of "${element.label}" is hidden by the configurator's rules right now.`);
    return found;
  }

  /** Apply answers, then wait for the rules to run. Returns a list of notes on what changed. */
  async setAnswers(configId: number, answers: Answer[]): Promise<string[]> {
    const store = this.store;
    this.#config(configId);
    const current = store.getState().valuesSubstore.valuesConfigs[configId];
    if (!current) throw new EngineError(`Configuration ${configId} has not loaded.`);
    const values: Record<string, string[]> = { ...current.values };
    const quantities: Record<string, Record<string, number>> = structuredClone(current.quantities ?? {});
    const notes: string[] = [];

    for (const answer of answers) {
      const el = this.#findElement(configId, answer.element);
      if (!isShown(el.active)) throw new EngineError(`"${el.label}" (${el.id}) is hidden by the configurator's rules right now.`);
      if (el.state === "disabled" || el.state === "readonly") throw new EngineError(`"${el.label}" (${el.id}) is read-only: the configurator sets it.`);
      const id = String(el.id);
      const raw = answer.value;
      if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
        values[id] = [];
        continue;
      }
      if (["select", "radio", "checkbox"].includes(el.type) || (el.options?.length && !["text", "number", "range"].includes(el.type))) {
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
        quantities[id] = { ...(quantities[id] ?? {}), [String(opt.id)]: Math.round(qty) };
      }
    }

    const before = JSON.stringify([current.values, current.quantities]);
    if (before === JSON.stringify([values, quantities])) return ["Nothing changed."];
    const beforeDebug = (store.getState().formSubstore.fromConfigs[configId] as any)?.debugHistory?.at(-1)?.id ?? 0;
    const cap = captureSdkErrors();
    try {
      store.getState().valuesSubstore.setValues(configId, values);
      store.getState().valuesSubstore.setQuantities(configId, quantities);
      // In debug mode the SDK appends to debugHistory after every rules pass.
      await waitFor(
        store,
        (s) => s.formSubstore.fromConfigs[configId] as any,
        (f) => Boolean(f && !f.isLoading && f.constraintsCheckedFormData && (f.debugHistory?.at(-1)?.id ?? 0) !== beforeDebug),
        "the configurator's rules",
      );
      await this.#bomSettled(configId);
    } finally {
      cap.restore();
    }
    if (cap.errors.length) notes.push(`The configurator reported: ${cap.errors.slice(0, 3).join(" | ")}`);
    // Report values the rules changed or cleared after the answers.
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
  describe(configId: number, options: { includeHidden?: boolean; maxOptions?: number } = {}) {
    const state = this.store.getState() as any;
    const config = this.#config(configId) as any;
    const form = state.formSubstore.fromConfigs[configId];
    const vals = state.valuesSubstore.valuesConfigs[configId] ?? { values: {}, quantities: {} };
    const maxOptions = options.maxOptions ?? 40;
    const nf = state.numberFormatterSubstore;
    const fmt = (n: unknown) => {
      try {
        return typeof n === "number" ? nf.getPriceFormatter()?.format(n) ?? String(n) : undefined;
      } catch {
        return String(n);
      }
    };
    const messages: Array<{ on: string; type: string; message: string }> = [];
    for (const kind of ["groups", "elements", "options"] as const) {
      for (const [id, list] of Object.entries(form?.messages?.[kind] ?? {})) {
        for (const m of list as any[]) if (m?.message) messages.push({ on: `${kind.slice(0, -1)} ${id}`, type: m.type, message: m.message });
      }
    }
    const describeElement = (el: any) => {
      const id = String(el.id);
      const selected: string[] = vals.values?.[id] ?? [];
      const out: Record<string, unknown> = {
        id: Number(el.id),
        label: el.label,
        type: el.type,
      };
      const slug = slugOf(el);
      if (slug) out.slug = slug;
      if (el.state === "required") out.required = true;
      if (el.state === "disabled" || el.state === "readonly") out.readonly = true;
      if (!isShown(el.active)) out.hidden = true;
      if (el.sub_text) out.help = String(el.sub_text).replace(/<[^>]+>/g, "").slice(0, 200);
      if (el.options?.length) {
        const visible = (el.options as any[]).filter((o) => options.includeHidden || isShown(o.active));
        out.value = selected.map((s) => {
          const o = (el.options as any[]).find((x) => String(x.id) === s);
          const q = vals.quantities?.[id]?.[s];
          return { id: Number(s), label: o ? labelOf(o) : s, ...(q != null && q !== 1 ? { quantity: q } : {}) };
        });
        out.options = visible.slice(0, maxOptions).map((o) => ({
          id: Number(o.id),
          label: labelOf(o),
          ...(slugOf(o) ? { slug: slugOf(o) } : {}),
          ...(typeof o.price === "number" && o.price !== 0 ? { price: o.price } : {}),
          ...(o.allow_quantity ? { quantity: [o.min_quantity, o.max_quantity] } : {}),
          ...(!isShown(o.active) ? { hidden: true } : {}),
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
    const sections: any[] = [];
    if (data.elements?.length) {
      sections.push({
        label: "(no group)",
        elements: data.elements.filter((e: any) => options.includeHidden || isShown(e.active)).map(describeElement),
      });
    }
    for (const g of data.groups ?? []) {
      if (!options.includeHidden && !isShown(g.active)) continue;
      sections.push({
        id: g.id,
        label: g.label,
        ...(g.is_repeatable ? { repeatable: true, note: "Repeatable group: lines are not editable through this plugin yet." } : {}),
        elements: (g.elements ?? []).filter((e: any) => options.includeHidden || isShown(e.active)).map(describeElement),
      });
    }
    let total: number | null = null;
    let vat: number | null = null;
    try {
      total = nf.calculateConfigPrice({ configId, multiplyConfigQuantity: true });
      vat = nf.calculateConfigVat({ configId, multiplyConfigQuantity: true });
    } catch {
      // unknown
    }
    return {
      configurationId: configId,
      form: form?.form ? { id: form.form.id, name: form.form.name } : null,
      quantity: config.configQuantity,
      status: config.status,
      missingRequired: (config.missingRequiredElements ?? []).map((m: any) => ({ id: Number(m.id), label: m.label })),
      total: total == null ? null : { amount: total, formatted: fmt(total), vatIncluded: vat, vatFormatted: fmt(vat) },
      currency: state.localizationSubstore.selectedCountry?.currency?.code,
      messages,
      sections,
    };
  }

  quoteOverview() {
    const state = this.store.getState() as any;
    const configs = state.configsSubstore.configs.map((c: any) => {
      let total: number | null = null;
      try {
        total = state.numberFormatterSubstore.calculateConfigPrice({ configId: c.id, multiplyConfigQuantity: true });
      } catch {
        // unknown
      }
      return {
        configurationId: c.id,
        name: c.name,
        formId: c.formId,
        quantity: c.configQuantity,
        status: c.status,
        missingRequired: (c.missingRequiredElements ?? []).map((m: any) => m.label),
        total,
      };
    });
    const loc = state.localizationSubstore;
    return {
      country: loc.selectedCountry?.slug,
      language: loc.selectedLanguage?.slug,
      currency: loc.selectedCountry?.currency?.code,
      draftId: state.submitSubstore.draftId ?? null,
      configurations: configs,
      total: configs.reduce((s: number, c: any) => s + (c.total ?? 0), 0),
      pricesIncludeVat: true,
    };
  }

  /** The quote step's request fields (customer, project, ...) with their current values. */
  async requestFields() {
    const store = this.store;
    await waitFor(
      store,
      (s) => (s as any).contactDetailsSubstore.requestFieldsData,
      (d: any) => Boolean(d && !d.isLoading),
      "request fields",
    );
    const cd = (store.getState() as any).contactDetailsSubstore;
    const fields = cd.requestFieldsData?.data ?? [];
    return {
      name: cd.fixedContactDetails.find((d: any) => d.id === "name")?.value ?? "",
      email: cd.fixedContactDetails.find((d: any) => d.id === "email")?.value ?? "",
      groups: fields.map((g: any) => ({
        id: g.id,
        name: g.name,
        fields: (g.fields ?? [])
          .filter((f: any) => f.mode !== "hidden")
          .map((f: any) => ({
            id: f.id,
            slug: f.slug,
            name: f.name,
            type: f.type,
            required: Boolean(f.required),
            ...(f.options ? { options: f.options } : {}),
            value: cd.requestFieldsValues?.[g.id]?.[f.id] ?? cd.requestFieldsValues?.[String(g.id)]?.[String(f.id)] ?? "",
          })),
      })),
      errors: cd.requestFieldsErrors,
    };
  }

  async setContactDetails(input: { name?: string; email?: string; fields?: Record<string, string> }) {
    const store = this.store;
    const cd = () => (store.getState() as any).contactDetailsSubstore;
    if (input.name != null) cd().setFixedContactDetailsValue({ id: "name", value: input.name });
    if (input.email != null) cd().setFixedContactDetailsValue({ id: "email", value: input.email });
    if (input.fields && Object.keys(input.fields).length) {
      const groups = (await this.requestFields()).groups;
      for (const [key, value] of Object.entries(input.fields)) {
        const hits = groups.flatMap((g: any) =>
          g.fields
            .filter((f: any) => f.slug === key || String(f.id) === key || String(f.name).toLowerCase() === key.toLowerCase())
            .map((f: any) => ({ g, f })),
        );
        if (hits.length !== 1) throw new EngineError(hits.length ? `"${key}" matches several request fields; use "<group id>.<field id>".` : `No request field "${key}".`);
        cd().setSubFieldValue({ requestFieldId: hits[0].g.id, requestSubFieldId: hits[0].f.id, value: String(value) });
      }
    }
    return this.requestFields();
  }

  async saveDraft(name: string): Promise<{ draftId: number | null; type: string }> {
    const store = this.store;
    const sub = () => (store.getState() as any).submitSubstore;
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

  async openDraft(draftId: number): Promise<number[]> {
    const store = this.store;
    const cap = captureSdkErrors();
    try {
      const r = await (store.getState() as any).submitSubstore.openFromDraft(draftId);
      if (!r?.ok) throw new EngineError(`Could not open draft ${draftId}. ${cap.errors.join(" ")}`.trim());
      const ids = this.configurationIds();
      for (const id of ids) {
        await waitFor(
          store,
          (s) => s.formSubstore.fromConfigs[id] as any,
          (f) => Boolean(f && !f.isLoading && f.constraintsCheckedFormData),
          `configuration ${id}`,
        );
      }
      return ids;
    } finally {
      cap.restore();
    }
  }

  async openCopyOfQuote(requestId: number): Promise<number[]> {
    const store = this.store;
    const cap = captureSdkErrors();
    try {
      const r = await (store.getState() as any).submitSubstore.openFromRequestCopy(requestId);
      if (!r?.ok) throw new EngineError(`Could not open a copy of quote ${requestId}. ${cap.errors.join(" ")}`.trim());
      return this.configurationIds();
    } finally {
      cap.restore();
    }
  }

  /** Submit the quote. The backend re-checks rules and computes the stored total. */
  async submit() {
    const store = this.store;
    const sub = () => (store.getState() as any).submitSubstore;
    await waitFor(store, (s) => (s as any).submitSubstore.isSubmitEnabled, Boolean, "the quote to be ready to submit").catch(() => {
      const fields = (store.getState() as any).contactDetailsSubstore;
      const missing = [
        ...fields.fixedContactDetails.filter((d: any) => d.error).map((d: any) => `${d.id} (${d.error})`),
        ...Object.keys(fields.requestFieldsErrors ?? {}).length ? ["request fields: " + JSON.stringify(fields.requestFieldsErrors)] : [],
      ];
      throw new EngineError(`The quote is not ready to submit. ${missing.join("; ")}`);
    });
    gatewayLog.lastWrite = undefined;
    const cap = captureSdkErrors();
    try {
      const r = await sub().submit();
      const answer = gatewayLog.lastWrite as { status: number; body: any } | undefined;
      if (!r?.ok) {
        const reason = sub().errorSubmit ?? (answer ? JSON.stringify(answer.body).slice(0, 800) : cap.errors.join(" "));
        throw new EngineError(`config-panel refused the quote${answer ? ` (HTTP ${answer.status})` : ""}: ${reason}`);
      }
      const body = answer?.body ?? {};
      return {
        requestId: body.request_id ?? body.id ?? body.data?.id ?? body.request?.id ?? null,
        pdfUrl: r.pdfUrl ?? null,
        documents: (r.documents ?? []).map((d: any) => ({ filename: d.filename, url: d.url })),
        documentUrls: r.documentUrls ?? [],
      };
    } finally {
      cap.restore();
    }
  }
}
