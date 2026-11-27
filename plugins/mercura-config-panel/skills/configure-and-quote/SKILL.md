---
name: configure-and-quote
description: Configure a product in the user's Mercura config-panel, show the live price, and create a quote or draft. Use when the user wants to configure, price, spec out or quote a product, asks "what would X cost", wants a quote for a customer, or wants to continue a saved draft.
---

# Configure a product and quote it

The plugin runs Mercura's own storefront engine, so the configurator's rules decide what can be chosen, what is required and what it costs. Your job is to walk the user through it in plain words and never invent answers, options or prices.

## Steps

1. `connection_status` logs in and shows the config-panel and the user's level. If it returns `loginUrl`, give the user that link and ask them to log in on that page and tell you when they're done; then call `connection_status` again. If it fails, show its message and stop. Never ask for or accept a password in the chat.
2. Find the configurator: `list_configurators`. If several fit, ask which one.
3. `start_quote`. Pass `country` when the user names a market (prices and currency follow the country); `get_localizations` lists them.
4. `add_configuration` with the form id. Read what comes back:
   - `sections` → `elements`: the questions, each with `id`, `label`, `type`, `required`, current `value` and the `options` available right now (with `price` when it adds to the total).
   - `missingRequired`: what still has to be answered.
   - `total`: the running price, **VAT included** (`vatIncluded` is the VAT inside it).
   - `messages`: notes, warnings and errors from the configurator's rules: always pass these on.
5. Ask for the missing answers in the configurator's own words, a few at a time, starting with `missingRequired`. Offer the listed options; do not offer options that are not listed (the rules hide them for a reason).
6. `set_answers` with everything the user told you in one call. Refer to elements and options by `id` (safest), Slug or exact label. A checkbox takes a list; a radio or select takes one option; number and text elements take the value. Option quantities go in `quantities`.
   - Read `notes`: the rules may have changed or cleared other answers; tell the user.
   - An error names the valid options or limits: correct and retry, or ask the user.
7. Repeat 5–6 until `missingRequired` is empty. For more lines in the same quote, `add_configuration` again (each line is a configuration; `set_configuration_quantity` sets how many).
8. Before submitting:
   - `get_request_fields`, ask for the required ones, then `set_contact_details` (customer name, e-mail, and fields by Slug).
   - Show the user a summary: each line's key answers and total, the quote total with VAT, and the contact details.
   - Ask explicitly: "Shall I submit this quote?" Submitting creates the quote in config-panel and can e-mail the customer.
9. Only after a clear yes: `submit_quote` with `confirmed: true`. Report the quote id and document links.
   - If config-panel refuses (e.g. "does not match constraints"), report the message as it is; do not retry with changed answers unless the user asks.

## Drafts and copies

- `save_draft` keeps the quote in config-panel without submitting it; saving again updates it. Give the user the draft id.
- `open_draft` continues a draft; `copy_quote` starts a new quote from a submitted one. Both recalculate today's prices: point out when totals differ from what the user expects.

## Good to know

- Prices always include VAT; a price depends on the country.
- Hidden or read-only elements are set by the configurator; you cannot answer them.
- Repeatable groups (lines the shopper adds several times) cannot be filled in through this plugin yet: say so and suggest finishing that part in config-panel.
- A quote in progress lives only in this session until it is saved as a draft or submitted.
