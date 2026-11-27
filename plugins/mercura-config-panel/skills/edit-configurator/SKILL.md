---
name: edit-configurator
description: For config-panel admins, change an existing configurator in Mercura config-panel. Covers labels and help texts, translations, hiding or showing options and questions, making questions required or optional, limits and defaults, option quantities and option prices per country, and switching rules on or off, with a preview, confirmation, backup and undo. Use when an admin asks to rename, reprice, hide, show, require, translate or fix something in a configurator, to look at its rules, or to undo an earlier edit.
---

# Edit a configurator (admins)

Edits change the live configurator for every shopper as soon as they are saved (the storefront may take up to 10 minutes to show them). The plugin protects against mistakes: preview → confirm → backup → save → check. Never skip the confirmation.

If the edit tools (`preview_form_edit`, `apply_form_change`) are missing, edits are switched off: call `connection_status` with `newLogin: true`, give the user the login link, and ask them to log in again with **Allow Claude to edit configurators** ticked. It needs an admin login.

## Steps

1. `get_form_outline` with the form id. Find the exact group, element and option ids, and the country ids for prices. If the user's words match several nodes, ask which.
2. `list_rules` when the change touches visibility, required state or prices: a rule may show, hide, require or price the same node and undo the edit at runtime. Mention any such rule to the user.
3. `preview_form_edit` with all related edits in one call and a `reason` in the user's words. Nothing is saved.
4. Show the user the `changes` list and every `warning` as returned, then ask: "Shall I save this?"
5. Offer to try it first: `trial_change` with the same `confirmationToken` and a few typical answers runs the storefront's own form engine on this computer, on the live and on the changed configurator, and lists what differs. It saves nothing and keeps the token valid.
6. Only after an explicit yes: `apply_form_change` with the `confirmationToken`. A token works once and expires after 30 minutes.
6. Report the result:
   - `verified: true`: every edited field reads back as intended.
   - `mismatches`: name them; config-panel did not keep those values.
   - `backupId`: the way back.
   - An error that the configurator "changed since the preview" means someone else saved it. Preview again; do not reuse the old token.

## Rules of thumb

- **Hiding is not optional.** An element hidden with `active: false` that is still `required` blocks the quote with no visible error. When you hide a required element, also set `state: "open"`.
- **Prices** are per country, in major units, **VAT included**. A country without a price row prices the option at 0: when the user gives one price, ask about the other countries in the outline. An option linked to a product takes the product's price; change that in the catalogue instead.
- **Min and max** of number elements are whole numbers (use mm rather than m).
- **Defaults**: for select and radio, `defaultValue` is an option id; for checkboxes use `isDefault` on the options.
- **Translations** use config-panel's keys, e.g. `{"da_label": "Bredde", "de_sub_text": "…"}`.
- Rules can only be switched on or off here (`preview_rule_switch`). Writing or changing rules, and adding or removing groups, elements or options, is done in config-panel's form builder. Say so instead of working around it.

## Undo

- `list_form_backups` lists the backups taken before each save on this computer.
- `preview_restore_form` with a `backupId` shows what would change back. Apply it with `apply_form_change` after the user confirms. Restoring takes a fresh backup first, so it can be undone too.
- Rule on/off switches are undone by switching back.
