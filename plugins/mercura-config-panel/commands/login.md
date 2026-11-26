---
description: Log in to your config-panel and check the connection
---

Call the config-panel `connection_status` tool with `again: true`.

- If it succeeds, tell the user in one or two lines: which config-panel they are connected to, who is logged in and at which level, and whether edits to configurators are on.
- If it fails, show its message and walk the user through it: run `/plugin`, open the **Installed** tab, select **Mercura config-panel**, choose **Configure**, enter the config-panel address, username and password, save, then run `/reload-plugins` and `/mercura-config-panel:login` again.

Never ask for the username or password in the chat, and never repeat one the user pasted: the password belongs only in the plugin's settings, which keep it in the computer's secure storage.
