export const DEFAULT_LANGUAGE = {
	id: 1,
	name: "English",
	slug: "en",
};

export const DEFAULT_CURRENCY = {
	id: 1,
	name: "Euro",
	code: "EUR",
	symbol: "€",
	number: 978,
	digits: 2,
	symbol_position: "LEFT" as const,
};

export const DEFAULT_COUNTRY = {
	id: 1,
	name: "Denmark",
	slug: "dk",
	currency: DEFAULT_CURRENCY,
	language: DEFAULT_LANGUAGE,
};

export const DEFAULT_LOCALIZATION = {
	language: DEFAULT_LANGUAGE,
	country: DEFAULT_COUNTRY,
	currency: DEFAULT_CURRENCY,
};

export const EMPTY_PAGINATED_FORMS = {
	current_page: 1,
	first_page_url: "/api/forms?page=1",
	from: null,
	last_page: 1,
	last_page_url: "/api/forms?page=1",
	links: [],
	next_page_url: null,
	path: "/api/forms",
	per_page: 25,
	prev_page_url: null,
	to: null,
	total: 0,
	data: [],
};

export const EMPTY_BOM = {
	id: 0,
	hide_on_checkout: false,
	hide_on_pdf: false,
	hide_on_excel: false,
	hide_on_email: false,
	tables: [],
	summary: null,
};

export const ANONYMOUS_AUTH = { authenticated: false };

export const DEFAULT_OPTIONS = {
	primary_form_id: "1",
	allow_multiple_forms: "0",
	allow_multiple_submissions: "0",
	category_levels: "0",
};

export const OFFLINE_ORIGIN = "http://fixture.local";

export function stubJson(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
