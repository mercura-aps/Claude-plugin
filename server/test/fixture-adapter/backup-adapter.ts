import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, requireNumber, requireString } from "./backup-fields.ts";
import { MappingError } from "./errors.ts";
import {
	createProductCatalog,
	isUnpricedProducts,
	readProductTables,
	type ProductCatalog,
} from "./product-catalog.ts";
import { inlineSavedExpressions } from "./saved-expressions.ts";
import { EMPTY_BOM } from "./stubs.ts";

export const REQUIRED_BACKUP_FILES = [
	"form.json",
	"formula-constraints.json",
	"product-queries.json",
	"product-properties.json",
] as const;

export type BackupFiles = {
	form: unknown;
	formulaConstraints: unknown;
	productQueries: unknown;
	productProperties: unknown;
	products?: unknown;
	formSync?: unknown;
	bom?: unknown;
	localization?: unknown;
	languages?: unknown;
	countries?: unknown;
	auth?: unknown;
};

export type MappedConfigurator = {
	formId: number;
	formName: string;
	form: unknown;
	formulaConstraints: unknown;
	queries: {
		formula_values: Record<string, unknown>;
		formula_effects: Record<string, unknown>;
	};
	productPropertiesUsage: { properties: unknown[] };
	bom: unknown;
	// products.json had no price tables (a dashboard snapshot)
	unpricedProducts: boolean;
};

function readJsonFile(
	dir: string,
	name: string,
	required: boolean,
): unknown | undefined {
	const path = join(dir, name);
	if (!existsSync(path)) {
		if (required) {
			throw new MappingError(name, `missing required file in ${dir}`);
		}
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new MappingError(
			name,
			`invalid JSON (${error instanceof Error ? error.message : error})`,
		);
	}
}

export function loadBackupFiles(dir: string): BackupFiles {
	const form = readJsonFile(dir, "form.json", true);
	const formulaConstraints = readJsonFile(
		dir,
		"formula-constraints.json",
		true,
	);
	const productQueries = readJsonFile(dir, "product-queries.json", true);
	const productProperties = readJsonFile(dir, "product-properties.json", true);
	return {
		form,
		formulaConstraints,
		productQueries,
		productProperties,
		products: readJsonFile(dir, "products.json", false),
		formSync: readJsonFile(dir, "form-sync.json", false),
		bom: readJsonFile(dir, "bom.json", false),
		localization: readJsonFile(dir, "localization.json", false),
		languages: readJsonFile(dir, "languages.json", false),
		countries: readJsonFile(dir, "countries.json", false),
		auth: readJsonFile(dir, "auth.json", false),
	};
}

export function mapForm(
	raw: unknown,
	catalog?: ProductCatalog,
): {
	formId: number;
	formName: string;
	payload: Record<string, unknown>;
} {
	const root = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
	if (!isRecord(root)) {
		throw new MappingError(
			"form.json",
			"expected an object with form, elements, and groups",
		);
	}

	if (
		!isRecord(root.form) ||
		!Array.isArray(root.elements) ||
		!Array.isArray(root.groups)
	) {
		throw new MappingError(
			"form.json",
			"dashboard export must already be { form, elements, groups }; cannot map this shape",
		);
	}

	const formId = requireNumber(root.form.id, "form.json.form.id");
	const formName = requireString(root.form.name, "form.json.form.name");
	return {
		formId,
		formName,
		payload: {
			form: root.form,
			elements: mapElements(root.elements, "form.json.elements", catalog),
			groups: mapGroups(root.groups, "form.json.groups", catalog),
		},
	};
}

function salesPrices(
	option: Record<string, unknown>,
): Array<{ price: number; country?: number }> {
	if (!Array.isArray(option.prices)) {
		return [];
	}
	return option.prices
		.filter(isRecord)
		.filter((row) => row.type === "sales" && typeof row.price === "number")
		.map((row) => ({
			price: row.price as number,
			country: typeof row.country_id === "number" ? row.country_id : undefined,
		}));
}

