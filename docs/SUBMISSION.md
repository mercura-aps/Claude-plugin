# Submitting to the Claude plugin directory

Submission happens in Anthropic's developer portal, from Mercura's claude.ai organization. It can't be done from the command line. Sources: [Publish to the directory](https://claude.com/docs/directory/publish), [Submit a plugin](https://claude.com/docs/plugins/submit), [Pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist).

This page is for **version 1.4.5**: login through a local login page, with an optional "Remember me on this computer" that uses the operating system's password store.

## Before you submit

1. **Who submits**: an **Owner** of Mercura's claude.ai organization on a Team or Enterprise plan (on Enterprise, also anyone with a custom role that has the **Directory** permission), or a Pro, Max or Ultra account. Free accounts can't submit. The first organization to submit this repository folder owns the listing, so submit from Mercura's organization account, not a personal one.
2. **Connect GitHub** on claude.ai in that organization, with a GitHub account that can push to `mercura-aps/Claude-plugin`. The portal checks push access before it lets you create or submit.
3. **Commit 1.4.5 to the repository**:
   - the TypeScript source in `server/src` that `server/index.mjs` is built from;
   - the built `plugins/mercura-config-panel/server/` folder;
   - all five skills: configure-and-quote, quotes-and-catalogue, edit-configurator, build-configurator and customer-dashboard;
   - `commands/login.md`, `plugin.json` and the README.
   - Bump `version` to 1.4.5 in `.claude-plugin/marketplace.json` as well.
4. **Keep binaries out of the plugin folder**. Never commit `mercura-config-panel.plugin` or any `.zip` inside `plugins/mercura-config-panel/`: archives are held for a reviewer. `release/` is git-ignored for that purpose.
5. **Check `server/index.mjs` size**. It is 239 KiB today, and any non-image file over 256 KiB is held for a reviewer. Check it with `ls -l plugins/mercura-config-panel/server/index.mjs` before each release. If it grows past 256 KiB, split it into several readable files.
6. **Keep the README true**. "What the plugin runs, sends and stores" must match the code exactly. A first submission that fails the security scan is rejected. Re-check it whenever the code changes what it runs, where it connects or what it stores.
7. **Test with a sandbox config-panel**: install from the repository, log in on the login page with and without "Remember me", restart Claude and check you're still logged in, configure, submit one quote, try one edit and its undo, and upload one picture to the media library.
8. **Validate locally**: run `claude plugin validate ./plugins/mercura-config-panel` and `claude plugin validate .`.
9. **Read** the [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) and the [Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms). The compliance step asks you to accept them.

## In the portal: claude.ai/directory/manage

1. **Submit new** → **Plugin bundle**.
2. **Source**
   - Repository: `mercura-aps/Claude-plugin`
   - Plugin path: `plugins/mercura-config-panel`
   - Branch or tag: leave empty to follow `main`, or give a release tag.
   - Select **Validate**. Fix anything marked **Blocking**, push the fix, then select **Re-validate**.
3. **Listing details** are read from `plugin.json` and the plugin's README. Check them:
   - Name `mercura-config-panel`, display name *Mercura config-panel*, author *Mercura*.
   - The description in `plugin.json` (1.4.5) is what the listing shows.
4. **Data handling**: suggested answers, based on what the 1.4.5 code does:

   | Question | Answer |
   |---|---|
   | Does it send data to services other than its declared connectors? | Yes. (1) The customer's own Mercura config-panel, at the address the user enters on the plugin's local login page, over HTTPS. All requests and the login go there. (2) Only when an admin uploads a file to the media library: that file goes to the Amazon S3 storage address the config-panel returns for the upload. The plugin refuses any address that is not `https://` on `amazonaws.com`. (3) When the form SDK runs a configurator, it may load resources the configurator is set up to load from other addresses, as the storefront does in a browser; no login, session or user data is added to those requests. Nothing goes to Mercura's other systems, to Anthropic or to third parties. There is no telemetry. |
   | What does it send there? | To config-panel: the user's username and password (to its login page), then the user's requests: reading configurators, quotes, products, users and settings; configuration answers; a quote's customer name, e-mail and request fields when the user submits it; and admin changes the user confirms (configurators, rules, bills of materials, document templates, catalogue, prices, VAT, discount groups, categories, media, users, appearance). To S3: only the file being uploaded and the upload form fields config-panel supplied. |
   | Does it read or store personal data? | **Reads** from config-panel when the user asks: names and e-mail addresses of customers on quotes, config-panel users (for admins), and the logged-in user's own name, e-mail and level. **Writes** customer contact details to config-panel when the user submits a quote, and user records when an admin confirms a user change. **Stores on the computer**: (a) `login.json` in the plugin data folder, file mode 0600, with the config-panel address, username, the edits setting and the "Remember me" flag, never the password; (b) only if the user ticks "Remember me on this computer", the password in the operating system's password store (macOS Keychain through `/usr/bin/security`, Windows PasswordVault through `powershell.exe`, Linux keyring through `secret-tool`), under the service name `mercura-config-panel`. The session cookie is kept in memory only. Backups hold configurator structure and document-template files, not personal data. |
   | How long is data kept? | Session: until the Claude session ends. `login.json`: until the user deletes it. Remembered password: until the user logs in again without "Remember me", or deletes the `mercura-config-panel` entry from the password store. Backups and downloaded templates: until the user deletes them (plugin data folder, `~/.claude/plugins/data/`). Quotes submitted live in the customer's config-panel under their agreement with Mercura. |
   | Intended for people under 18? | No. It is a business tool for the employees of Mercura's customers. |

5. **Compliance**: check the contact e-mail (use a Mercura address someone reads) and tick the four acknowledgements. This is Mercura's legal acceptance, so the person authorized to make it must do it.
6. **Review and submit**: keep **GitHub push webhook** selected, then select **Submit for review**. Repository admin access on GitHub is needed to set up the webhook. After review, select **Publish** on the passing version.

## What to expect from the review

- **Held for a reviewer: `server/vendor.min.mjs`.** It is minified and about 1 MiB, and code the scan can't read is held. This is a hold, not a rejection. To make the review quick, the plugin's own code stays readable in `server/index.mjs` (source in `server/src`), and `vendor.min.mjs` contains only third-party code, named in `server/THIRD_PARTY_NOTICES.txt`. Point the reviewer to `server/src/vendor.ts`, which lists the only APIs taken from it.
- **Held for a reviewer: "Scripts the validator couldn't follow".** The plugin is in a subfolder of the repository, and its MCP server runs a non-shell file (`node ${CLAUDE_PLUGIN_ROOT}/server/index.mjs`). The validator follows only plain shell scripts in that case. To avoid this hold, move the plugin to the root of a repository of its own (for example `mercura-aps/mercura-config-panel`). That has to be decided **before the first submission**, because a submission's repository and folder can't change later.
- **Likely looked at by a reviewer**:
  - the local login page on `127.0.0.1`;
  - the calls to the operating system's password tools for "Remember me";
  - the S3 upload.

  All three are described in the README's "What the plugin runs, sends and stores".
- **Limits**: 10 submissions per organization per 24 hours (drafts and withdrawals count), and one submission per repository folder.
- **Updates**: raise `version` in `plugin.json` (and `marketplace.json`) with every release. Each new version is scanned again, and published according to the plugin's publish setting.
