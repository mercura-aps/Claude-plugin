/**
 * Surgical form-builder edits.
 *
 * config-panel has no per-group endpoint. POST /dashboard/api/form/{id} replaces the
 * whole structure and deletes anything omitted. These helpers turn an admin GET into
 * a POST body, change one group or element, and keep every other id.
 */

// Vendored from mercura-aps/mercura-cowork src/mcp/form-patch.ts (Mercura's own, tested
// conversion of the admin form GET into the whole-form POST body). Keep in step with it.

type UsageBucket = Record<string, { constraints?: number[]; saved_expressions?: number[] } | undefined>;

export function readUsageSlice(
  usage: Record<string, unknown>,
  kind: "groups" | "elements" | "options",
  entityId: number,
): { constraintIds: number[]; savedExpressionIds: number[] } {
  const bucket = usage[kind] as UsageBucket | undefined;
  if (!bucket) return { constraintIds: [], savedExpressionIds: [] };
  const entry = bucket[String(entityId)];
  return {
    constraintIds: [...new Set((entry?.constraints ?? []).map(Number).filter(Number.isFinite))],
    savedExpressionIds: [...new Set((entry?.saved_expressions ?? []).map(Number).filter(Number.isFinite))],
  };
}

const TRANSLATION_KEY = /^[a-zA-Z]{2}_.+$/;

export type PostablePrice = {
  id: number | null;
  country_id: unknown;
  price: unknown;
  vat_id: unknown;
  type: string;
};

export type PostableOption = {
  id: number;
  label: unknown;
  active: unknown;
  order: unknown;
  is_default: unknown;
  sub_text: unknown;
  translation: unknown;
  extra_fields: unknown;
  allow_quantity: unknown;
  allow_dynamic_pricing: unknown;
  min_quantity: unknown;
  max_quantity: unknown;
  images: number[];
  models_3d: number[];
  prices: PostablePrice[];
  products: Array<{ id: number }>;
  discount_groups: Array<{ id: number; pivot: { price_change: unknown } }>;
  documentation_ids: number[];
};

export type PostableElement = {
  id: number;
  label: string;
  type: string;
  active: unknown;
  state: string;
  order: unknown;
  placeholder: unknown;
  min: unknown;
  max: unknown;
  step: unknown;
  format: unknown;
  default_value: unknown;
  sub_text: unknown;
  translation: unknown;
  price_type: string;
  dynamic_product_operator: unknown;
  multiplier: unknown;
  extra_fields: unknown;
  images: number[];
  models_3d: number[];
  options: PostableOption[];
  productProperties: Array<{ id: number }>;
  productPropertyAttributes: Array<{ id: number }>;
  form_group_id: number | null;
};

export type PostableGroup = {
  id: number;
  label: string;
  active: unknown;
  order: unknown;
  type: string;
  /** config-panel 1.102.0. Required on every group in a structure POST. */
  is_repeatable: boolean;
  min_instances: number;
  max_instances: number | null;
  description: unknown;
  extra_fields: unknown;
  translation: unknown;
  data: unknown;
  images: number[];
  elements: PostableElement[];
};

export type PostableForm = {
  groups: PostableGroup[];
  elements: PostableElement[];
};

export type ExtraFields = Record<string, string | number | boolean | null>;

export type GroupPatchInput = {
  op: "upsert" | "remove";
  groupId?: number;
  label?: string;
  active?: boolean;
  order?: number;
  type?: "default" | "price_based_on_combinations";
  description?: string | null;
  /** End-user can add copies of this group. False clears min/max. */
  isRepeatable?: boolean;
  /** Copies the end-user must keep. Only with isRepeatable true. 0–65535. */
  minInstances?: number;
  /** Copy cap. null means no limit. Only with isRepeatable true. Must be >= minInstances. */
  maxInstances?: number | null;
  slug?: string;
  extraFields?: ExtraFields;
  translation?: Record<string, string>;
};

export type ElementPatchInput = {
  op: "upsert" | "remove";
  elementId?: number;
  groupId?: number;
  ungrouped?: boolean;
  label?: string;
  type?: "text" | "number" | "range" | "select" | "radio" | "checkbox";
  state?: "required" | "open" | "disabled";
  active?: boolean;
  order?: number;
  slug?: string;
  extraFields?: ExtraFields;
  translation?: Record<string, string>;
  placeholder?: string | null;
  subText?: string | null;
  defaultValue?: string | number | null;
  min?: number | null;
  max?: number | null;
  step?: string | number | null;
  format?: string | null;
  priceType?: "none" | "addition" | "multiplier";
  multiplier?: number | null;
  dynamicProductOperator?: "and" | "or" | null;
  productPropertyIds?: number[];
};