// The configurator prices an option with no sales row for the session
// country at 0.
function optionSalesPrice(
	option: Record<string, unknown>,
	field: string,
	catalog?: ProductCatalog,
): number {
	const rows = salesPrices(option);
	const forCountry = (id: number) =>
		rows.find((row) => row.country === id)?.price ?? 0;
	if (catalog?.declaredCountry !== undefined) {
		return forCountry(catalog.declaredCountry);
	}
	const amounts = [...new Set(rows.map((row) => row.price))];
	if (amounts.length <= 1) {
		return amounts[0] ?? 0;
	}
	if (!catalog) {
		throw new MappingError(
			field,
			"option has country-specific sales prices; cannot pick one",
		);
	}
	const candidates = rows.flatMap((row) =>
		row.country === undefined ? [] : [row.country],
	);
	return forCountry(catalog.country(field, candidates));
}

function flattenOptionPrices(
	option: unknown,
	field: string,
	catalog?: ProductCatalog,
): Record<string, unknown> {
	if (!isRecord(option)) {
		throw new MappingError(field, "expected an option object");
	}
	const products =
		catalog && Array.isArray(option.products) && option.products.length > 0
			? option.products.map((product, index) => {
					if (!isRecord(product)) {
						throw new MappingError(
							`${field}.products[${index}]`,
							"expected a product object",
						);
					}
					return typeof product.price === "number"
						? product
						: catalog.product(product, `${field}.products[${index}]`);
				})
			: option.products;
	const withProducts =
		products === option.products ? option : { ...option, products };
	if (
		typeof option.price === "number" &&
		typeof option.base_price === "number"
	) {
		return withProducts;
	}
	const price = optionSalesPrice(option, field, catalog);
	return { ...withProducts, price, base_price: price };
}

function mapElementProducts(
	element: Record<string, unknown>,
	field: string,
	catalog?: ProductCatalog,
): Record<string, unknown> {
	const hasProperties =
		Array.isArray(element.productProperties) &&
		element.productProperties.length > 0;
	const hasAttributes =
		Array.isArray(element.productPropertyAttributes) &&
		element.productPropertyAttributes.length > 0;
	if (!hasProperties && !hasAttributes) {
		return element;
	}
	if (hasProperties && hasAttributes) {
		throw new MappingError(
			field,
			"element has both productProperties and productPropertyAttributes; cannot tell an Attribute Select from element products",
		);
	}
	if (!catalog) {
		throw new MappingError(
			`${field}.${hasProperties ? "productProperties" : "productPropertyAttributes"}`,
			"needs the product tables of a whole Fixture Dir",
		);
	}
	if (hasProperties) {
		const ids = (element.productProperties as unknown[]).map(
			(property, index) =>
				requireNumber(
					isRecord(property) ? property.id : property,
					`${field}.productProperties[${index}].id`,
				),
		);
		return {
			...element,
			is_attribute_element: true,
			attributes: catalog.propertyAttributes(ids, field),
		};
	}
	return { ...element, products: catalog.elementProducts(element, field) };
}

function mapElements(
	raw: unknown,
	field: string,
	catalog?: ProductCatalog,
): unknown[] {
	if (!Array.isArray(raw)) {
		throw new MappingError(field, "expected an array of elements");
	}
	return raw.map((element, index) => {
		if (!isRecord(element)) {
			throw new MappingError(
				`${field}[${index}]`,
				"expected an element object",
			);
		}
		if (
			element.is_attribute_element === true &&
			!Array.isArray(element.attributes)
		) {
			throw new MappingError(
				`${field}[${index}].attributes`,
				"Attribute Select has no attributes; cannot map its Attribute Options",
			);
		}
		const withProducts = mapElementProducts(
			element,
			`${field}[${index}]`,
			catalog,
		);
		if (!Array.isArray(element.options)) {
			return withProducts;
		}
		return {
			...withProducts,
			options: element.options.map((option, optionIndex) =>
				flattenOptionPrices(
					option,
					`${field}[${index}].options[${optionIndex}]`,
					catalog,
				),
			),
		};
	});
}

