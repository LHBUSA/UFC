const FIGHTMAG_BASE = "https://schedule.fightmag.com/events";

export function fightmagDwcsUrl(name) {
  const m = String(name || "").match(/Dana White['’]s Contender Series:\s*Season\s*(\d+)\s*,\s*Week\s*(\d+)/i);
  if (!m) return null;
  return `${FIGHTMAG_BASE}/dana-whites-contender-series-season-${m[1]}-week-${m[2]}/`;
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const weightTail = /(strawweight|flyweight|bantamweight|featherweight|lightweight|welterweight|middleweight|light heavyweight|heavyweight|catchweight)$/i;

/* Extract only the bullet rows beneath FIGHTMAG's explicit "fight card"
 * heading. Fail closed: callers should keep the prior snapshot if this parser
 * cannot identify at least two plausible A-vs-B rows. */
export function parseFightmagDwcsCard(html, expectedName = "") {
  const raw = String(html || "");
  const lower = raw.toLowerCase();
  const heading = lower.indexOf("fight card");
  if (heading < 0) return [];

  if (expectedName) {
    const m = String(expectedName).match(/Season\s*(\d+)\s*,\s*Week\s*(\d+)/i);
    if (m && !new RegExp(`season\\s*${m[1]}[^0-9]+week\\s*${m[2]}`, "i").test(decodeHtml(raw.slice(0, Math.min(raw.length, heading + 1200))))) return [];
  }

  const tail = raw.slice(heading, heading + 9000);
  const end = tail.search(/<h2[^>]*>\s*Event details|<h2[^>]*>\s*Upcoming Events/i);
  const section = end > 0 ? tail.slice(0, end) : tail;

  const rows = [];
  for (const m of section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    let text = decodeHtml(m[1]);
    if (!/\s+vs\.?\s+/i.test(text)) continue;
    text = text.replace(/^[-•]\s*/, "").trim();

    let weight_class_raw = null;
    const comma = text.lastIndexOf(",");
    if (comma > 0) {
      const tailWeight = text.slice(comma + 1).trim();
      if (weightTail.test(tailWeight)) {
        weight_class_raw = tailWeight;
        text = text.slice(0, comma).trim();
      }
    }

    const parts = text.split(/\s+vs\.?\s+/i).map((x) => x.trim()).filter(Boolean);
    if (parts.length !== 2 || parts.some((x) => x.length < 2 || x.length > 100)) continue;
    rows.push({ fighter_a_name: parts[0], fighter_b_name: parts[1], weight_class_raw });
  }
  return rows.length >= 2 ? rows : [];
}

export function matchupKey(a, b) {
  return [a, b].map((x) => String(x || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim()).sort().join("::");
}
