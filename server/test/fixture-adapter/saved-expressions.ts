import { isRecord, requireNumber } from "./backup-fields.ts";
import { MappingError } from "./errors.ts";

type SavedExpressionTables = {
	expressions: Array<Record<string, unknown>>;
	values: Array<Record<string, unknown>>;
	queryables: Array<Record<string, unknown>>;
	freeVariables: Array<Record<string, unknown>>;
};

function savedExpressionTables(
	formSync: unknown,
	savedId: number,
	field: string,
): SavedExpressionTables {
	if (formSync === undefined) {
		throw new MappingError(
			"form-sync.json",
			`missing; ${field} uses saved expression ${savedId}, which only form-sync.json holds`,
		);
	}
	const table = (name: string) => {
		const rows = isRecord(formSync) ? formSync[name] : undefined;
		if (!Array.isArray(rows)) {
			throw new MappingError(`form-sync.json.${name}`, "expected an array");
		}
		return rows.filter(isRecord);
	};
	return {
		expressions: table("formula_expressions"),
		values: table("formula_values"),
		queryables: table("product_queryables"),
		freeVariables: table("product_free_variables"),
	};
}

// Rebuild an expression subtree from form-sync.json's flat tables in the
// export's nested shape (formula_value, product_queryable, expression_root).
function buildSyncExpression(
	tables: SavedExpressionTables,
	row: Record<string, unknown>,
): Record<string, unknown> {
	const value = tables.values.find(
		(candidate) => candidate.formula_expression_id === row.id,
	);
	const queryable = value
		? tables.queryables.find(
				(candidate) => candidate.formula_value_id === value.id,
			)
		: undefined;
	return {
		...row,
		formula_value: value
			? {
					...value,
					product_queryable: queryable
						? {
								...queryable,
								product_free_variables: tables.freeVariables
									.filter(
										(variable) =>
											variable.product_queryable_id === queryable.id,
									)
									.map((variable) => {
										const root = tables.expressions.find(
											(candidate) =>
												candidate.product_free_variable_id === variable.id &&
												(candidate.parent_id ?? null) === null,
										);
										if (!root) {
											throw new MappingError(
												`form-sync.json.product_free_variables#${String(variable.id)}`,
												"has no root formula_expression",
											);
										}
										return {
											...variable,
											expression_root: buildSyncExpression(tables, root),
										};
									}),
							}
						: null,
				}
			: null,
		children: tables.expressions
			.filter((candidate) => candidate.parent_id === row.id)
			.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
			.map((child) => buildSyncExpression(tables, child)),
	};
}

// The configurator inlines saved expressions where a rule references them;
// the per-rule export keeps only used_formula_saved_expression_id.
export function inlineSavedExpressions(
	constraints: unknown,
	formSync: unknown,
): unknown {
	let tables: SavedExpressionTables | undefined;
	const visit = (node: unknown, field: string, stack: number[]): unknown => {
		if (Array.isArray(node)) {
			return node.map((item, index) =>
				visit(item, `${field}[${index}]`, stack),
			);
		}
		if (!isRecord(node)) {
			return node;
		}
		if (node.used_formula_saved_expression_id != null) {
			const savedId = requireNumber(
				node.used_formula_saved_expression_id,
				`${field}.used_formula_saved_expression_id`,
			);
			if (stack.includes(savedId)) {
				throw new MappingError(
					field,
					`saved expression ${savedId} references itself`,
				);
			}
			tables ??= savedExpressionTables(formSync, savedId, field);
			const root = tables.expressions.find(
				(row) =>
					row.formula_saved_expression_id === savedId &&
					(row.parent_id ?? null) === null,
			);
			if (!root) {
				throw new MappingError(
					`form-sync.json.formula_expressions`,
					`no root expression for saved expression ${savedId} (${field})`,
				);
			}
			const inlined = {
				...buildSyncExpression(tables, root),
				order: node.order ?? root.order,
			};
			return visit(inlined, field, [...stack, savedId]);
		}
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) {
			out[key] = visit(value, `${field}.${key}`, stack);
		}
		return out;
	};
	return visit(constraints, "formula-constraints.json", []);
}
