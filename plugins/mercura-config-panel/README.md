# Mercura config-panel for Claude

Work with your Mercura configurators from Claude, in the Claude desktop app or in Claude Code:

- **Configure and quote**: pick a configurator, answer its questions in a conversation, see the live price, save a draft or submit the quote. Claude runs the same engine as your storefront, so your rules, required answers and prices apply exactly.
- **Look things up**: your quotes and drafts, a quote's lines and totals, products and their prices, countries and languages.
- **Edit configurators (admins)**: rename, translate, re-price, hide or show, make questions required or optional, switch rules on or off. Every edit is previewed, needs your confirmation, is backed up first and checked afterwards, and can be undone.

## Requirements

- [Node.js](https://nodejs.org) 22 or newer.
- Your config-panel address, username and password.

## Install and log in

1. Install the plugin:
   - **Claude app (desktop)**: open **Customize → Plugins**, find **Mercura config-panel** and select **Install**. If you received the plugin as a `.zip` file, choose **Add plugin → Upload plugin** and select that file instead.
   - **Claude Code**: `/plugin install mercura-config-panel --marketplace mercura-aps/Claude-plugin`
2. Ask Claude anything about your config-panel, or run `/mercura-config-panel:login`. Claude replies with a **login link**.
3. Open the link. It is a small page that runs on your own computer, not a website. Enter:

   | Field | What to enter |
   |---|---|
   | config-panel address | The address you log in to config-panel at, e.g. `acme.config.mercura.io` |
   | Username or e-mail | Your config-panel login |
   | Password | Goes straight from your computer to your config-panel. It is never shown to Claude. It is not saved unless you tick **Remember me**. |
   | Allow Claude to edit configurators | Admins only, off by default. Tick it to let Claude change configurators, always after you confirm each change. |
   | Remember me on this computer | Optional, off by default. Saves your password in your computer's password store (macOS Keychain, Windows Credential Manager or the Linux keyring) so you stay logged in when Claude restarts. |

4. Go back to Claude and say you're done.

You log in once per Claude session; the page remembers your address and username for next time. To switch user or turn edits on or off, ask Claude to "log in again". Never type your password into the chat. If you did, change it in config-panel.

## Try it

- "Which configurators do we have?"
- "Configure a 24-month Business support plan for 40 users in manufacturing and tell me the price."
- "Make that a quote for Ada Lovelace at Analytical Engines, ada@example.com."
- "What did we quote last week?"
- "Rename the option Essential to Essential+ and raise its Danish price to 259." (admins, with edits on)

## Good to know

- Claude acts as you: it sees and does only what your config-panel user may.
- You log in once per Claude session. The session is kept in memory only. Your password is kept in memory too, unless you tick **Remember me on this computer** (see below).
- Prices include VAT and depend on the country.
- Claude never submits a quote or saves a change without asking you first. Every change is previewed, needs your confirmation, and configurator edits are backed up first so they can be undone.
- Backups of edited configurators and document templates are kept on your computer in the plugin's data folder; ask Claude to list them or to restore one.
- Not yet supported: repeatable groups (lines you add several times). Use config-panel's form builder for these.

## What the plugin runs, sends and stores

- **Runs**: one local program, `node server/index.mjs` (an MCP server), which Claude starts and stops. It installs nothing and downloads no code.
  - **Login page**: while you are not logged in, it serves the login page on your computer only (`127.0.0.1`, a random port, and a random one-time link that stops working after you log in).
  - **Your computer's password store, only if you tick "Remember me on this computer"**: to save, read or delete your password there, it runs the operating system's own password tool: `/usr/bin/security` on macOS (Keychain), `powershell.exe` with Windows' PasswordVault on Windows (Credential Manager), or `secret-tool` on Linux (the system keyring). It runs no other programs.
  - **Its code**: `server/index.mjs` is the plugin's own code, readable as is; its TypeScript source is in [`server/src`](https://github.com/mercura-aps/Claude-plugin/tree/main/server/src). `server/vendor.min.mjs` holds the third-party code it uses: Mercura's form SDK (the engine of config-panel's storefront) and the open-source packages listed with their licences in `server/THIRD_PARTY_NOTICES.txt`.
- **Connects to**:
  - **Your config-panel**: the address you enter on the login page, over HTTPS. This is where it sends your login and everything Claude does for you.
  - **Amazon S3, only when an admin uploads a file to the media library**: the file goes to the Amazon S3 storage address that your config-panel names for the upload, and to nothing else. The plugin refuses any address that is not `https://` on `amazonaws.com`.
  - **Addresses your configurator itself loads**: when Claude runs a configurator, the form SDK may load what that configurator is set up to load from other addresses, the same way your storefront does in a browser. Your login and session are only ever sent to your config-panel.
  - **Nothing else**: it sends nothing to Mercura's other systems, to Anthropic or to anyone else, and it has no telemetry. The customer dashboard links to Mercura's documentation at `docs.config.mercura.io`, but the plugin does not fetch it.
- **Sends to your config-panel**: your username and password to its login page; then what you ask Claude to do: reading configurators, quotes, products and settings; the answers of a configuration; a quote's customer details when you submit it; and changes you confirm, which for admins include configurators, rules, bills of materials, document templates, products, prices, VAT, discount groups, categories, media, users and appearance.
- **Reads from your computer**: only files you ask Claude to upload, from the full path you give: a picture, font or document for the media library, or a document template. Only the file types the upload accepts are read.
- **Shows Claude**: what those requests return, so configurator content, prices, users, and the names and e-mail addresses in quotes you look up enter your Claude conversation. Your password does not.
- **Stores on your computer**, in the plugin's data folder (`~/.claude/plugins/data/`, or `~/.config-panel-plugin` if Claude doesn't provide one), kept until you delete them:
  - **Your login details**: `login.json`, readable only by you. It holds your config-panel address, username, whether edits were allowed, and whether you ticked "Remember me". It never holds your password. It is used to pre-fill the login page.
  - **Your password, only if you tick "Remember me on this computer"**: saved in your operating system's password store (macOS Keychain, Windows Credential Manager or the Linux keyring) under the name `mercura-config-panel`, so you stay logged in when Claude restarts. Log in again without the box ticked, or delete the `mercura-config-panel` entry in that store, and it is removed. Without the box, your password stays in memory only and is gone when the session ends.
  - **Backups**: a JSON copy of a configurator's structure each time you save an edit to it, and a copy of a document template's file before you replace it, for undo.
  - **Downloaded templates**: a document template you ask Claude to download is saved in the data folder, or at the full path you give.
  - **Your session**: the config-panel session is never stored; it is kept in memory only.

## Licence

Proprietary, © Mercura ApS: see [LICENSE](LICENSE). Open-source components: [server/THIRD_PARTY_NOTICES.txt](server/THIRD_PARTY_NOTICES.txt).

Questions or problems: contact your Mercura implementation partner.
