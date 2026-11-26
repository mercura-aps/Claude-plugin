/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdminService } from "./admin/admin.ts";
import type { QuoteEngine } from "./engine/quote.ts";
import type { SessionManager } from "./session.ts";

type Deps = { sessions: SessionManager; quote: QuoteEngine; admin: AdminService };

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }] });
const fail = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
});

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (error) {
      return fail(error);
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

const answerSchema = z.object({
  element: z.union([z.string(), z.number()]).describe("Element id, Slug, or exact label"),
  value: z
    .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])), z.null()])
    .describe("Option id/Slug/label (a list for a checkbox), or the number/text to enter; null clears it"),
  quantities: z.record(z.string(), z.number()).optional().describe("Option id/label → quantity, for options with a quantity"),
});

const editSchema = z.object({
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
  price: z
    .object({ countryId: z.number().int(), amount: z.number() })
    .optional()
    .describe("Option sales price in one country, major units, VAT included. Country ids are in get_form_outline."),
  translation: z.record(z.string(), z.string()).optional().describe('Keys like "da_label", "de_sub_text"'),
});

export function registerTools(server: McpServer, { sessions, quote, admin }: Deps): void {
  const configId = (id?: number) => {
    if (id != null) return id;
    const ids = quote.configurationIds();
    if (!ids.length) throw new Error("This quote has no configuration yet. Call add_configuration.");
    return ids[ids.length - 1];
  };

  // ---------- connection ----------
  server.registerTool(
    "connection_status",
    {
      title: "Log in and show the connection",
      description:
        "Log in to config-panel with the login from the plugin's settings (the password is in the computer's secure storage) and show which config-panel, which user and level, and whether edits are on. Call this first in every conversation. If it fails, show the user its message: the login is fixed in /plugin → Mercura config-panel → Configure, never in the chat.",
      inputSchema: { again: z.boolean().optional().describe("Log in again even if already logged in") },
      annotations: READ,
    },
    wrap(async ({ again }: { again?: boolean }) => {
      await sessions.ensure({ force: again === true });
      const user = await admin.currentUser();
      return {
        loggedIn: true,
        tenant: sessions.config.origin,
        user,
        loggedInAt: sessions.loggedInAt,
        editsAllowed: sessions.config.allowEdits,
        quoteInProgress: quote.active ? quote.quoteOverview() : null,
      };
    }),
  );

  // ---------- configure & quote ----------
  server.registerTool(
    "list_configurators",
    {
      title: "List configurators",
      description: "The configurators (Forms) this user can open, with ids.",
      inputSchema: { page: z.number().int().min(1).optional() },
      annotations: READ,
    },
    wrap(async ({ page }: { page?: number }) => {
      const r = await sessions.json<any>("GET", `/api/forms?size=100&page=${page ?? 1}`);
      const rows = Array.isArray(r) ? r : r?.data ?? [];
      return {
        page: r?.current_page ?? 1,
        lastPage: r?.last_page ?? 1,
        configurators: rows.map((f: any) => ({ id: f.id, name: f.name, active: f.active !== 0 && f.active !== false, description: f.description ?? undefined })),
      };
    }),
  );

  server.registerTool(
    "start_quote",
    {
      title: "Start a quote",
      description:
        "Start a new quote (discards any quote in progress that was not saved as a draft). Optionally choose the country (prices and currency follow it) and language by slug, e.g. dk, de, en.",
      inputSchema: { country: z.string().optional(), language: z.string().optional() },
      annotations: LOCAL,
    },
    wrap(async ({ country, language }: { country?: string; language?: string }) => {
      await quote.start({ country, language });
      return { started: true, ...quote.quoteOverview() };
    }),
  );

  server.registerTool(
    "add_configuration",
    {
      title: "Add a configuration",
      description:
        "Open a configurator in the current quote. Returns its questions (elements), the options shoppers can pick now, the running total and what is still required. Starts a quote first if none is in progress.",
      inputSchema: { formId: z.number().int(), name: z.string().optional().describe("A name for this line, e.g. 'Kitchen wall'") },
      annotations: LOCAL,
    },
    wrap(async ({ formId, name }: { formId: number; name?: string }) => {
      if (!quote.active) await quote.start();
      const id = await quote.addConfiguration(formId, name);
      return quote.describe(id);
    }),
  );

  server.registerTool(
    "get_configuration",
    {
      title: "Read a configuration",
      description: "The current state of one configuration: questions, chosen values, options available now, messages from the configurator, total price and missing required answers.",
      inputSchema: {
        configurationId: z.number().int().optional().describe("Defaults to the last one added"),
        includeHidden: z.boolean().optional().describe("Also list what the configurator's rules hide right now"),
        maxOptions: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (a: { configurationId?: number; includeHidden?: boolean; maxOptions?: number }) =>
      quote.describe(configId(a.configurationId), { includeHidden: a.includeHidden, maxOptions: a.maxOptions }),
    ),
  );

  server.registerTool(
    "set_answers",
    {
      title: "Answer questions",
      description:
        "Set one or more answers in a configuration, exactly as a shopper would. The configurator's rules then run (they may show, hide, set or price other things). Returns notes on what the rules changed and the new state.",
      inputSchema: { configurationId: z.number().int().optional(), answers: z.array(answerSchema).min(1) },
      annotations: LOCAL,
    },
    wrap(async (a: { configurationId?: number; answers: any[] }) => {
      const id = configId(a.configurationId);
      const notes = await quote.setAnswers(id, a.answers);
      return { notes, ...quote.describe(id) };
    }),
  );

  server.registerTool(
    "set_configuration_quantity",
    {
      title: "Set how many",
      description: "How many of this configuration the quote includes (the line quantity).",
      inputSchema: { configurationId: z.number().int(), quantity: z.number().int().min(1) },
      annotations: LOCAL,
    },
    wrap(async (a: { configurationId: number; quantity: number }) => {
      quote.setConfigurationQuantity(a.configurationId, a.quantity);
      return quote.quoteOverview();
    }),
  );

  server.registerTool(
    "remove_configuration",
    {
      title: "Remove a configuration",
      description: "Take a configuration out of the quote in progress.",
      inputSchema: { configurationId: z.number().int() },
      annotations: LOCAL,
    },
    wrap(async (a: { configurationId: number }) => {
      quote.removeConfiguration(a.configurationId);
      return quote.quoteOverview();
    }),
  );

  server.registerTool(
    "get_quote_overview",
    {
      title: "Quote overview",
      description: "Every configuration in the quote in progress with its total, and the quote total (prices include VAT).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async () => quote.quoteOverview()),
  );

  server.registerTool(
    "get_request_fields",
    {
      title: "Quote details to fill in",
      description: "The customer name, e-mail and the Tenant's request fields (company, project, ...) the quote asks for, with current values.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async () => quote.requestFields()),
  );

  server.registerTool(
    "set_contact_details",
    {
      title: "Fill in quote details",
      description: "Set the customer's name and e-mail and request fields (by Slug, id or name) for the quote in progress.",
      inputSchema: {
        name: z.string().optional(),
        email: z.string().optional(),
        fields: z.record(z.string(), z.string()).optional(),
      },
      annotations: LOCAL,
    },
    wrap(async (a: { name?: string; email?: string; fields?: Record<string, string> }) => quote.setContactDetails(a)),
  );

  server.registerTool(
    "save_draft",
    {
      title: "Save as draft",
      description: "Save the quote in progress as a draft in config-panel (needs a login). Saving again updates the same draft.",
      inputSchema: { name: z.string().min(1) },
      annotations: WRITE,
    },
    wrap(async (a: { name: string }) => quote.saveDraft(a.name)),
  );

  server.registerTool(
    "open_draft",
    {
      title: "Open a draft",
      description: "Load a saved draft into a new quote in progress, with today's prices.",
      inputSchema: { draftId: z.number().int() },
      annotations: LOCAL,
    },
    wrap(async (a: { draftId: number }) => {
      await quote.start();
      const ids = await quote.openDraft(a.draftId);
      return { configurationIds: ids, ...quote.quoteOverview() };
    }),
  );

  server.registerTool(
    "copy_quote",
    {
      title: "Copy a quote",
      description: "Start a new quote in progress from a copy of a submitted quote (prices are recalculated).",
      inputSchema: { requestId: z.number().int() },
      annotations: LOCAL,
    },
    wrap(async (a: { requestId: number }) => {
      await quote.start();
      const ids = await quote.openCopyOfQuote(a.requestId);
      return { configurationIds: ids, ...quote.quoteOverview() };
    }),
  );

  server.registerTool(
    "submit_quote",
    {
      title: "Submit the quote",
      description:
        "Submit the quote in progress to config-panel. This creates the quote for real: config-panel stores it, renders its documents and may e-mail the customer and notify connected systems. Only call it after showing the user the overview and contact details and getting an explicit yes; pass confirmed: true.",
      inputSchema: { confirmed: z.literal(true).describe("The user explicitly confirmed submitting this quote") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap(async () => {
      const overview = quote.quoteOverview();
      const missing = overview.configurations.filter((c: any) => c.missingRequired.length);
      if (missing.length) {
        throw new Error(`Required answers are missing: ${missing.map((c: any) => `${c.name}: ${c.missingRequired.join(", ")}`).join("; ")}`);
      }
      const result = await quote.submit();
      return { submitted: true, ...result, total: overview.total, currency: overview.currency };
    }),
  );

  // ---------- quotes & catalogue ----------
  server.registerTool(
    "list_quotes",
    {
      title: "List quotes",
      description: "Submitted quotes, newest first (customers see their own; sellers and admins see the Tenant's).",
      inputSchema: { page: z.number().int().min(1).optional(), size: z.number().int().min(1).max(100).optional() },
      annotations: READ,
    },
    wrap(async (a: { page?: number; size?: number }) => {
      const r = await sessions.json<any>("GET", `/api/requests?size=${a.size ?? 25}&page=${a.page ?? 1}&direction=desc`);
      const rows = Array.isArray(r) ? r : r?.data ?? [];
      return {
        page: r?.current_page ?? a.page ?? 1,
        lastPage: r?.last_page,
        total: r?.total,
        quotes: rows.map((q: any) => ({
          id: q.id,
          name: q.name,
          email: q.email,
          status: q.status,
          total: q.conf_total,
          vat: q.vat_total,
          createdAt: q.created_at,
          configuration: q.configuration_name ?? q.configuration?.name,
        })),
      };
    }),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Read a quote",
      description: "One submitted quote: customer, request fields, totals (VAT included) and every configured line with its answers.",
      inputSchema: { requestId: z.number().int() },
      annotations: READ,
    },
    wrap(async (a: { requestId: number }) => {
      const r = await sessions.json<any>("GET", `/api/request/${a.requestId}/full`);
      return summarizeRequest(r?.data ?? r);
    }),
  );

  server.registerTool(
    "get_draft",
    {
      title: "Read a draft",
      description: "One saved draft with its configurations (raw, as config-panel stores it). Use open_draft to continue working on it.",
      inputSchema: { draftId: z.number().int() },
      annotations: READ,
    },
    wrap(async (a: { draftId: number }) => sessions.json("GET", `/api/form/draft/${a.draftId}`)),
  );

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "Products of the catalogue (SKU, name, prices, properties). Needs a seller or admin login.",
      inputSchema: { page: z.number().int().min(1).optional(), search: z.string().optional().describe("Filters by SKU or name on this page") },
      annotations: READ,
    },
    wrap(async (a: { page?: number; search?: string }) => {
      const r = await sessions.json<any>("GET", `/dashboard/api/products?per_page=50&page=${a.page ?? 1}`);
      let rows: any[] = Array.isArray(r) ? r : r?.data ?? [];
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
          prices: (p.prices ?? []).map((x: any) => ({ type: x.type, countryId: x.country_id, price: x.price })),
        })),
      };
    }),
  );

  server.registerTool(
    "get_localizations",
    {
      title: "Countries and languages",
      description: "The countries (with currency) and languages this config-panel offers. Prices include VAT and differ per country.",
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const [countries, languages] = await Promise.all([
        sessions.json<any>("GET", "/api/localization/countries"),
        sessions.json<any>("GET", "/api/localization/languages"),
      ]);
      return {
        countries: (Array.isArray(countries) ? countries : countries?.data ?? []).map((c: any) => ({ id: c.id, slug: c.slug, name: c.name, currency: c.currency?.code })),
        languages: (Array.isArray(languages) ? languages : languages?.data ?? []).map((l: any) => ({ id: l.id, slug: l.slug, name: l.name })),
      };
    }),
  );

  // ---------- admin: read ----------
  server.registerTool(
    "get_form_outline",
    {
      title: "Configurator structure (admin)",
      description: "Admins: the full structure of a configurator as stored, including hidden nodes, Slugs and option prices per country. Use it to find ids before an edit.",
      inputSchema: { formId: z.number().int() },
      annotations: READ,
    },
    wrap(async (a: { formId: number }) => admin.outline(a.formId)),
  );

  server.registerTool(
    "list_rules",
    {
      title: "Configurator rules (admin)",
      description: "Admins: a configurator's rules in run order: name, on/off, categories and what each effect acts on.",
      inputSchema: { formId: z.number().int() },
      annotations: READ,
    },
    wrap(async (a: { formId: number }) => admin.listRules(a.formId)),
  );

  server.registerTool(
    "get_rule",
    {
      title: "One rule (admin)",
      description: "Admins: one rule with its condition tree and effects, as config-panel stores it.",
      inputSchema: { formId: z.number().int(), ruleId: z.number().int() },
      annotations: READ,
    },
    wrap(async (a: { formId: number; ruleId: number }) => admin.getRule(a.formId, a.ruleId)),
  );

  if (!sessions.config.allowEdits) return;

  // ---------- admin: guarded edits ----------
  server.registerTool(
    "preview_form_edit",
    {
      title: "Preview a configurator edit (admin)",
      description:
        "Admins: plan changes to existing groups, elements and options (labels, help text, visible, required, limits, defaults, quantities, option prices, translations). Saves nothing: returns the exact changes and a confirmation token. Show the changes to the user; apply only after they say yes.",
      inputSchema: {
        formId: z.number().int(),
        edits: z.array(editSchema).min(1).max(50),
        reason: z.string().min(5).describe("Why, in the user's words"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async (a: { formId: number; edits: any[]; reason: string }) => admin.previewEdits(a.formId, a.edits, a.reason)),
  );

  server.registerTool(
    "preview_rule_switch",
    {
      title: "Preview switching a rule on or off (admin)",
      description: "Admins: plan switching one rule on or off. Saves nothing; returns a confirmation token.",
      inputSchema: { formId: z.number().int(), ruleId: z.number().int(), active: z.boolean(), reason: z.string().min(5) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async (a: { formId: number; ruleId: number; active: boolean; reason: string }) =>
      admin.previewRuleActive(a.formId, a.ruleId, a.active, a.reason),
    ),
  );

  server.registerTool(
    "list_form_backups",
    {
      title: "Configurator backups (admin)",
      description: "Backups this plugin took on this computer before each saved edit of a configurator, newest first.",
      inputSchema: { formId: z.number().int() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(async (a: { formId: number }) => ({ formId: a.formId, folder: admin.backupDir(a.formId), backups: admin.listBackups(a.formId) })),
  );

  server.registerTool(
    "preview_restore_form",
    {
      title: "Preview restoring a backup (admin)",
      description: "Admins: plan putting a configurator's structure back to a backup. Saves nothing; returns the differences and a confirmation token.",
      inputSchema: { formId: z.number().int(), backupId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async (a: { formId: number; backupId: string }) => admin.previewRestore(a.formId, a.backupId)),
  );

  server.registerTool(
    "apply_form_change",
    {
      title: "Apply a previewed change (admin)",
      description:
        "Admins: save a change previewed with preview_form_edit, preview_rule_switch or preview_restore_form. It changes the live configurator for every shopper. Call only after the user explicitly confirmed that preview. Backs the configurator up first and checks the result.",
      inputSchema: { confirmationToken: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    wrap(async (a: { confirmationToken: string }) => admin.apply(a.confirmationToken)),
  );
}

function summarizeRequest(d: any) {
  const req = d?.request ?? d;
  return {
    id: req?.id,
    name: req?.name,
    email: req?.email,
    status: req?.status,
    total: req?.conf_total,
    vatIncluded: req?.vat_total,
    createdAt: req?.created_at,
    requestFields: (req?.extra_fields ?? []).map((g: any) => ({
      group: g.name,
      fields: Object.fromEntries((g.fields ?? []).map((f: any) => [f.slug ?? f.name, f.value])),
    })),
    configuration: d?.configuration ? { id: d.configuration.id, name: d.configuration.name } : undefined,
    lines: (d?.form_submissions ?? []).map((s: any) => ({
      form: s.form?.name ?? s.form_id,
      quantity: s.quantity,
      price: s.price ?? s.total,
      answers: (s.form?.data?.elements ?? s.data?.elements ?? []).map((e: any) => ({
        element: e.label ?? e.slug,
        value: e.options?.length ? e.options.map((o: any) => (o.quantity && o.quantity !== 1 ? `${o.label} ×${o.quantity}` : o.label)) : e.value,
      })),
    })),
  };
}
