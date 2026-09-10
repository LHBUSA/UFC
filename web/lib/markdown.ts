/* Minimal, dependency-free Markdown for ufc_articles.body_md. Escapes HTML
 * first, then allows: headings (##, ###), paragraphs, **bold**, *italic*,
 * [text](https://url) and [text](/path) links, unordered/ordered lists,
 * blockquotes, horizontal rules, and pipe tables. Anything else stays text. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener nofollow" target="_blank">$1</a>')
    .replace(/\[([^\]]+)\]\((\/[^\s)]*)\)/g, '<a href="$2">$1</a>');
}
function table(block: string): string {
  const lines = block.split("\n").filter((l) => l.trim());
  const cells = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const head = cells(lines[0]);
  const body = lines.slice(2).map(cells);
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
/* Block-level HTML, one string per source block, rather than one joined page.
 *
 * The article renderer interleaves intelligence modules between paragraphs, and
 * it can only choose an insertion point it can SEE. Splitting joined HTML back
 * apart on a delimiter would work until a paragraph legitimately contained one,
 * so the array is the primitive and the joined string is derived from it.
 * renderMarkdown stays exactly as it was for every caller that wants a page. */
export function renderMarkdownBlocks(md: string): string[] {
  const blocks = esc(md || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks.map((b) => {
    const t = b.trim();
    if (!t) return "";
    if (/^(-{3,}|\*{3,})$/.test(t)) return "<hr>";
    if (t.startsWith("### ")) return `<h3>${inline(t.slice(4))}</h3>`;
    if (t.startsWith("## ")) return `<h2>${inline(t.slice(3))}</h2>`;
    if (t.startsWith("# ")) return `<h2>${inline(t.slice(2))}</h2>`;
    const lines = t.split("\n");
    if (lines.every((l) => l.startsWith("&gt; "))) return `<blockquote>${inline(lines.map((l) => l.slice(5)).join(" "))}</blockquote>`;
    if (lines.length >= 2 && lines[0].includes("|") && /^\|?\s*:?-{2,}/.test(lines[1])) return table(t);
    if (lines.every((l) => /^[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
    if (lines.every((l) => /^\d+[.)] /.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+[.)] /, ""))}</li>`).join("")}</ol>`;
    return `<p>${inline(t).replace(/\n/g, "<br>")}</p>`;
  }).filter(Boolean);
}

export function renderMarkdown(md: string): string {
  return renderMarkdownBlocks(md).join("\n");
}

/* Plain-text excerpt for meta descriptions and feeds. */
export function excerpt(md: string, max = 160): string {
  const t = (md || "").replace(/[#*`>_\[\]]/g, "").replace(/\(https?:\/\/[^)]+\)/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : t;
}
export function readingMinutes(md: string): number {
  return Math.max(1, Math.round((md || "").split(/\s+/).length / 220));
}
