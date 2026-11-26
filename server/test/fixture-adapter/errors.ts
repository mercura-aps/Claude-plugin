export class CliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 2) {
		super(message);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}

export class MappingError extends CliError {
	readonly field: string;

	constructor(field: string, message: string) {
		super(`Unmappable backup field ${field}: ${message}`);
		this.name = "MappingError";
		this.field = field;
	}
}

export class ExpectError extends CliError {
	readonly actual: unknown;
	readonly expected: unknown;
	readonly path: string;
	readonly op: string;

	constructor(args: {
		path: string;
		op: string;
		actual: unknown;
		expected: unknown;
		message: string;
	}) {
		super(args.message, 1);
		this.name = "ExpectError";
		this.path = args.path;
		this.op = args.op;
		this.actual = args.actual;
		this.expected = args.expected;
	}
}
