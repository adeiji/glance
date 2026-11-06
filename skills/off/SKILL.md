---
name: off
description: Turn Glance off so new Claude Code sessions answer in the terminal only, with no board. Use when the user asks to turn off, pause, disable or stop Glance or the board.
---

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/server.js" --off
```

Then tell the user in one line that Glance is off for new sessions, that this session keeps its current behaviour until it ends, and that `/glance:on` brings it back. From now on in this session, answer in the terminal only and don't write to the board.