export type DeleteTarget = { kind: "groups" | "elements" | "options"; id: number };

export type FormEdit = {
  data: PostableForm;
  created: boolean;
  removed: boolean;
  /** Negative while the row has not been saved. */
  id: number;
  label: string;
  order: number | null;
  groupId: number | null;
  deleteTargets: DeleteTarget[];
};

export function toPostableForm(admin: unknown): PostableForm {
  const root = asRecord(admin);
  if (!Array.isArray(root.groups)) {
    throw new Error("Admin form payload has no groups array. Refusing to save a partial structure.");
  }
  return {
    groups: root.groups.map((group) => toPostableGroup(group)),
    elements: asArray(root.elements).map((element) => toPostableElement(element, null)),
  };
}

export function patchFormGroup(admin: unknown, input: GroupPatchInput): FormEdit {
  const data = toPostableForm(admin);
  if (input.op === "remove") {
    if (input.groupId == null) throw new Error("Removing a group requires groupId.");
    const index = data.groups.findIndex((group) => group.id === input.groupId);
    if (index < 0) throw new Error(`Group ${input.groupId} not found on this form.`);
    const [removed] = data.groups.splice(index, 1);
    return editFromGroup(data, removed, false, true, deleteTargetsForGroup(removed));
  }

  assertTranslation(input.translation);
  if (input.groupId == null) {
    if (!input.label?.trim()) throw new Error("Adding a group requires label.");
    if (!input.slug?.trim() && !input.extraFields?.slug) throw new Error("Adding a group requires slug (extra_fields.slug).");
    const group: PostableGroup = {
      id: -1,
      label: input.label,
      active: input.active ?? true,
      order: input.order ?? nextOrder(data.groups.map((group) => group.order)),
      type: input.type ?? "default",
      is_repeatable: false,
      min_instances: 0,
      max_instances: null,
      description: input.description ?? null,
      extra_fields: mergeExtra(null, input.extraFields, input.slug),
      translation: mergeTranslation(null, input.translation),
      data: null,
      images: [],
      elements: [],
    };
    applyRepeatable(group, input, true);
    data.groups.push(group);
    return editFromGroup(data, group, true, false, []);
  }

  const group = data.groups.find((candidate) => candidate.id === input.groupId);
  if (!group) throw new Error(`Group ${input.groupId} not found on this form.`);
  if (!hasGroupPatch(input)) throw new Error("Nothing to update. Pass at least one group field.");
  if (input.label !== undefined) group.label = input.label;
  if (input.active !== undefined) group.active = input.active;
  if (input.order !== undefined) group.order = input.order;
  if (input.type !== undefined) group.type = input.type;
  if (input.description !== undefined) group.description = input.description;
  if (input.isRepeatable !== undefined || input.minInstances !== undefined || input.maxInstances !== undefined) {
    applyRepeatable(group, input, false);
  }
  if (input.translation !== undefined) group.translation = mergeTranslation(group.translation, input.translation);
  if (input.slug !== undefined || input.extraFields !== undefined) {
    group.extra_fields = mergeExtra(group.extra_fields, input.extraFields, input.slug);
  }
  return editFromGroup(data, group, false, false, []);
}

