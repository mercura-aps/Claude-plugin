---
description: Log in to your config-panel and check the connection
---

Call the config-panel `connection_status` tool. If the user asked to switch user or to turn edits on or off, or says the login link has expired or doesn't work, pass `newLogin: true`: that always returns a brand-new link.

- If it returns `loginUrl`, give the user that link as a clickable link: "Open this link to log in to your config-panel. It's a page on your own computer: enter your config-panel address, username and password there. Tick 'Remember me on this computer' to stay logged in when Claude restarts." Then call `connection_status` with `waitSeconds: 150`: it answers as soon as they have logged in, so they do not need to tell you. If it is still waiting, remind them of the link and call it again. If it then shows `lastLoginError`, tell the user and give them the link again.
- If it shows the user as logged in, tell the user in one or two lines: which config-panel they are connected to, who is logged in and at which level, and whether edits to configurators are on.
- If it fails, show its message.

Never ask for the username or password in the chat, and never repeat one the user pasted: the password belongs only on the login page. If they pasted one, suggest they change it in config-panel.
