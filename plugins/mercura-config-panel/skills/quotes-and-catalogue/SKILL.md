---
name: quotes-and-catalogue
description: Look up quotes, drafts, products, countries and languages in the user's Mercura config-panel. Use when the user asks about existing quotes or orders ("what did we quote Acme", "last week's quotes", "total of quote 1234"), wants to reopen or copy a quote, or asks about products, SKUs or prices in the catalogue.
---

# Quotes and catalogue

## Quotes

- `list_quotes` (newest first, pages of up to 100). Customers see their own quotes; sellers and admins see every quote of the company.
- `get_quote` with the id: customer, request fields, totals and each configured line with its answers.
- Totals include VAT; `vatIncluded` is the VAT part. For a net figure subtract it: never add VAT on top.
- To change a submitted quote, `copy_quote` starts a new quote from it (see the configure-and-quote skill). A submitted quote itself cannot be edited.

## Drafts

- `get_draft` reads a saved draft; `open_draft` continues it.

## Catalogue

- `list_products` (needs a seller or admin login) pages through products with SKU, name and price rows per country (`countryId`; `get_localizations` names the countries). `search` filters the page by SKU or name; look through further pages when nothing matches.
- A product's price on a quote can differ from its list price: discount groups, rules and realtime prices apply. For "what would this cost", configure it (configure-and-quote) instead of reading list prices.

Report figures as config-panel returns them, with the currency, and say which page you looked at when a list was long.