function mapGroups(
	raw: unknown,
	field: string,
	catalog?: ProductCatalog,
): unknown[] {
	if (!Array.isArray(raw)) {
		throw new MappingError(field, "expected an array of groups");
	}
	return raw.map((group, index) => {
		if (!isRecord(group)) {
			throw new MappingError(`${field}[${index}]`, "expected a group object");
		}
		return {
			...group,
			elements: mapElements(
				group.elements,
				`${field}[${index}].elements`,
				catalog,
			),
		};
	});
}

export function mapFormulaConstraints(raw: unknown): unknown[] {
	const list = Array.isArray(raw)
		? raw
		: isRecord(raw) && Array.isArray(raw.rules)
			? raw.rules
			: isRecord(raw) && Array.isArray(raw.data)
				? raw.data
				: null;

	if (!list) {
		throw new MappingError(
			"formula-constraints.json",
			"expected an array, { rules: [...] }, or { data: [...] }",
		);
	}

	return list.map((item, index) => {
		if (!isRecord(item)) {
			throw new MappingError(
				`formula-constraints.json[${index}]`,
				"expected a constraint object",
			);
		}
		// mercura_backup wraps a rule as { meta, constraint }; a snapshot as { data }
		const row =
			isRecord(item.constraint) &&
			Array.isArray(item.constraint.formula_effects)
				? item.constraint
				: isRecord(item.data) && Array.isArray(item.data.formula_effects)
					? item.data
					: item;
		if (!("formula_effects" in row)) {
			throw new MappingError(
				`formula-constraints.json[${index}].formula_effects`,
				"missing; cannot evaluate a half-mapped rule",
			);
		}
		const { meta: _meta, completeness: _completeness, ...rest } = row;
		const effects = Array.isArray(rest.formula_effects)
			? rest.formula_effects.map((effect, effectIndex) =>
					mapConstraintNode(
						effect,
						`formula-constraints.json[${index}].formula_effects[${effectIndex}]`,
					),
				)
			: rest.formula_effects;
		return {
			...rest,
			formula_effects: effects,
			...("formula_expression" in rest
				? {
						formula_expression: mapConstraintNode(
							rest.formula_expression,
							`formula-constraints.json[${index}].formula_expression`,
						),
					}
				: {}),
		};
	});
}

function mapConstraintNode(raw: unknown, field: string): unknown {
	if (raw == null) {
		return raw;
	}
	if (!isRecord(raw)) {
		throw new MappingError(field, "expected an object or null");
	}
	const named: Record<string, unknown> = {
		...raw,
		name: raw.name ?? null,
		description: raw.description ?? null,
	};
	if (Array.isArray(named.children)) {
		named.children = named.children.map((child, index) =>
			mapConstraintNode(child, `${field}.children[${index}]`),
		);
	}
	if (named.formula_expression != null) {
		named.formula_expression = mapConstraintNode(
			named.formula_expression,
			`${field}.formula_expression`,
		);
	}
	if (isRecord(named.formula_value)) {
		named.formula_value = mapFormulaValue(
			named.formula_value,
			`${field}.formula_value`,
		);
	}
	if (isRecord(named.product_queryable)) {
		named.product_queryable = mapQueryable(
			named.product_queryable,
			"App\\Models\\FormulaEffect",
			named.product_queryable.formula_effect_id ?? named.id,
			`${field}.product_queryable`,
		);
	}
	return named;
}

