# Writing a board section

Sections live in the Glance board file (`~/.claude/glance/board.html` unless the rules say otherwise). Each session owns one `<section>`; replace yours, or insert it right after `<!-- SECTIONS -->` the first time. Delete sections whose `data-updated` is older than 24 hours.

```html
<section id="session-<first 8 of id>" data-session="<full session id>" data-cwd="<cwd>" data-updated="<ISO time>">
<header><span><b>project-folder</b> — short title</span><time>session 1a2b3c4d · 19:05 UTC</time></header>

<pre class="viz">
…blocks (below)…
</pre>

<pre class="mermaid">
flowchart LR
  A[Session] --> B[board.html] --> C[Board app]
</pre>

<p data-say hidden>Spoken narration. Put any `file name` or `identifier` in backticks.</p>
<p data-say-update hidden>Only when revising a visual you already posted: one short line on what changed, e.g. "Updated the visual to show the new deadline." The board reads this instead of repeating the narration.</p>
</section>
```

The page renders `pre.viz` and `pre.mermaid` into styled visuals, light and dark. When your new section is a small change to the previous one, the board updates it in place rather than stacking a new visual; include `data-say-update` so the user hears only what changed. Several blocks of either kind can follow one another. Hand-drawn SVG is only for mockups and illustrations these can't express.

## viz blocks

A block starts at column 0. Its items are indented 2 spaces; an item's detail lines 4 spaces. Backticks make `code`. Colors: `green amber red blue purple gray`.

```
title: One-line heading for what follows

text: A sentence or two of plain explanation when a picture can't say it.

cards
  Electron | recommended | green
    server.js is already Node, drops in
    about an afternoon, ~200 MB app
  Tauri | lighter, more work
    Rust shell with node as a sidecar
  Swift + WKWebView | most native | blue
    speech and TTS for free, Mac only

callout red: One thing breaks
  The mic uses Chrome's speech engine, which Electron doesn't have.
  Swap in whisper.cpp or a small macOS helper.

bars
  hand-drawn SVG | 2,500 | red
  viz language | 350 | green

steps
  Workspaces, worktrees and chat over stream-json
    everything else hangs off this
  Permission prompts and the board pane
  Voice, diff view, terminal

compare
  Have | Need | Blocker
  file contract | Electron shell | skill + MCP tool
  push-to-talk | signing, updates | speech-to-text

facts
  Effort: about 6 weeks solo
  Fixed cost: $99 per year for Apple signing
```

Card and bar items are `Heading | tag | color`; the tag and color are optional and can come in either order. `callout <color>: text` takes the color before the colon. `compare`'s first item is the header row and sets the number of columns.

## mermaid blocks

Any Mermaid diagram works; the page themes it to match. Good fits:

```
flowchart LR            boxes and arrows, decisions
sequenceDiagram         who calls whom, in order
stateDiagram-v2         modes and transitions
timeline / gantt        phases over time
pie                     shares of a whole
mindmap                 a topic and its branches
```

Keep labels short. In a flowchart, quote any label that contains punctuation such as `/ ( ) | { } : ;`, because Mermaid reads those as shape syntax: write `E["/board starts the server"]`, not `E[/board starts the server]`. Use `<br>` inside a flowchart label for a second line. The board column is about 560px wide, so prefer `flowchart TD` once a flow has more than four nodes; a wide diagram scrolls sideways instead of shrinking.
