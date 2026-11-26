export type PluginConfig = {
  /** Tenant origin, e.g. https://acme.config.mercura.io */
  origin: string;
  host: string;
  username: string | undefined;
  password: string | undefined;
  /** The plugin's data folder (backups of edited configurators). */
  dataDir: string;
  /** Edit tools are offered only when this is on (and the user is an admin). */
  allowEdits: boolean;
};

/** Where a user enters or fixes the login. The password is never asked for in the conversation. */
export const HOW_TO_LOG_IN =
  "Log in through Claude Code's plugin settings: run /plugin, open the Installed tab, select Mercura config-panel, choose Configure and enter your config-panel address, username and password (the password is kept in your computer's secure storage). Then run /reload-plugins. Do not type the password into the chat.";

export class NotConfiguredError extends Error {}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  // An unset ${user_config.x} can reach us literally; treat it as empty.
  if (!v || v.startsWith("${")) return undefined;
  return v;
}

export function normalizeOrigin(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new NotConfiguredError(`The config-panel address must use https (got ${url.hostname} over http). ${HOW_TO_LOG_IN}`);
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const hostInput = clean(env.CONFIG_PANEL_HOST);
  const username = clean(env.CONFIG_PANEL_USERNAME);
  const password = clean(env.CONFIG_PANEL_PASSWORD);
  const missing = [!hostInput && "address", !username && "username", !password && "password"].filter(Boolean);
  if (missing.length) {
    throw new NotConfiguredError(`You are not logged in to config-panel yet (missing: ${missing.join(", ")}). ${HOW_TO_LOG_IN}`);
  }
  let origin: string;
  try {
    origin = normalizeOrigin(hostInput!);
  } catch (error) {
    if (error instanceof NotConfiguredError) throw error;
    throw new NotConfiguredError(`"${hostInput}" is not a valid config-panel address. ${HOW_TO_LOG_IN}`);
  }
  return {
    origin,
    host: new URL(origin).host,
    username,
    password,
    dataDir: clean(env.CONFIG_PANEL_DATA_DIR) ?? `${env.HOME ?? env.USERPROFILE ?? "."}/.config-panel-plugin`,
    allowEdits: /^(1|true|yes|on)$/i.test(clean(env.CONFIG_PANEL_ALLOW_EDITS) ?? ""),
  };
}