// The admin export stores every constant as a string; the configurator casts
// number and boolean constants, and the SDK reads Boolean("false") as true.
function typedConstant(value: Record<string, unknown>, field: string): unknown {
	const constant = value.constant;
	if (typeof constant !== "string") {
		return constant;
	}
	if (value.type === "number") {
		const number = Number(constant);
		if (constant.trim() === "" || !Number.isFinite(number)) {
			throw new MappingError(
				`${field}.constant`,
				`number constant ${JSON.stringify(constant)} is not numeric`,
			);
		}
		return number;
	}
	if (value.type === "boolean") {
		if (constant === "true" || constant === "1") {
			return true;
		}
		if (constant === "false" || constant === "0") {
			return false;
		}
		throw new MappingError(
			`${field}.constant`,
			`boolean constant ${JSON.stringify(constant)} is not true/false`,
		);
	}
	return constant;
}

function mapFormulaValue(
	value: Record<string, unknown>,
	field: string,
): Record<string, unknown> {
	return {
		...value,
		constant: typedConstant(value, field),
		...(isRecord(value.product_queryable)
			? {
					product_queryable: mapQueryable(
						value.product_queryable,
						"App\\Models\\FormulaValue",
						value.product_queryable.formula_value_id ?? value.id,
						`${field}.product_queryable`,
					),
				}
			: {}),
	};
}

// The export names a queryable's owner with formula_effect_id /
// formula_value_id and nests each free variable's expression; the SDK schema
// wants the configurator's polymorphic owner and expression id.
function mapQueryable(
	queryable: Record<string, unknown>,
	ownerType: string,
	ownerId: unknown,
	field: string,
): Record<string, unknown> {
	const variables = queryable.product_free_variables ?? [];
	if (!Array.isArray(variables)) {
		throw new MappingError(
			`${field}.product_free_variables`,
			"expected an array",
		);
	}
	return {
		...queryable,
		product_queryable_type: queryable.product_queryable_type ?? ownerType,
		product_queryable_id:
			queryable.product_queryable_id ??
			requireNumber(ownerId, `${field}.product_queryable_id`),
		product_free_variables: variables.map((variable, index) => {
			const variableField = `${field}.product_free_variables[${index}]`;
			if (!isRecord(variable)) {
				throw new MappingError(variableField, "expected an object");
			}
			if (variable.expression_root === undefined) {
				return variable;
			}
			const root = mapConstraintNode(
				variable.expression_root,
				`${variableField}.expression_root`,
			);
			return {
				...variable,
				formula_expression_id:
					variable.formula_expression_id ??
					requireNumber(
						isRecord(root) ? root.id : undefined,
						`${variableField}.expression_root.id`,
					),
				expression_root: root,
			};
		}),
	};
}

function asQueryMaps(raw: unknown): {
	formula_values: Record<string, unknown>;
	formula_effects: Record<string, unknown>;
} | null {
	if (!isRecord(raw)) {
		return null;
	}
	if ("formula_values" in raw || "formula_effects" in raw) {
		if (raw.formula_values !== undefined && !isRecord(raw.formula_values)) {
			throw new MappingError(
				"product-queries.json.formula_values",
				"expected an object",
			);
		}
		if (raw.formula_effects !== undefined && !isRecord(raw.formula_effects)) {
			throw new MappingError(
				"product-queries.json.formula_effects",
				"expected an object",
			);
		}
		return {
			formula_values: isRecord(raw.formula_values) ? raw.formula_values : {},
			formula_effects: isRecord(raw.formula_effects) ? raw.formula_effects : {},
		};
	}
	return null;
}

function queryList(raw: unknown): Array<Record<string, unknown>> {
	const asRecords = (list: unknown[], field: string) =>
		list.map((item, index) => {
			if (!isRecord(item)) {
				throw new MappingError(`${field}[${index}]`, "expected a query object");
			}
			return item;
		});

	if (Array.isArray(raw)) {
		return asRecords(raw, "product-queries.json");
	}
	if (isRecord(raw) && Array.isArray(raw.queries)) {
		return asRecords(raw.queries, "product-queries.json.queries");
	}
	if (isRecord(raw) && Array.isArray(raw.data)) {
		return asRecords(raw.data, "product-queries.json.data");
	}
	if (isRecord(raw) && Array.isArray(raw.product_queries)) {
		return asRecords(
			raw.product_queries,
			"product-queries.json.product_queries",
		);
	}
	throw new MappingError(
		"product-queries.json",
		"expected { formula_values, formula_effects }, an array of queries, { queries: [...] }, { product_queries: [...] }, or { data: [...] }",
	);
}

