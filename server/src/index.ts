#!/usr/bin/env node
// MCP server of the Mercura config-panel Claude plugin (stdio).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdminService } from "./admin/admin.ts";
import { loadConfig } from "./config.ts";
import { QuoteEngine } from "./engine/quote.ts";
import { SessionManager } from "./session.ts";
import { registerTools } from "./tools.ts";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const INSTRUCTIONS = `Tools for one Mercura config-panel (CPQ) installation: configure products, price them, and create quotes, look up quotes and the catalogue, and (for admins, when edits are switched on) change configurators.
- First, before anything else: call connection_status. It logs in with the user's saved login. If it fails, show its message and stop until the user has fixed the login in /plugin → Mercura config-panel → Configure.
- Never ask for, accept or repeat a username or password in the conversation. If the user pastes a password, do not use it; tell them to enter it in the plugin's settings instead and to consider changing it.
- A quote is built in a headless copy of the storefront: the configurator's own rules run, so visibility, required answers and prices are exactly what a shopper sees. Prices include VAT.
- Never submit a quote, save a configurator edit or restore a backup without showing the user what will happen and getting an explicit yes.`;

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Start anyway so the user sees why in the first tool answer.
    const server = new McpServer({ name: "config-panel", version: VERSION }, { instructions: INSTRUCTIONS });
    server.registerTool(
      "connection_status",
      {
        title: "Log in",
        description: "The plugin is not logged in to config-panel yet. Call this and show the user how to log in.",
        inputSchema: {},
      },
      async () => ({ isError: true, content: [{ type: "text", text: (error as Error).message }] }),
    );
    await server.connect(new StdioServerTransport());
    return;
  }
  const sessions = new SessionManager(config);
  const quote = new QuoteEngine(sessions);
  const admin = new AdminService(sessions);
  const server = new McpServer({ name: "config-panel", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, { sessions, quote, admin });
  // The SDK writes diagnostics with console.log in places; stdout belongs to MCP.
  console.log = (...args: unknown[]) => console.warn(...args);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.warn(error);
  process.exit(1);
});
