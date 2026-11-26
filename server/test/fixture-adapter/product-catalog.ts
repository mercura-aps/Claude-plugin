import type { BackupFiles } from "./backup-adapter.ts";
import { isRecord, requireNumber, requireString } from "./backup-fields.ts";
import { MappingError } from "./errors.ts";

// What the configurator joins into a form from the product tables: element
// products, Attribute Select attributes, and prices for the tenant's default
// country (the backup keeps every country's rows).
export type ProductCatalog = {
	declaredCountry?: number;
	country: (field: string, candidates: number[]) => number;
	product: (
		row: Record<string, unknown>,
		field: string,
	) => Record<string, unknown>;
	elementProducts: (
		element: Record<string, unknown>,
		field: string,
	) => unknown[];
	propertyAttributes: (propertyIds: number[], field: string) => unknown[];
};

type CountryRow = { price: number; vatId: unknown };

function indexBySku(
	rows: unknown,
	field: string,
): Map<string, Map<number, CountryRow>> {
	const index = new Map<string, Map<number, CountryRow>>();
	if (rows === undefined) {
		return index;
	}
	if (!Array.isArray(rows)) {
		throw new MappingError(field, "expected an array");
	}
	for (const [position, row] of rows.entries()) {
		if (!isRecord(row)) {
			throw new MappingError(`${field}[${position}]`, "expected an object");
		}
		const sku = requireString(row.sku, `${field}[${position}].sku`);
		const country = requireNumber(
			row.country_id,
			`${field}[${position}].country_id`,
		);
		const price = requireNumber(row.price, `${field}[${position}].price`);
		const byCountry = index.get(sku) ?? new Map<number, CountryRow>();
		byCountry.set(country, { price, vatId: row.vat_id ?? null });
		index.set(sku, byCountry);
	}
	return index;
}

function declaredCountry(localization: unknown): number | undefined {
	if (localization === undefined) {
		return undefined;
	}
	if (!isRecord(localization) || !isRecord(localization.country)) {
		throw new MappingError(
			"localization.json",
			"expected { country: { id } } like /api/localization",
		);
	}
	return requireNumber(localization.country.id, "localization.json.country.id");
}

export type ProductTables = {
	products: Array<Record<string, unknown>>;
	attributesBySku: Map<string, Set<number>>;
	sales: Map<string, Map<number, CountryRow>>;
	costs: Map<string, Map<number, CountryRow>>;
	// false for a dashboard snapshot ({ data: [...] }), which has no prices
	priced: boolean;
};

// A dashboard snapshot writes products.json as { data: [...] }: the
// /api/products rows with their attributes inline and no price tables.
export function isUnpricedProducts(raw: unknown): boolean {
	return isRecord(raw) && Array.isArray(raw.data);
}

export function readProductTables(raw: unknown): ProductTables {
	if (isRecord(raw) && Array.isArray(raw.data)) {
		const products = raw.data.filter(isRecord);
		const attributesBySku = new Map<string, Set<number>>();
		for (const [index, product] of products.entries()) {
			const sku = requireString(
				product.sku,
				`products.json.data[${index}].sku`,
			);
			const attributes = Array.isArray(product.attributes)
				? product.attributes
				: [];
			attributesBySku.set(
				sku,
				new Set(
					attributes.map((attribute, position) =>
						requireNumber(
							isRecord(attribute) ? attribute.id : attribute,
							`products.json.data[${index}].attributes[${position}].id`,
						),
					),
				),
			);
		}
		return {
			products,
			attributesBySku,
			sales: new Map(),
			costs: new Map(),
			priced: false,
		};
	}
	if (
		!isRecord(raw) ||
		!Array.isArray(raw.products) ||
		!Array.isArray(raw.attributes)
	) {
		throw new MappingError(
			"products.json",
			"expected { products: [...], attributes: [...] } or a snapshot { data: [...] }",
		);
	}
	const products = raw.products.filter(isRecord);
	const skuById = new Map<number, string>();
	for (const product of products) {
		if (typeof product.id === "number" && typeof product.sku === "string") {
			skuById.set(product.id, product.sku);
		}
	}
	const attributesBySku = new Map<string, Set<number>>();
	for (const [index, row] of raw.attributes.entries()) {
		if (!isRecord(row)) {
			throw new MappingError(
				`products.json.attributes[${index}]`,
				"expected an object",
			);
		}
		const sku =
			typeof row.sku === "string"
				? row.sku
				: typeof row.product_id === "number"
					? skuById.get(row.product_id)
					: undefined;
		if (sku === undefined) {
			throw new MappingError(
				`products.json.attributes[${index}]`,
				"cannot resolve product_id from sku or product_id",
			);
		}
		const ids = attributesBySku.get(sku) ?? new Set<number>();
		ids.add(
			requireNumber(
				row.product_property_attribute_id,
				`products.json.attributes[${index}].product_property_attribute_id`,
			),
		);
		attributesBySku.set(sku, ids);
	}
	return {
		products,
		attributesBySku,
		sales: indexBySku(raw.sales_prices, "products.json.sales_prices"),
		costs: indexBySku(raw.cost_prices, "products.json.cost_prices"),
		priced: true,
	};
}

