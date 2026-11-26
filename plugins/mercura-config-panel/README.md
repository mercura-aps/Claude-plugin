# Mercura config-panel for Claude

Work with your Mercura configurators from Claude Code (and Claude Desktop / Cowork):

- **Configure and quote**: pick a configurator, answer its questions in a conversation, see the live price, save a draft or submit the quote. Claude runs the same engine as your storefront, so your rules, required answers and prices apply exactly.
- **Look things up**: your quotes and drafts, a quote's lines and totals, products and their prices, countries and languages.
- **Edit configurators (admins)**: rename, translate, re-price, hide or show, make questions required or optional, switch rules on or off. Every edit is previewed, needs your confirmation, is backed up first and checked afterwards, and can be undone.

## Requirements

- [Node.js](https://nodejs.org) 22 or newer.
- Your config-panel address, username and password.

## Install and log in

1. In Claude Code, run `/plugin`, find **Mercura config-panel** and install it, or install it in one step:

   ```
   /plugin install mercura-config-panel --marketplace mercura-aps/Claude-plugin
   ```
2. Claude Code asks you to log in to your config-panel right away:

   | Setting | What to enter |
   |---|---|
   | config-panel address | The address you log in to config-panel at, e.g. `acme.config.mercura.io` |
   | Username or e-mail | Your config-panel login |
   | Password | Kept in your computer's secure storage (macOS Keychain, Windows Credential Manager). It is never written to a settings file and never shown to Claude. |
   | Allow edits | Admins only, off by default. Turn it on to let Claude change configurators, always after you confirm each change. |

3. Run `/reload-plugins`, then `/mercura-config-panel:login` to check the connection.

Change the login later with `/plugin` → **Installed** → **Mercura config-panel** → **Configure**. Never type your password into the chat. If you did, change it in config-panel.

## Try it

- "Which configurators do we have?"
- "Configure a 24-month Business support plan for 40 users in manufacturing and tell me the price."
- "Make that a quote for Ada Lovelace at Analytical Engines, ada@example.com."
- "What did we quote last week?"
- "Rename the option Essential to Essential+ and raise its Danish price to 259." (admins, with edits on)

## Good to know

- Claude acts as you: it sees and does only what your config-panel user may.
- The plugin logs in once per Claude Code session and keeps that session only in memory.
- Prices include VAT and depend on the country.
- Claude never submits a quote or saves an edit without asking you first.
- Backups of edited configurators are kept on your computer in the plugin's data folder; ask Claude to list them or to restore one.
- Not yet supported: repeatable groups (lines you add several times), adding or removing questions and options, writing rules. Use config-panel's form builder for these.

## What the plugin runs, sends and stores

- **Runs**: one local program, `node server/index.mjs` (an MCP server), which Claude Code starts and stops. It installs nothing, downloads nothing and runs no other programs. `server/index.mjs` is the plugin's own code, readable as is (its TypeScript source is in [`server/src`](https://github.com/mercura-aps/Claude-plugin/tree/main/server/src)). `server/vendor.min.mjs` holds the third-party code it uses: Mercura's form SDK (the engine of config-panel's storefront) and open-source packages listed with their licences in `server/THIRD_PARTY_NOTICES.txt`.
- **Connects to**: only the config-panel address you enter, over HTTPS. It refuses requests to any other host. It sends nothing to Mercura, Anthropic or anyone else beyond that config-panel, and it has no telemetry.
- **Sends to your config-panel**: your username and password to its login page; then what you ask Claude to do: reading configurators, quotes and products, the answers of a configuration, a quote's customer details when you submit it, and configurator edits you confirm.
- **Shows Claude**: what those requests return, so configurator content, prices, and the names and e-mail addresses in quotes you look up enter your Claude conversation. Your password does not.
- **Stores on your computer**: your password in the operating system's secure storage, which Claude Code manages; the login session in memory only, gone when the session ends; and a JSON copy of a configurator's structure each time you save an edit to it (for undo), in the plugin's data folder (`~/.claude/plugins/data/`), kept until you delete it.

## Licence

Proprietary, © Mercura ApS: see [LICENSE](LICENSE). Open-source components: [server/THIRD_PARTY_NOTICES.txt](server/THIRD_PARTY_NOTICES.txt).

Questions or problems: contact your Mercura implementation partner.