type QueryableRef = {
	kind: "formula_values" | "formula_effects";
	id: number;
	queryId: number;
	freeVariables: unknown;
	field: string;
};

function collectQueryables(constraints: unknown[]): QueryableRef[] {
	const found: QueryableRef[] = [];

	const visitQueryable = (
		kind: "formula_values" | "formula_effects",
		ownerId: unknown,
		queryable: unknown,
		field: string,
	) => {
		if (queryable == null) {
			return;
		}
		if (!isRecord(queryable)) {
			throw new MappingError(field, "product_queryable is not an object");
		}
		const owner = requireNumber(ownerId, `${field}.owner_id`);
		const queryId = requireNumber(
			queryable.product_query_id,
			`${field}.product_query_id`,
		);
		found.push({
			kind,
			id: owner,
			queryId,
			freeVariables: queryable.product_free_variables,
			field,
		});
	};

	// The configurator keys a query for every formula value that runs one,
	// however deep in an expression (free-variable expressions included).
	const visit = (node: unknown, field: string) => {
		if (Array.isArray(node)) {
			node.forEach((item, index) => visit(item, `${field}[${index}]`));
			return;
		}
		if (!isRecord(node)) {
			return;
		}
		if (Array.isArray(node.formula_effects)) {
			for (const [index, effect] of node.formula_effects.entries()) {
				if (isRecord(effect)) {
					visitQueryable(
						"formula_effects",
						effect.id,
						effect.product_queryable,
						`${field}.formula_effects[${index}].product_queryable`,
					);
				}
			}
		}
		if (isRecord(node.formula_value)) {
			visitQueryable(
				"formula_values",
				node.formula_value.id,
				node.formula_value.product_queryable,
				`${field}.formula_value.product_queryable`,
			);
		}
		for (const [key, value] of Object.entries(node)) {
			visit(value, `${field}.${key}`);
		}
	};
	visit(constraints, "formula-constraints.json");

	return found;
}

export function mapProductQueries(
	raw: unknown,
	constraints: unknown[],
): MappedConfigurator["queries"] {
	const already = asQueryMaps(raw);
	if (already) {
		return already;
	}
	if (isRecord(raw) && Array.isArray(raw.product_query_clauses)) {
		return mapNormalizedQueries(raw.product_query_clauses, constraints);
	}

	const queries = queryList(raw);
	const byId = new Map<number, Record<string, unknown>>();
	for (const [index, query] of queries.entries()) {
		const id = requireNumber(query.id, `product-queries.json[${index}].id`);
		byId.set(id, query);
	}

	for (const ref of collectQueryables(constraints)) {
		const query = byId.get(ref.queryId);
		if (!query) {
			throw new MappingError(
				`product-queries.json#${ref.queryId}`,
				`referenced by ${ref.kind}:${ref.id} but missing from the backup`,
			);
		}
		if (!Array.isArray(query.clause_tree)) {
			throw new MappingError(
				`product-queries.json#${ref.queryId}.clause_tree`,
				"expected an array; query has no mappable clauses",
			);
		}
	}

	// A stored clause_tree is the query alone: flatten it so free variables
	// and empty comparisons get the same treatment as the flat export.
	const rows: unknown[] = [];
	const flatten = (clauses: unknown[]) => {
		for (const clause of clauses) {
			if (!isRecord(clause)) {
				continue;
			}
			const {
				children,
				product_property: _property,
				formula_expression: _expression,
				...row
			} = clause;
			rows.push(row);
			if (Array.isArray(children)) {
				flatten(children);
			}
		}
	};
	for (const query of queries) {
		if (Array.isArray(query.clause_tree)) {
			flatten(query.clause_tree);
		}
	}
	return mapNormalizedQueries(rows, constraints);
}