export function createProductCatalog(files: BackupFiles): ProductCatalog {
	const declared = declaredCountry(files.localization);
	let catalog: ProductTables | undefined;

	const loadCatalog = (field: string) => {
		if (catalog) {
			return catalog;
		}
		if (files.products === undefined) {
			throw new MappingError(
				"products.json",
				`missing; ${field} needs product prices`,
			);
		}
		catalog = readProductTables(files.products);
		return catalog;
	};

	let resolved: number | undefined;
	const country = (field: string, candidates: number[]): number => {
		if (declared !== undefined) {
			return declared;
		}
		if (resolved !== undefined) {
			return resolved;
		}
		const seen = new Set(candidates);
		if (files.products !== undefined) {
			for (const byCountry of loadCatalog(field).sales.values()) {
				for (const id of byCountry.keys()) {
					seen.add(id);
				}
			}
		}
		if (seen.size !== 1) {
			throw new MappingError(
				"localization.json",
				`${field} needs one price country, but sales prices cover countries ${[...seen].sort((a, b) => a - b).join(", ")}; add localization.json naming the tenant's default country`,
			);
		}
		resolved = [...seen][0] as number;
		return resolved;
	};

	const product = (row: Record<string, unknown>, field: string) => {
		const sku = requireString(row.sku, `${field}.sku`);
		const { sales, costs, priced } = loadCatalog(field);
		if (!priced) {
			// A snapshot has no prices. The SDK schema needs numbers; mapBackup
			// refuses any rule that reads them, and the Dump's config price is null.
			return { ...row, price: 0, base_price: 0, cost_price: 0, vat: 0 };
		}
		const id = country(field, []);
		const sale = sales.get(sku)?.get(id);
		if (!sale) {
			throw new MappingError(
				"products.json.sales_prices",
				`no country ${id} sales price for sku ${sku} (${field})`,
			);
		}
		if (sale.vatId !== null) {
			throw new MappingError(
				"products.json.sales_prices",
				`sku ${sku} has vat_id ${JSON.stringify(sale.vatId)}; the backup has no VAT rates to resolve it`,
			);
		}
		return {
			...row,
			price: sale.price,
			base_price: sale.price,
			cost_price: costs.get(sku)?.get(id)?.price ?? 0,
			vat: 0,
		};
	};

	const elementProducts = (element: Record<string, unknown>, field: string) => {
		const wanted = (element.productPropertyAttributes as unknown[]).map(
			(attribute, index) =>
				requireNumber(
					isRecord(attribute) ? attribute.id : attribute,
					`${field}.productPropertyAttributes[${index}].id`,
				),
		);
		const operator = element.dynamic_product_operator;
		if (operator !== "and" && operator !== "or") {
			throw new MappingError(
				`${field}.dynamic_product_operator`,
				`expected "and" or "or" for an element with productPropertyAttributes, got ${JSON.stringify(operator)}`,
			);
		}
		const { products, attributesBySku } = loadCatalog(field);
		// products.json order: the backup does not keep the configurator's order
		return products
			.filter((row) => {
				const has = attributesBySku.get(String(row.sku));
				if (!has) {
					return false;
				}
				return operator === "and"
					? wanted.every((id) => has.has(id))
					: wanted.some((id) => has.has(id));
			})
			.map((row) =>
				product(
					{
						...row,
						image: row.image ?? null,
						model_3d: row.model_3d ?? null,
						documentations: row.documentations ?? [],
					},
					`${field}.products`,
				),
			);
	};

	// Attribute Select options in the configurator's attribute shape; its slug
	// is the raw value, which formulas compare against product attributes.
	const propertyAttributes = (propertyIds: number[], field: string) => {
		const raw = files.productProperties;
		if (!isRecord(raw) || !Array.isArray(raw.attributes)) {
			throw new MappingError(
				"product-properties.json.attributes",
				`missing; ${field} is an Attribute Select`,
			);
		}
		return [...raw.attributes.entries()]
			.filter(
				([, attribute]) =>
					isRecord(attribute) &&
					propertyIds.includes(attribute.product_property_id as number),
			)
			.map(([index, attribute]) => {
				const row = attribute as Record<string, unknown>;
				const value = requireString(
					row.value,
					`product-properties.json.attributes[${index}].value`,
				);
				return {
					id: row.id,
					value,
					description: row.description ?? null,
					image: row.image ?? null,
					product_property_id: row.product_property_id,
					slug: typeof row.slug === "string" ? row.slug : value,
				};
			});
	};

	return {
		declaredCountry: declared,
		country,
		product,
		elementProducts,
		propertyAttributes,
	};
}