export function patchFormElement(admin: unknown, input: ElementPatchInput): FormEdit {
  const data = toPostableForm(admin);
  if (input.op === "remove") {
    if (input.elementId == null) throw new Error("Removing an element requires elementId.");
    const located = locateElement(data, input.elementId);
    if (!located) throw new Error(`Element ${input.elementId} not found on this form.`);
    const [removed] = located.list.splice(located.index, 1);
    return editFromElement(data, removed, false, true, deleteTargetsForElement(removed));
  }

  if (input.groupId != null && input.ungrouped) {
    throw new Error("Pass groupId or ungrouped, not both.");
  }
  assertTranslation(input.translation);

  if (input.elementId == null) {
    if (!input.label?.trim()) throw new Error("Adding an element requires label.");
    if (!input.type) throw new Error("Adding an element requires type.");
    if (!input.slug?.trim() && !input.extraFields?.slug) throw new Error("Adding an element requires slug (extra_fields.slug).");
    const parent = input.groupId == null ? null : requireGroup(data, input.groupId);
    const siblings = parent ? parent.elements : data.elements;
    const element = blankElement({
      id: -1,
      label: input.label,
      type: input.type,
      formGroupId: parent ? parent.id : null,
      order: input.order ?? nextOrder(siblings.map((element) => element.order)),
    });
    applyElementPatch(element, input);
    siblings.push(element);
    return editFromElement(data, element, true, false, []);
  }

  const located = locateElement(data, input.elementId);
  if (!located) throw new Error(`Element ${input.elementId} not found on this form.`);
  if (!hasElementPatch(input)) throw new Error("Nothing to update. Pass at least one element field.");
  const element = located.element;
  applyElementPatch(element, input);
  if (input.ungrouped || input.groupId != null) {
    const parent = input.ungrouped ? null : requireGroup(data, input.groupId as number);
    const nextGroupId = parent ? parent.id : null;
    if (located.groupId !== nextGroupId) {
      located.list.splice(located.index, 1);
      element.form_group_id = nextGroupId;
      (parent ? parent.elements : data.elements).push(element);
    }
  }
  return editFromElement(data, element, false, false, []);
}

export function structureDeleteBlockers(
  usage: Record<string, unknown>,
  targets: DeleteTarget[],
): { constraints: number[]; savedExpressions: number[] } {
  const constraints = new Set<number>();
  const savedExpressions = new Set<number>();
  for (const target of targets) {
    if (target.id <= 0) continue;
    const slice = readUsageSlice(usage, target.kind, target.id);
    for (const id of slice.constraintIds) constraints.add(id);
    for (const id of slice.savedExpressionIds) savedExpressions.add(id);
  }
  return {
    constraints: [...constraints].sort((a, b) => a - b),
    savedExpressions: [...savedExpressions].sort((a, b) => a - b),
  };
}

export function formatStructureDeleteBlock(block: { constraints: number[]; savedExpressions: number[] }): string | null {
  if (block.constraints.length === 0 && block.savedExpressions.length === 0) return null;
  const parts: string[] = [];
  if (block.constraints.length > 0) parts.push(`rules ${block.constraints.join(", ")}`);
  if (block.savedExpressions.length > 0) parts.push(`saved expressions ${block.savedExpressions.join(", ")}`);
  return `Cannot remove this while ${parts.join(" and ")} still reference it. Remove those effects or rules first, then retry.`;
}

export function collectGroupIds(form: { groups?: Array<{ id?: unknown; elements?: unknown[] }> }): number[] {
  return asArray(form.groups).map((group) => numberId(asRecord(group).id)).filter((id) => id > 0);
}

export function collectElementIds(form: {
  groups?: Array<{ elements?: unknown[] }>;
  elements?: unknown[];
}): number[] {
  const ids = new Set<number>();
  for (const element of asArray(form.elements)) {
    const id = numberId(asRecord(element).id);
    if (id > 0) ids.add(id);
  }
  for (const group of asArray(form.groups)) {
    for (const element of asArray(asRecord(group).elements)) {
      const id = numberId(asRecord(element).id);
      if (id > 0) ids.add(id);
    }
  }
  return [...ids];
}

export function createdId(before: number[], after: number[]): number {
  const known = new Set(before);
  const created = after.filter((id) => id > 0 && !known.has(id));
  if (created.length !== 1) {
    throw new Error(`Expected one new id after save, found ${created.length}${created.length ? `: ${created.join(", ")}` : ""}.`);
  }
  return created[0];
}

function editFromGroup(
  data: PostableForm,
  group: PostableGroup,
  created: boolean,
  removed: boolean,
  deleteTargets: DeleteTarget[],
): FormEdit {
  return {
    data,
    created,
    removed,
    id: group.id,
    label: group.label,
    order: numberOrNull(group.order),
    groupId: group.id,
    deleteTargets,
  };
}

function editFromElement(
  data: PostableForm,
  element: PostableElement,
  created: boolean,
  removed: boolean,
  deleteTargets: DeleteTarget[],
): FormEdit {
  return {
    data,
    created,
    removed,
    id: element.id,
    label: element.label,
    order: numberOrNull(element.order),
    groupId: element.form_group_id,
    deleteTargets,
  };
}

function deleteTargetsForGroup(group: PostableGroup): DeleteTarget[] {
  const targets: DeleteTarget[] = [{ kind: "groups", id: group.id }];
  for (const element of group.elements) targets.push(...deleteTargetsForElement(element));
  return targets;
}

