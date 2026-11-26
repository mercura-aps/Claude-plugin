# config-panel Claude plugin: design and plan

## Goal

A Claude plugin Mercura's customers install to talk to their own config-panel Tenant: configure and quote; look up quotes and catalogue; admins edit configurators.

## Decisions (agreed 2026-11-26)

| Question | Decision | Consequence |
|---|---|---|
| Scope | All three: configure & quote, look up, edit | Edits gated twice: an admin login **and** the "Allow edits" setting (off by default). |
| Runtime | Local MCP server bundled in the plugin | One self-contained server (no install, no registry access); the customer needs Node 22+. Claude Code / Cowork; not claude.ai web connectors. |
| Auth | Username + password login, asked for first | config-panel's admin half has no API tokens (Sanctum covers only `GET /api/user`), so the server logs in like the login page does. Address, username and password are **required** `userConfig` options: Claude Code asks for them in its Configure dialog right after install. The password is `sensitive`, so it goes to the OS secure storage and is never in settings.json or the conversation. The session cookie is held in memory only (one login per Claude Code session). Until the login is set, the server offers only `connection_status`, which explains how to log in. |
| Distribution | Claude's plugin directory, from the public repo `mercura-aps/Claude-plugin` | Plugin name `mercura-config-panel` (the directory holds generic names). Steps and portal answers: [SUBMISSION.md](SUBMISSION.md). Until listed, customers can add the repository as a marketplace. |
| SDK in a public repo | Minified (agreed 2026-11-26) | The build writes the plugin's own code readable (`server/index.mjs`) and only third-party code minified (`server/vendor.min.mjs`, with `THIRD_PARTY_NOTICES.txt`). The unminified SDK (`server/vendor/`) is never committed; `server/scripts/fetch-sdk.mjs` fetches it from Mercura's registry for builds. The directory holds minified and >256 KiB files for a reviewer, so expect a manual review of `vendor.min.mjs`. |

## Status (2026-11-26)

| Step | State |
|---|---|
| Public repository [mercura-aps/Claude-plugin](https://github.com/mercura-aps/Claude-plugin), with source, tests and test data (agreed to publish all) | `main` is 0.1.0. Version 0.1.1 is on branch `plugin-0.1.1` (push to `main` is protected; a person merges the pull request) |
| Newest form SDK in the build (`server/scripts/fetch-sdk.mjs`, rebuild, commit) | Done on `plugin-0.1.1`. The build contains `@mercura-aps/frontend-form-sdk` 1.13.0-r.8 and `@mercura-aps/frontend-schemas` 1.28.0. `npm test`: 22 checks passed |
| Test with a sandbox config-panel (list below) | To do by Mercura |
| Submission to the Claude plugin directory ([SUBMISSION.md](SUBMISSION.md)) | To do by Mercura's organization Owner, after the two steps above |

## Architecture

- **Session** (`server/src/session.ts`): `GET /dashboard/login` (scrape `_token`), `POST /dashboard/login`, `GET /dashboard/dashboard` (scrape `csrf-token`). Re-login once on 401/419/redirect to login. Ported from mercura-cowork `mercura-scripts-client/transport/cpq-auth.ts`.
- **Quote engine** (`server/src/engine/`): Mercura's `@mercura-aps/frontend-form-sdk` store, run headless as in `form-sdk-cli` (polyfills, a fetch gateway that sends the SDK's relative `/api/...` calls to the Tenant with the session cookie). The rules, visibility, required state, prices, BoM and the submit/draft payloads are the storefront's own, so a submitted quote passes the backend's constraint re-check. config-panel computes no price before submit, so this is the only way to price a configuration faithfully.
- **Admin** (`server/src/admin/`): admin Form GET → postable body with mercura-cowork's `form-patch.ts` (vendored), in-place edits, whole-Form `POST /dashboard/api/form/{id}`. Every write is preview (diff + single-use token, 30 min) → user's yes → re-read and refuse if changed → local backup → save → read-back check. Rule on/off via `PUT /dashboard/form/{id}/formula-constraint-meta/{rule}`.
- **Tools**: 22 (17 read/configure; 5 edit tools registered only with "Allow edits"; only `connection_status` until the login is set), plus the `/mercura-config-panel:login` command. Skills teach the workflows and the pitfalls (hide ≠ optional; prices per country incl. VAT; a missing country price is 0; confirm before submit or save).

## Verified

- `npm test`: 22 end-to-end checks. The built server is launched over MCP stdio, as Claude Code does, against a **mock** Tenant that serves the Demo Form 1545 backup through form-sdk-cli's backup → public-API adapter. The checks cover login and session reuse; configuring by id, Slug and label with the real rules and prices; the SDK's submit payload; quote lookup; previews, apply, backup, read-back and single-use tokens; edit tools hidden when off; no login set (only the login tool, with how to log in); a wrong password (not echoed); nothing secret written to disk.
- `claude plugin validate` passes for the plugin and the marketplace.

## Not verified yet (needs a sandbox Tenant)

1. Login, CSRF and session handling against a real hosted Tenant (including SSO-only Tenants, where username + password will not work).
2. `submit_quote` end to end: the backend's constraint re-check, document rendering, the answer's request id field (the SDK's schema has no id; the tool looks for `request_id`/`id`).
3. `list_quotes` response shape of `GET /api/requests` and `get_quote` of `/api/request/{id}/full` (taken from mercura-cowork's resources; summaries may need field names adjusted).
4. The whole-Form save with real data; the read-back check; restore of a backup with deleted nodes.
5. Rule on/off through `formula-constraint-meta` (PUT body taken from cowork's category update).
6. The install flow in a real Claude Code: the Configure dialog right after `/plugin install`, the password landing in the keychain, the MCP server getting it after `/reload-plugins`. Also Claude Desktop / Cowork, whose settings UI for plugins is not checked.

## Roadmap

- **0.2**: run the list above against a sandbox Tenant; newest SDK from Verdaccio in CI; repeatable groups (add/remove lines); quote documents download; drafts list for sellers.
- **0.3**: structure edits (add/remove options and elements, with the constraint-usage check before removing); product price edits (catalogue sync is queued and tenant-wide: needs its own preview/read-back design).
- **Later**: rule authoring (the multi-request formula builder API; port from mercura-cowork `rule-patch.ts` / the IIE's tools); a hosted remote MCP with OAuth so it works as a claude.ai connector, once config-panel has tokens.

## Open questions for Mercura

- **Licence**: `LICENSE` is a draft proprietary licence (Mercura ApS) covering the plugin and the SDK. Have it reviewed; if the plugin's own code should be open source (e.g. MIT) while the SDK stays proprietary, split the licence.
- **Support boundary**: is "Allow edits" offered to every customer admin, or only after onboarding?
- **Overlap**: mercura-cowork's `mercura-cpq` plugin is the internal tool. Should this customer plugin live in that marketplace (sharing transport code as a package) or stay separate as here?