type ClauseRow = Record<string, unknown> & { id: number };

// The admin export stores clauses flat; the configurator nests them by
// parent_id and fills each clause's formula_expression from the free
// variables of the queryable that runs the query.
function mapNormalizedQueries(
	rawClauses: unknown[],
	constraints: unknown[],
): MappedConfigurator["queries"] {
	const byQuery = new Map<number, ClauseRow[]>();
	for (const [index, clause] of rawClauses.entries()) {
		const field = `product-queries.json.product_query_clauses[${index}]`;
		if (!isRecord(clause)) {
			throw new MappingError(field, "expected a clause object");
		}
		const id = requireNumber(clause.id, `${field}.id`);
		const queryId = requireNumber(
			clause.product_query_id,
			`${field}.product_query_id`,
		);
		const list = byQuery.get(queryId) ?? [];
		list.push({ ...clause, id });
		byQuery.set(queryId, list);
	}

	const mapped: MappedConfigurator["queries"] = {
		formula_values: {},
		formula_effects: {},
	};
	for (const ref of collectQueryables(constraints)) {
		const clauses = byQuery.get(ref.queryId) ?? [];
		const expressions = freeVariableExpressions(ref, clauses);
		// The configurator leaves out a comparison with nothing to compare:
		// no attribute_value and no free variable from this queryable.
		const build = (parentId: number | null): unknown[] =>
			clauses
				.filter((clause) => (clause.parent_id ?? null) === parentId)
				.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
				.flatMap((clause) => {
					const expression = expressions.get(clause.id);
					const children = build(clause.id);
					if (
						clause.operator != null &&
						clause.attribute_value == null &&
						expression === undefined &&
						children.length === 0
					) {
						return [];
					}
					return [
						{
							...clause,
							...(expression === undefined
								? {}
								: { formula_expression: expression }),
							children,
						},
					];
				});
		mapped[ref.kind][String(ref.id)] = build(null);
	}
	return mapped;
}

function freeVariableExpressions(
	ref: QueryableRef,
	clauses: ClauseRow[],
): Map<number, unknown> {
	const expressions = new Map<number, unknown>();
	if (ref.freeVariables == null) {
		return expressions;
	}
	const field = `${ref.field}.product_free_variables`;
	if (!Array.isArray(ref.freeVariables)) {
		throw new MappingError(field, "expected an array");
	}
	const clauseIds = new Set(clauses.map((clause) => clause.id));
	for (const [index, variable] of ref.freeVariables.entries()) {
		if (!isRecord(variable)) {
			throw new MappingError(`${field}[${index}]`, "expected an object");
		}
		const clauseId = requireNumber(
			variable.product_query_clause_id,
			`${field}[${index}].product_query_clause_id`,
		);
		if (!clauseIds.has(clauseId)) {
			throw new MappingError(
				`${field}[${index}].product_query_clause_id`,
				`clause ${clauseId} is not in product-queries.json query ${ref.queryId}`,
			);
		}
		expressions.set(
			clauseId,
			mapConstraintNode(
				variable.expression_root,
				`${field}[${index}].expression_root`,
			),
		);
	}
	return expressions;
}

function productIdsByAttribute(products: unknown): Map<number, number[]> {
	const map = new Map<number, number[]>();
	if (products == null) {
		return map;
	}
	const tables = readProductTables(products);
	const idBySku = new Map<string, number>();
	for (const product of tables.products) {
		if (typeof product.sku === "string" && typeof product.id === "number") {
			idBySku.set(product.sku, product.id);
		}
	}
	for (const [sku, attributeIds] of tables.attributesBySku) {
		const productId = idBySku.get(sku);
		if (productId === undefined) {
			throw new MappingError(
				"products.json.attributes",
				`sku ${sku} has attributes but no product row`,
			);
		}
		for (const attributeId of attributeIds) {
			const list = map.get(attributeId) ?? [];
			list.push(productId);
			map.set(attributeId, list);
		}
	}
	return map;
}

