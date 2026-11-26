// Every third-party API the plugin's own code uses, in one place. The build bundles and
// minifies this file into plugins/mercura-config-panel/server/vendor.min.mjs (Mercura's
// form SDK and open-source libraries; licences in THIRD_PARTY_NOTICES.txt), and keeps the
// plugin's own code readable in index.mjs, importing from it.
import "fake-indexeddb/auto";
export { createSDKStore } from "@mercura-aps/frontend-form-sdk";
export { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
export { z } from "zod";
