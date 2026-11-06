---
name: open
description: Open the Glance page (the visual board beside Claude Code). Use when the user asks to open, show, start or restart Glance or the board, or says the board isn't running.
---

Run this command, which starts the Glance server if it isn't running and opens the page in the browser:

```
node "${CLAUDE_PLUGIN_ROOT}/server.js" --open
```

Then tell the user in one line that Glance is open at the address the command printed. Your answers from here on follow the Glance rules already in this session: put anything beyond a one-liner on the board as a visual with a spoken narration, and keep the text reply to a sentence pointing at it.
