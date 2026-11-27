---
name: build-configurator
description: For config-panel admins, build and change Mercura configurators and everything around them - configurators, steps, settings, rules, saved expressions, bill of materials, quote document templates, products, properties, VAT, discount groups, categories, media, users and storefront appearance. Use when an admin asks to build, create, set up or copy a configurator ("build a configurator like this website"), add a rule ("hide X when Y"), add products or prices, or set up VAT or dealer discounts.
---

# Build configurators and the catalogue

1. Call `connection_status` (if it gives a login link, send it, then call it again with `waitSeconds: 150` to be told when they are logged in). The user must be logged in, admin or higher, with edits on. If edits are off, call it again with `newLogin: true` and ask them to log in with "Allow Claude to edit configurators" ticked. Never ask for or use a password in the chat.
2. Read before writing: `list_configurators`, `get_form_outline` (ids of groups, elements and options), `list_rules` / `get_rule`, `list_products`, `get_localizations` (country slugs), `list_vat_and_discount_groups`.
3. Plan with the matching preview tool. Every preview saves nothing and returns a confirmation token:

| Job | Tool |
|---|---|
| New configurator with steps, questions, options | `preview_create_configurator` (keep `active` false until it is checked) |
| More steps on an existing one | `preview_add_configurator_steps` |
| Change labels, help, visibility, required, limits, defaults, option prices | `preview_form_edit` |
| Name, description, live/inactive, order, categories, header pictures, translations | `preview_form_settings` |
| New rule | `preview_create_rule` |
| Switch a rule on or off / delete it | `preview_rule_switch` / `preview_remove_rule` |
| Products by SKU (name, prices, cost prices, property values) | `preview_sync_products` |
| Product property with values | `preview_create_property` |
| VAT rate / discount group | `preview_vat_rate` / `preview_discount_group` |
| Bill of materials (parts list on the quote: channels, tables, columns, rows) | `get_bom`, `preview_bom` |
| Quote document templates (Word/Excel/HTML file on this computer) | `list_document_templates`, `download_document_template`, `preview_document_template` |
| Saved expressions (named conditions rules reuse with `savedExpressionId`) | `list_saved_expressions`, `preview_saved_expression` |
| Storefront categories (category, super, master) | `list_form_categories`, `preview_form_category` (assign with `preview_form_settings` categoryIds) |
| Media library (pictures, PDFs, fonts, 3D models from this computer) | `list_media`, `preview_media_upload`, `preview_media_delete` |
| Users (never passwords; new users use "Forgot password") | `list_users`, `preview_user` |
| Storefront appearance (colours, logos, fonts, texts) | `read_appearance`, `preview_appearance` |

4. Show the user the summary and warnings in a few lines. For configurator structure and rules (new configurator, new steps, edits, restores, new, switched or deleted rules), offer to try it first with `trial_change`: give the token and typical answers (by question label or id; new questions by label). It runs the storefront's own form engine on this computer on the live and the changed configurator and reports the differences: questions shown or hidden, required, values set by rules, option visibility and prices, total and messages. It saves nothing; the token stays valid. Rules that use saved expressions, and products, catalogue, VAT or appearance changes, cannot be tried this way; use a sandbox config-panel for those (log in to it with `connection_status` `newLogin: true`).
5. Only after an explicit yes, call `apply_form_change` with the token. Report the result (new ids, whether the check after saving passed).
6. Never repeat a create that may have half-succeeded: errors name the id that was created; continue from that id.

## Questions and options

Types: `radio` (pick one), `select` (dropdown), `checkbox` (pick any), `text`, `number` and `range` (need min and max). Mark required questions. Options take `prices` per country slug (none means 0 everywhere), `productIds` to add catalogue products, `quantity: {min, max}` for a quantity, `helpText` for an item number.

## Rules

- A condition is a tree. Leaves: `{value: {type: "option_selected", optionId}}`, `{value: {type: "value" | "is_empty" | "num_selected", elementId}}`, constants `{value: {type: "number" | "boolean" | "string", constant}}`. Operations: `and`/`or` (2+ children, keep them flat), `not` (1), comparisons `eq neq lt lte gt gte` (exactly 2, numeric children), arithmetic `add sub mul div min max round` and `concat` for text. Text is not compared with `eq`: test a choice with `option_selected`.
- Always-on rule: condition `{value: {type: "boolean", constant: true}}`.
- Effects target exactly one group, element or option. `require`/`optional`/`readonly` take an element only. `set`, `set_price`, `set_quantity` and the messages need an `expression`; a message needs a `concat` or `string` root.
- Pair every `hide` on an element with `optional` on the same element, or required hidden fields block the shopper. Pair `set` on a visible element with `readonly`. To pick an option from a rule, `set` the option with `boolean true` and `readonly` its element.
- Give rules an `order`: upstream rules run first.

## Products and pricing

- Products are shared by every configurator; a SKU that exists is updated. Property values passed as `attributeIds` are added to the SKU's existing ones.
- Discount `priceChange` needs a sign: `-10%` is ten percent off, `-50` fifty off.

## Files and pictures

- Files come from this computer by full path. Upload a picture with `preview_media_upload`; the applied result gives its media id for header pictures, category pictures or appearance image fields.
- To change a quote document: `download_document_template`, edit the file, then `preview_document_template` with `op: "replace_file"`. The old file is backed up first.
