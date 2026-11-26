# Submitting to the Claude plugin directory

Submission happens in Anthropic's developer portal, from Mercura's claude.ai organization; it cannot be done from the command line. Sources: [Publish to the directory](https://claude.com/docs/directory/publish), [Submit a plugin](https://claude.com/docs/plugins/submit), [Pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist).

## Before you submit

1. **Who submits**: a claude.ai Team or Enterprise **Owner** of Mercura's organization (on Enterprise also a custom role with the **Directory** permission), or a Pro/Max account. Free accounts cannot submit. The first organization to submit this repository folder owns the listing, so submit from Mercura's organization account, not a personal one.
2. **Repository**: done, [mercura-aps/Claude-plugin](https://github.com/mercura-aps/Claude-plugin) is public, with `main` as its branch. `server/vendor/` and the local workspace files stay out through `.gitignore`.
3. **Build with the newest form SDK**: `cd server && node scripts/fetch-sdk.mjs && npm install && npm test`, commit the rebuilt `plugins/mercura-config-panel/server/`. (The current build contains SDK 1.13.0-r.3; Forms that use `root` or `log` need 1.13.0-r.7 or later.)
4. **Test with a sandbox config-panel** (see "Not verified yet" in [PLAN.md](PLAN.md)): install from the repository, log in in the Configure dialog, run `/mercura-config-panel:login`, configure, submit one quote, try one edit and its undo.
5. **Validate locally**: `claude plugin validate ./plugins/mercura-config-panel` and `claude plugin validate .` (both pass today).
6. **Read** the [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) and [Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms): the compliance step asks you to accept them.

## In the portal: claude.ai/directory/manage

1. **Submit new** → **Plugin bundle**.
2. **Source**
   - Repository: `mercura-aps/Claude-plugin`
   - Plugin path: `plugins/mercura-config-panel`
   - Branch or tag: leave empty to follow `main` (or a release tag such as `mercura-config-panel--v0.1.0`, made with `claude plugin tag`).
   - **Validate**; fix anything marked **Blocking**, push, **Re-validate**.
3. **Listing details** are read from `plugin.json` and the plugin's README. Check them:
   - Name `mercura-config-panel`, display name *Mercura config-panel*, author *Mercura*.
   - Description: *Work with your Mercura configurators from Claude: configure products, see live prices, create quotes, look up quotes and products, and (for admins) edit configurators safely.*
4. **Data handling**: suggested answers, based on what the code does:

   | Question | Answer |
   |---|---|
   | Does it send data to services other than its declared connectors? | Yes, to exactly one: the customer's own Mercura config-panel, at the address the user enters at install (HTTPS only; the server refuses any other host). Nothing goes to Mercura's other systems, to Anthropic or to third parties; there is no telemetry. |
   | What does it send there? | The user's config-panel username and password (to its login page), and the user's requests: reading configurators, quotes and products; configuration answers; a quote's customer name, e-mail and request fields when the user submits it; configurator edits the user confirms. |
   | Does it read or store personal data? | It reads personal data from config-panel when the user asks for it: names and e-mail addresses of customers on quotes, and the logged-in user's own name, e-mail and level. It writes customer contact details when the user submits a quote. It stores no personal data on the computer: the password is held by Claude Code's secure storage, the session only in memory; the local backups contain configurator structure only. |
   | How long is data kept? | The session: until the Claude Code session ends. Configurator backups: until the user deletes them (`~/.claude/plugins/data/`). Quotes the user submits live in the customer's config-panel under their agreement with Mercura. |
   | Intended for people under 18? | No: a business tool for Mercura's customers' employees. |

5. **Compliance**: check the contact e-mail (use a monitored Mercura address) and tick the four acknowledgements. This is Mercura's legal acceptance, so it must be done by the person authorized to make it.
6. **Review and submit**: keep **GitHub push webhook** (new pushes to the tracked branch are picked up), then **Submit for review**. After review, **Publish** the passing version (or turn on auto-publish).

## What to expect from the review

- **Held for a reviewer: `server/vendor.min.mjs`.** It is minified and over 256 KiB (about 1 MiB), and the checklist says code the scan can't read is held for a reviewer. This is a hold for manual review, not a rejection. To make that review quick, the plugin's own code is kept readable in `server/index.mjs` (84 KiB, with its source in `server/src`), and `vendor.min.mjs` contains only the third-party code, named in `server/THIRD_PARTY_NOTICES.txt`. If the reviewer asks, point them to `server/src/vendor.ts`, which lists the only APIs the plugin takes from it.
- **Possibly checked by a reviewer**: the username-and-password login. It follows the checklist (`userConfig` with `sensitive: true`, passed as `${user_config.password}`, never in a file), and the README describes where it goes.
- **Security scan** looks for undisclosed behaviour; everything the server runs, sends and stores is in the README's "What the plugin runs, sends and stores". A first submission that fails the scan is rejected, so keep that section true when the code changes.
- **Limits**: 10 submissions per organization per 24 hours (drafts and withdrawals count); one submission per repository folder.
- **Updates**: raise `version` in `plugin.json` with every release; each new version is checked and reviewed again before it goes live.
