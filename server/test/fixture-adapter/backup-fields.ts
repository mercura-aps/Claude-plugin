import { MappingError } from "./errors.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

export function requireNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new MappingError(
			field,
			`expected a number, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

export function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value === "") {
		throw new MappingError(
			field,
			`expected a non-empty string, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}