export function mapProductProperties(
	raw: unknown,
	products?: unknown,
	offered?: Set<number>,
): { properties: unknown[] } {
	if (!isRecord(raw)) {
		throw new MappingError("product-properties.json", "expected an object");
	}

	if (
		Array.isArray(raw.properties) &&
		raw.properties.some(
			(item) => isRecord(item) && Array.isArray(item.attributes),
		)
	) {
		return { properties: raw.properties };
	}

	if (!Array.isArray(raw.properties) || !Array.isArray(raw.attributes)) {
		throw new MappingError(
			"product-properties.json",
			"expected usage { properties: [{ attributes }] } or export { properties, attributes }",
		);
	}

	const ids = productIdsByAttribute(products);
	const grouped = new Map<
		number,
		{
			id: number;
			slug: string;
			type: string;
			attributes: Array<{
				id: number;
				attribute: string;
				slug: string;
				product_ids: number[];
			}>;
		}
	>();

	for (const [index, property] of raw.properties.entries()) {
		if (!isRecord(property)) {
			throw new MappingError(
				`product-properties.json.properties[${index}]`,
				"expected an object",
			);
		}
		const id = requireNumber(
			property.id,
			`product-properties.json.properties[${index}].id`,
		);
		const slug = requireString(
			property.slug,
			`product-properties.json.properties[${index}].slug`,
		);
		const type = requireString(
			property.type,
			`product-properties.json.properties[${index}].type`,
		);
		if (type !== "string" && type !== "number" && type !== "boolean") {
			throw new MappingError(
				`product-properties.json.properties[${index}].type`,
				`unsupported type ${JSON.stringify(type)}`,
			);
		}
		grouped.set(id, { id, slug, type, attributes: [] });
	}

	for (const [index, attribute] of raw.attributes.entries()) {
		if (!isRecord(attribute)) {
			throw new MappingError(
				`product-properties.json.attributes[${index}]`,
				"expected an object",
			);
		}
		const id = requireNumber(
			attribute.id,
			`product-properties.json.attributes[${index}].id`,
		);
		const propertyId = requireNumber(
			attribute.product_property_id,
			`product-properties.json.attributes[${index}].product_property_id`,
		);
		const value = requireString(
			attribute.value ?? attribute.attribute,
			`product-properties.json.attributes[${index}].value`,
		);
		const property = grouped.get(propertyId);
		if (!property) {
			throw new MappingError(
				`product-properties.json.attributes[${index}].product_property_id`,
				`no property ${propertyId} in the same file`,
			);
		}
		const productIds = (ids.get(id) ?? []).filter(
			(productId) => !offered || offered.has(productId),
		);
		if (offered && productIds.length === 0) {
			continue;
		}
		property.attributes.push({
			id,
			attribute: value,
			slug: typeof attribute.slug === "string" ? attribute.slug : value,
			product_ids: productIds,
		});
	}

	const properties = [...grouped.values()];
	return {
		properties: offered
			? properties.filter((property) => property.attributes.length > 0)
			: properties,
	};
}

// Product ids the form offers, as element products or option products.
function offeredProductIds(form: Record<string, unknown>): Set<number> {
	const ids = new Set<number>();
	const addProducts = (products: unknown) => {
		if (!Array.isArray(products)) {
			return;
		}
		for (const product of products) {
			if (isRecord(product) && typeof product.id === "number") {
				ids.add(product.id);
			}
		}
	};
	const elements = [
		...((form.elements as unknown[]) ?? []),
		...((form.groups as unknown[]) ?? []).flatMap((group) =>
			isRecord(group) && Array.isArray(group.elements) ? group.elements : [],
		),
	];
	for (const element of elements) {
		if (!isRecord(element)) {
			continue;
		}
		addProducts(element.products);
		if (Array.isArray(element.options)) {
			for (const option of element.options) {
				if (isRecord(option)) {
					addProducts(option.products);
				}
			}
		}
	}
	return ids;
}

