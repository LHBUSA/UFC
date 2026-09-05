/* Minimal, dependency-free Markdown for ufc_articles.body_md. Escapes HTML
 * first, then allows: headings (##, ###), paragraphs, **bold**, *italic*,
 * [text](https://url) links, and unordered lists. Anything else stays text. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener nofollow">$1</a>');
}
export function renderMarkdown(md: string): string {
  const blocks = esc(md || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks.map((b) => {
    const t = b.trim();
    if (!t) return "";
    if (t.startsWith("### ")) return `<h3>${inline(t.slice(4))}</h3>`;
    if (t.startsWith("## ")) return `<h2>${inline(t.slice(3))}</h2>`;
    if (t.split("\n").every((l) => /^[-*] /.test(l))) return `<ul>${t.split("\n").map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
    return `<p>${inline(t).replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
}
