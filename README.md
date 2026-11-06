<p align="center"><img src="logo.svg" width="72" alt="Glance"></p>

# Glance

**See what Claude is doing instead of reading it.**

Glance is a page that sits beside Claude Code. Every answer that's more than a one-liner lands there as a picture: cards, bars, steps, flowcharts, timelines. A voice talks you through it, so you can look instead of read. Every Claude Code session you have open gets its own place on the board, and you can reply to any of them, by typing or by holding the space bar and talking.

<!-- demo gif goes here -->

## Install

Inside Claude Code:

```
/plugin marketplace add adeiji/glance
/plugin install glance@glance
```

Or from a shell:

```
claude plugin marketplace add adeiji/glance
claude plugin install glance@glance
```

Then, in any session:

```
/glance:open
```

That starts the server and opens http://127.0.0.1:4777. From then on, every new session starts the server on its own and knows how to draw on the board, so there is nothing to add to your `CLAUDE.md`.

Requirements: Claude Code and Node, which you already have. Voice uses the built-in macOS speech engine; on Linux and Windows the board is silent.

## Settings

The gear at the top right of the page opens settings.

- **Terminal reply**: `full` (default) keeps the normal Claude Code answer in the terminal and adds the visual on the board; `short` leaves one line in the terminal pointing at the board. Applies to sessions started after the change.
- **Read aloud**, **chime** before a narration, and **speech rate** (Mac only).
- **Follow latest**: jump to whichever conversation updates.
- **Palette** and **appearance** for the page itself; these are per browser.

## Turning it off

Flip **Glance is on** at the top of settings, or run `/glance:off` in any session. New sessions are then plain Claude Code, with nothing added, until you flip it back or run `/glance:on`. A session that's already running keeps going as it was. To remove the plugin entirely, `/plugin uninstall glance@glance`.

The first time the page opens it gives a short tour. You can see it again from settings.

## What's on the page

- **Left**: your conversations. A dot marks one that has something new; an amber banner says when one is waiting on you.
- **Middle**: the board, oldest visual at the top, newest at the bottom. Click a visual to jump the chat to the reply that produced it. Hover one for a speaker button that reads it again, or a text button that shows the narration.
- **Right**: the chat for the selected conversation. Hold Space, or the mic button, to talk. Pick what Claude may do without asking from the menu under the box.
- **Top right**: palette and light/dark, a follow toggle that jumps to whichever conversation updates, and the voice toggle. Press Escape to stop narration.

## How it works

The plugin ships a small Node server, `server.js`, with no dependencies. A session-start hook gives every Claude Code session the rules in `BOARD.md`, which tell Claude how to write its section of the shared `board.html`. The server watches that file, archives every version, and renders it with the block language described in `VIZ.md` plus Mermaid. Chat from the page runs through the real `claude` command on your machine, so it uses your normal login and permissions.

Everything Glance writes lives in `~/.claude/glance`: the board file, per-conversation history, the log and the page token. Nothing leaves your machine.

Claude will ask once for permission to write `~/.claude/glance/board.html` from a session. Allow it always and it won't ask again.

## Updating

Users get a new copy whenever the version in `.claude-plugin/plugin.json` changes:

```
/plugin update glance@glance
```

or turn on auto-update under `/plugin` → Marketplaces.

## Developing

Clone the repo and add it as a local marketplace; edits are then read straight from the folder:

```
claude plugin marketplace add ./glance
claude plugin install glance@glance
```

`node server.js --open` starts the server and opens the page. The page reloads itself when `ui.html`, `board.css` or `viz.js` change; restart the server after editing `server.js`.

## License

MIT. Mermaid is bundled under its own MIT license, see `MERMAID-LICENSE`.