const PRICE_CONSTANTS = new Set(["price", "cost_price"]);

// Without price tables a product's price is unknown, so no rule may read one:
// a price or cost_price value on a product option, or a property aggregate
// over price on an element that offers products.
function refuseProductPriceReads(
	form: Record<string, unknown>,
	constraints: unknown[],
): void {
	const productOptions = new Set<number>();
	const productElements = new Set<number>();
	const elements = [
		...((form.elements as unknown[]) ?? []),
		...((form.groups as unknown[]) ?? []).flatMap((group) =>
			isRecord(group) && Array.isArray(group.elements) ? group.elements : [],
		),
	];
	for (const element of elements) {
		if (!isRecord(element)) {
			continue;
		}
		const products = Array.isArray(element.products) ? element.products : [];
		for (const product of products) {
			if (isRecord(product) && typeof product.id === "number") {
				productOptions.add(product.id);
			}
		}
		const options = Array.isArray(element.options) ? element.options : [];
		const optionProducts = options.filter(
			(option) =>
				isRecord(option) &&
				Array.isArray(option.products) &&
				option.products.length > 0,
		) as Array<Record<string, unknown>>;
		for (const option of optionProducts) {
			productOptions.add(option.id as number);
		}
		if (products.length > 0 || optionProducts.length > 0) {
			productElements.add(element.id as number);
		}
	}

	const readsPrice = (value: Record<string, unknown>): boolean => {
		if (value.type === "price" || value.type === "cost_price") {
			return productOptions.has(value.form_option_id as number);
		}
		return (
			typeof value.type === "string" &&
			value.type.startsWith("property_") &&
			PRICE_CONSTANTS.has(value.constant as string) &&
			(productElements.has(value.form_element_id as number) ||
				productOptions.has(value.form_option_id as number))
		);
	};
	const visit = (node: unknown, ruleId: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach((item) => visit(item, ruleId));
			return;
		}
		if (!isRecord(node)) {
			return;
		}
		if (isRecord(node.formula_value) && readsPrice(node.formula_value)) {
			throw new MappingError(
				"products.json",
				`has no prices, but rule ${String(ruleId)} reads a product ${String(node.formula_value.type)}${node.formula_value.constant ? ` (${String(node.formula_value.constant)})` : ""}; use a mercura_backup Fixture Dir`,
			);
		}
		for (const value of Object.values(node)) {
			visit(value, ruleId);
		}
	};
	for (const constraint of constraints) {
		visit(constraint, isRecord(constraint) ? constraint.id : undefined);
	}
}

export function mapBackup(files: BackupFiles): MappedConfigurator {
	const form = mapForm(files.form, createProductCatalog(files));
	const formulaConstraints = mapFormulaConstraints(
		inlineSavedExpressions(files.formulaConstraints, files.formSync),
	);
	const unpricedProducts = isUnpricedProducts(files.products);
	if (unpricedProducts) {
		refuseProductPriceReads(form.payload, formulaConstraints);
	}
	const queries = mapProductQueries(files.productQueries, formulaConstraints);
	// The configurator reports usage only for products the form offers.
	const productPropertiesUsage = mapProductProperties(
		files.productProperties,
		files.products,
		offeredProductIds(form.payload),
	);
	return {
		formId: form.formId,
		formName: form.formName,
		form: form.payload,
		formulaConstraints,
		queries,
		productPropertiesUsage,
		bom: files.bom ?? { data: EMPTY_BOM },
		unpricedProducts,
	};
}

export function loadFixtureDir(dir: string): MappedConfigurator {
	return mapBackup(loadBackupFiles(dir));
}