function deleteTargetsForElement(element: PostableElement): DeleteTarget[] {
  return [
    { kind: "elements", id: element.id },
    ...element.options.map((option) => ({ kind: "options" as const, id: option.id })),
  ];
}

function blankElement(input: {
  id: number;
  label: string;
  type: PostableElement["type"];
  formGroupId: number | null;
  order: number;
}): PostableElement {
  return {
    id: input.id,
    label: input.label,
    type: input.type,
    active: true,
    state: "open",
    order: input.order,
    placeholder: null,
    min: null,
    max: null,
    step: null,
    format: null,
    default_value: null,
    sub_text: null,
    translation: null,
    price_type: "none",
    dynamic_product_operator: null,
    multiplier: null,
    extra_fields: null,
    images: [],
    models_3d: [],
    options: [],
    productProperties: [],
    productPropertyAttributes: [],
    form_group_id: input.formGroupId,
  };
}

function applyElementPatch(element: PostableElement, input: ElementPatchInput): void {
  if (input.label !== undefined) element.label = input.label;
  if (input.type !== undefined) element.type = input.type;
  if (input.state !== undefined) element.state = input.state;
  if (input.active !== undefined) element.active = input.active;
  if (input.order !== undefined) element.order = input.order;
  if (input.placeholder !== undefined) element.placeholder = input.placeholder;
  if (input.subText !== undefined) element.sub_text = input.subText;
  if (input.defaultValue !== undefined) element.default_value = input.defaultValue;
  if (input.min !== undefined) element.min = input.min;
  if (input.max !== undefined) element.max = input.max;
  if (input.step !== undefined) element.step = input.step;
  if (input.format !== undefined) element.format = input.format;
  if (input.priceType !== undefined) element.price_type = input.priceType;
  if (input.multiplier !== undefined) element.multiplier = input.multiplier;
  if (input.dynamicProductOperator !== undefined) element.dynamic_product_operator = input.dynamicProductOperator;
  if (input.translation !== undefined) element.translation = mergeTranslation(element.translation, input.translation);
  if (input.slug !== undefined || input.extraFields !== undefined) {
    element.extra_fields = mergeExtra(element.extra_fields, input.extraFields, input.slug);
  }
  if (input.productPropertyIds !== undefined) {
    element.productProperties = input.productPropertyIds.map((id) => ({ id }));
  }
}

function repeatableFromAdmin(group: Record<string, unknown>): Pick<PostableGroup, "is_repeatable" | "min_instances" | "max_instances"> {
  const flag = group.is_repeatable;
  const isRepeatable = flag === true || flag === 1 || flag === "1";
  if (!isRepeatable) return { is_repeatable: false, min_instances: 0, max_instances: null };
  return {
    is_repeatable: true,
    min_instances: countOr(group.min_instances, 0),
    max_instances: group.max_instances == null || group.max_instances === "" ? null : countOr(group.max_instances, 0),
  };
}

function countOr(value: unknown, fallback: number): number {
  const count = Number(value);
  return Number.isInteger(count) ? count : fallback;
}

function applyRepeatable(group: PostableGroup, input: GroupPatchInput, creating: boolean): void {
  const isRepeatable = input.isRepeatable ?? (creating ? false : group.is_repeatable);
  if (!isRepeatable) {
    if ((input.minInstances !== undefined && input.minInstances !== 0) || (input.maxInstances !== undefined && input.maxInstances != null)) {
      throw new Error("minInstances and maxInstances apply only when isRepeatable is true. Pass isRepeatable false to clear them (min_instances 0, max_instances null).");
    }
    group.is_repeatable = false;
    group.min_instances = 0;
    group.max_instances = null;
    return;
  }
  const min = input.minInstances ?? (creating ? 0 : group.min_instances);
  const max = input.maxInstances !== undefined ? input.maxInstances : (creating ? null : group.max_instances);
  if (!Number.isInteger(min) || min < 0 || min > 65535) {
    throw new Error("minInstances must be an integer from 0 to 65535.");
  }
  if (max != null && (!Number.isInteger(max) || max < 0 || max > 65535)) {
    throw new Error("maxInstances must be an integer from 0 to 65535, or null for no limit.");
  }
  if (max != null && max < min) {
    throw new Error("maxInstances must be greater than or equal to minInstances.");
  }
  group.is_repeatable = true;
  group.min_instances = min;
  group.max_instances = max;
}

