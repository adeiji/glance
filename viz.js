// Renders the board's block languages:
//   <pre class="viz">     cards, bars, steps, compare, facts, callouts (syntax in VIZ.md)
//   <pre class="mermaid"> any Mermaid diagram
// Call renderBoard(root) after the sections are in the page.
(function () {
  const COLORS = new Set(['green', 'amber', 'red', 'blue', 'purple', 'gray']);
  const BLOCKS = new Set(['title', 'text', 'cards', 'bars', 'steps', 'compare', 'facts', 'callout']);

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = t => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
  const parts = t => t.split('|').map(x => x.trim());

  // Drop the common indentation that comes from writing the block inside HTML.
  function dedent(src) {
    const lines = src.replace(/\t/g, '  ').split('\n');
    const min = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
    return lines.map(l => l.slice(min)).join('\n');
  }

  // Top-level lines name a block (optionally "name color: text"); items are indented by 2,
  // an item's detail lines by 4 or more.
  function parse(src) {
    const blocks = [];
    let block = null;
    for (const raw of dedent(src).split('\n')) {
      if (!raw.trim()) continue;
      const indent = raw.match(/^ */)[0].length;
      if (indent === 0) {
        const m = raw.match(/^(\w+)(?:\s+(\w+))?\s*(?::\s*(.*))?$/);
        const name = m && BLOCKS.has(m[1]) ? m[1] : null;
        if (!name) { block = { name: 'text', text: raw.trim(), items: [] }; blocks.push(block); continue; }
        block = { name, color: COLORS.has(m[2]) ? m[2] : '', text: m[3] || (m[2] && !COLORS.has(m[2]) ? m[2] : ''), items: [] };
        blocks.push(block);
      } else if (block && (indent < 4 || !block.items.length)) {
        block.items.push({ text: raw.trim(), details: [] });
      } else if (block) {
        block.items[block.items.length - 1].details.push(raw.trim());
      }
    }
    return blocks;
  }

  // "Heading | tag | color" in any order for the last two.
  function split(item) {
    const p = parts(item.text);
    const color = p.slice(1).find(x => COLORS.has(x.toLowerCase()))?.toLowerCase() || '';
    const tag = p.slice(1).find(x => !COLORS.has(x.toLowerCase())) || '';
    return { head: p[0], tag, color, details: item.details };
  }

  const render = {
    title: b => `<h3>${inline(b.text)}</h3>`,
    text: b => `<p class="text">${inline([b.text, ...b.items.map(i => i.text)].filter(Boolean).join(' '))}</p>`,
    cards: b => `<div class="cards">${b.items.map(i => {
      const c = split(i);
      return `<div class="card ${c.color}"><div class="head"><h4>${inline(c.head)}</h4>${c.tag ? `<span class="tag">${inline(c.tag)}</span>` : ''}</div>` +
        (c.details.length ? `<ul>${c.details.map(d => `<li>${inline(d)}</li>`).join('')}</ul>` : '') + '</div>';
    }).join('')}</div>`,
    callout: b => `<div class="callout ${b.color}"><b>${inline(b.text)}</b>${b.items.length ? `<div class="more">${b.items.map(i => inline(i.text)).join('<br>')}</div>` : ''}</div>`,
    bars: b => {
      const rows = b.items.map(i => {
        const p = parts(i.text);
        const num = parseFloat((p[1] || '').replace(/[^\d.]/g, '')) || 0;
        return { label: p[0], shown: p[1] || '', num, color: COLORS.has((p[2] || '').toLowerCase()) ? p[2].toLowerCase() : 'blue' };
      });
      const max = Math.max(...rows.map(r => r.num), 1);
      return `<div class="bars">${rows.map(r =>
        `<span>${inline(r.label)}</span><div class="bar"><i class="${r.color}" style="width:${Math.max(1, r.num / max * 100)}%"></i></div><span class="val ${r.color}">${inline(r.shown)}</span>`
      ).join('')}</div>`;
    },
    steps: b => `<ol class="steps">${b.items.map(i =>
      `<li><div><div class="main">${inline(i.text)}</div>${i.details.length ? `<div class="sub">${i.details.map(inline).join('<br>')}</div>` : ''}</div></li>`
    ).join('')}</ol>`,
    compare: b => {
      const rows = b.items.map(i => parts(i.text));
      const cols = Math.max(...rows.map(r => r.length), 1);
      return `<div class="compare" style="--cols:${cols}">${rows.map((r, n) =>
        `<div class="${n ? '' : 'head'}">${Array.from({ length: cols }, (_, k) => `<span>${inline(r[k] || '')}</span>`).join('')}</div>`
      ).join('')}</div>`;
    },
    facts: b => `<dl class="facts">${b.items.map(i => {
      const [k, ...v] = i.text.split(':');
      return `<dt>${inline(k)}</dt><dd>${inline(v.join(':').trim())}</dd>`;
    }).join('')}</dl>`,
  };

  function renderViz(root) {
    for (const pre of root.querySelectorAll('pre.viz')) {
      const box = document.createElement('div');
      box.className = 'viz';
      try {
        box.innerHTML = parse(pre.textContent).map(b => render[b.name](b)).join('');
      } catch (e) {
        box.innerHTML = `<div class="broken">This block didn't render: ${esc(e.message)}<pre>${esc(pre.textContent)}</pre></div>`;
      }
      pre.replaceWith(box);
    }
  }

  // Mermaid needs plain colors, and some of ours are color-mix() expressions, so resolve them through an element.
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.documentElement.append(probe);
  const hex = n => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  function cssVar(name) {
    if (name === '--font') return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    probe.style.color = `var(${name})`;
    const c = getComputedStyle(probe).color;
    let m = c.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (m) return '#' + hex(+m[1]) + hex(+m[2]) + hex(+m[3]);
    m = c.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return '#' + hex(m[1] / 255) + hex(m[2] / 255) + hex(m[3] / 255);
    return c;
  }

  // The usual way a flowchart breaks: a bare label with / ( ) | { } : ; etc, which Mermaid reads as shape syntax.
  // Wrap such labels in quotes. Only called after a parse failure, so valid shapes like A[/slanted/] are left alone.
  function heal(src) {
    const head = src.trim().split('\n')[0].trim();
    if (!/^(flowchart|graph)\b/.test(head)) return src;
    const shapeLike = l => /^\/.*\/$/.test(l) || /^\\.*\\$/.test(l) || /^\/.*\\$/.test(l) || /^\\.*\/$/.test(l);
    return src.split('\n').map(line => line.replace(/(^|[\s>|&-])([A-Za-z0-9_]+)\[(?![\[(])([^\[\]\n]*?)\](?!\])/g, (m, pre, id, label) => {
      if (/^".*"$/.test(label) || !/[\/\\()|{}<>;:&#'`"]/.test(label) || shapeLike(label)) return m;
      return `${pre}${id}["${label.replace(/"/g, '#quot;')}"]`;
    })).join('\n');
  }

  async function renderMermaid(root) {
    const pres = [...root.querySelectorAll('pre.mermaid, div.mermaid:not([data-processed])')];
    if (!pres.length) return;
    const nodes = pres.map(pre => {
      if (pre.tagName !== 'PRE') return pre;
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = dedent(pre.textContent).trim();
      pre.replaceWith(div);
      return div;
    });
    if (!window.mermaid) {
      for (const n of nodes) { n.className = 'viz'; n.innerHTML = `<div class="broken">Mermaid didn't load.<pre>${esc(n.textContent)}</pre></div>`; }
      return;
    }
    const scheme = document.documentElement.dataset.scheme;
    const dark = scheme ? scheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    try { mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: cssVar('--font') || 'system-ui, sans-serif',
      themeVariables: {
        darkMode: dark,
        fontSize: '14px',
        background: cssVar('--surface'),
        textColor: cssVar('--ink'),
        lineColor: cssVar('--line-strong'),
        primaryColor: cssVar('--paper'),
        primaryTextColor: cssVar('--ink'),
        primaryBorderColor: cssVar('--line-strong'),
        nodeBorder: cssVar('--line-strong'),
        mainBkg: cssVar('--paper'),
        secondaryColor: cssVar('--tint-purple'),
        secondaryBorderColor: cssVar('--edge-purple'),
        tertiaryColor: cssVar('--tint-gray'),
        tertiaryBorderColor: cssVar('--edge-gray'),
        clusterBkg: cssVar('--paper'),
        clusterBorder: cssVar('--line-strong'),
        edgeLabelBackground: cssVar('--surface'),
        noteBkgColor: cssVar('--tint-amber'),
        noteBorderColor: cssVar('--edge-amber'),
        noteTextColor: cssVar('--ink'),
        actorBkg: cssVar('--tint-blue'),
        actorBorder: cssVar('--edge-blue'),
        actorTextColor: cssVar('--ink'),
        signalColor: cssVar('--ink'),
        signalTextColor: cssVar('--ink'),
        labelBoxBkgColor: cssVar('--tint-gray'),
        labelTextColor: cssVar('--ink'),
        pie1: cssVar('--edge-blue'), pie2: cssVar('--edge-green'), pie3: cssVar('--edge-amber'), pie4: cssVar('--edge-purple'), pie5: cssVar('--edge-red'), pie6: cssVar('--edge-gray'),
        cScale0: cssVar('--tint-blue'), cScale1: cssVar('--tint-green'), cScale2: cssVar('--tint-amber'), cScale3: cssVar('--tint-purple'), cScale4: cssVar('--tint-red'),
      },
      flowchart: { useMaxWidth: false, htmlLabels: true, curve: 'basis', padding: 16, nodeSpacing: 56, rankSpacing: 60, diagramPadding: 12 },
      sequence: { useMaxWidth: false, diagramMarginX: 16, diagramMarginY: 16, actorMargin: 60, messageMargin: 44, boxMargin: 12 },
      gantt: { useMaxWidth: false, barHeight: 24, barGap: 8, topPadding: 56, leftPadding: 96 },
      timeline: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
      pie: { useMaxWidth: false },
    }); } catch (e) { console.warn('mermaid theme', e); }
    for (const node of nodes) {
      let src = node.textContent;
      try {
        // Dry-run the source first; if it fails for a common authoring slip, repair and try once more.
        try { await mermaid.parse(src); }
        catch (e) {
          const fixed = heal(src);
          if (fixed === src) throw e;
          await mermaid.parse(fixed);
          console.warn('mermaid: auto-quoted labels in a diagram that would not parse:', String(e.message || e).split('\n')[0]);
          node.textContent = src = fixed;
        }
        await mermaid.run({ nodes: [node] });
      } catch (e) {
        node.className = 'viz';
        node.innerHTML = `<div class="broken">This diagram didn't render: ${esc(String(e.message || e).split('\n')[0])}<pre>${esc(src)}</pre></div>`;
      }
    }
  }

  window.renderBoard = async function (root = document) {
    renderViz(root);
    await renderMermaid(root);
  };
})();
