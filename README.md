# Mercura config-panel plugin for Claude

The source repository of **Mercura config-panel**, a Claude plugin Mercura's customers install to work with their config-panel from Claude: configure and quote, look up quotes and the catalogue, and (admins) make guarded edits to configurators. For customers: see [plugins/mercura-config-panel/README.md](plugins/mercura-config-panel/README.md).

Install from this repository as a marketplace:

```
/plugin install mercura-config-panel --marketplace mercura-aps/Claude-plugin
```

## Layout

```
.claude-plugin/marketplace.json            the "mercura" marketplace (this repository)
plugins/mercura-config-panel/              the plugin, as submitted to the Claude plugin directory
  .claude-plugin/plugin.json               manifest: login settings (userConfig) and the MCP server
  commands/login.md                        /mercura-config-panel:login
  skills/                                  configure-and-quote, quotes-and-catalogue, edit-configurator
  server/index.mjs                         built: the plugin's own code, readable
  server/vendor.min.mjs                    built: Mercura's form SDK and open-source libraries, minified
  server/THIRD_PARTY_NOTICES.txt           built: licences of what vendor.min.mjs contains
  README.md, LICENSE
server/                                    the MCP server's source and tests (not part of the installed plugin)
  src/session.ts                           login with username + password; session cookie + CSRF, in memory only
  src/engine/                              Mercura's form SDK run headless (polyfill, fetch gateway, quote)
  src/admin/                               admin reads, previewed edits, backups, restore
  src/tools.ts, src/index.ts               the MCP tools and server
  src/vendor.ts                            the third-party APIs the code uses (built into vendor.min.mjs)
  scripts/fetch-sdk.mjs                    fetches the form SDK from Mercura's registry into vendor/ (not committed)
  test/                                    mock config-panel + end-to-end smoke test
docs/PLAN.md                               design, decisions, what is verified, roadmap
docs/SUBMISSION.md                         how to submit to the Claude plugin directory, with the answers
```

## Develop and release (Mercura)

Needs Node 22+ and read access to Mercura's registry (`npm.pkg.mercura.io`) for the form SDK.

```bash
cd server
node scripts/fetch-sdk.mjs     # newest form SDK into vendor/ (pass exact versions to pin)
npm install
npm run typecheck
npm test                       # builds plugins/mercura-config-panel/server/, then runs the smoke test against the mock config-panel
claude --plugin-dir ../plugins/mercura-config-panel   # try it in Claude Code without installing
```

To release:

1. Raise `version` in `plugins/mercura-config-panel/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
2. `cd server && npm test`.
3. Commit the source and the built `plugins/mercura-config-panel/server/` together, and push. The plugin directory picks up the new version from the tracked branch; it is reviewed again before it goes live.

`server/vendor/` (the unminified SDK) is never committed. The form SDK reaches the public repository only as part of the minified `vendor.min.mjs`.