function hasGroupPatch(input: GroupPatchInput): boolean {
  return [
    input.label,
    input.active,
    input.order,
    input.type,
    input.description,
    input.isRepeatable,
    input.minInstances,
    input.maxInstances,
    input.slug,
    input.extraFields,
    input.translation,
  ].some((value) => value !== undefined);
}

function hasElementPatch(input: ElementPatchInput): boolean {
  return [
    input.label,
    input.type,
    input.state,
    input.active,
    input.order,
    input.slug,
    input.extraFields,
    input.translation,
    input.placeholder,
    input.subText,
    input.defaultValue,
    input.min,
    input.max,
    input.step,
    input.format,
    input.priceType,
    input.multiplier,
    input.dynamicProductOperator,
    input.productPropertyIds,
    input.groupId,
    input.ungrouped,
  ].some((value) => value !== undefined);
}

function requireGroup(data: PostableForm, groupId: number): PostableGroup {
  const group = data.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`Group ${groupId} not found on this form.`);
  return group;
}

function locateElement(
  data: PostableForm,
  elementId: number,
): { list: PostableElement[]; index: number; element: PostableElement; groupId: number | null } | null {
  const rootIndex = data.elements.findIndex((element) => element.id === elementId);
  if (rootIndex >= 0) {
    return { list: data.elements, index: rootIndex, element: data.elements[rootIndex], groupId: null };
  }
  for (const group of data.groups) {
    const index = group.elements.findIndex((element) => element.id === elementId);
    if (index >= 0) {
      return { list: group.elements, index, element: group.elements[index], groupId: group.id };
    }
  }
  return null;
}

function toPostableGroup(raw: unknown): PostableGroup {
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
    elements: asArray(group.elements).map((element) => toPostableElement(element, id)),
  };
}

function toPostableElement(raw: unknown, groupId: number | null): PostableElement {
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
    form_group_id: groupId ?? (explicitGroup && explicitGroup > 0 ? explicitGroup : null),
  };
}

function toPostableOption(raw: unknown): PostableOption {
  const option = asRecord(raw);
  const documentationIds = Array.isArray(option.documentation_ids)
    ? toIds(option.documentation_ids)
    : toIds(option.documentations);
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
        type: stringOr(row.type, "sales"),
      };
    }),
    products: toIdObjects(option.products),
    discount_groups: asArray(option.discount_groups).map((group) => {
      const row = asRecord(group);
      const pivot = asRecord(row.pivot);
      return {
        id: numberId(row.id),
        pivot: { price_change: pivot.price_change ?? row.price_change ?? null },
      };
    }),
    documentation_ids: documentationIds,
  };
}

function mergeExtra(current: unknown, patch: ExtraFields | undefined, slug: string | undefined): ExtraFields | null {
  const base = asRecord(current);
  const next: ExtraFields = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) {
      next[key] = value as string | number | boolean | null;
    }
  }
  if (patch) Object.assign(next, patch);
  if (slug !== undefined) next.slug = slug;
  return Object.keys(next).length > 0 ? next : null;
}

function mergeTranslation(current: unknown, patch: Record<string, string> | undefined): Record<string, string> | null {
  if (patch === undefined) {
    return current && typeof current === "object" ? (current as Record<string, string>) : null;
  }
  const base = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, string>) } : {};
  const next = { ...base, ...patch };
  return Object.keys(next).length > 0 ? next : null;
}

function assertTranslation(translation: Record<string, string> | undefined): void {
  if (!translation) return;
  for (const key of Object.keys(translation)) {
    if (!TRANSLATION_KEY.test(key)) {
      throw new Error(`Translation key "${key}" must look like da_label (language, underscore, field).`);
    }
  }
}

export function nextOrder(orders: unknown[]): number {
  const nums = orders.map((order) => Number(order)).filter((order) => Number.isFinite(order));
  if (nums.length === 0) return 0;
  return Math.max(...nums) + 1;
}

function toIds(value: unknown): number[] {
  return asArray(value)
    .map((item) => (item && typeof item === "object" ? numberId(asRecord(item).id) : numberId(item)))
    .filter((id) => id > 0);
}

function toIdObjects(value: unknown): Array<{ id: number }> {
  return toIds(value).map((id) => ({ id }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberId(value: unknown): number {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isFinite(id) ? id : 0;
}

function numberOrNull(value: unknown): number | null {
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
