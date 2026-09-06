/* Notable MMA voices — editorial discovery module on the homepage.
 *
 * This is recommended listening/viewing only. Nobody listed here is
 * affiliated with, partnered with, or endorsing PropBetEdge, and the copy
 * must never imply that. Links go to each personality's own official
 * destination (verified 2026-09-06), never to fan pages or mirrors.
 *
 * Portraits are self-hosted derivatives of permissively licensed photographs
 * (no hotlinking); the source, author and licence are kept here so the card
 * can print a credit and so the rights trail is auditable. If a portrait is
 * unavailable, the card uses the branded fighter/octagon treatment instead
 * of borrowing copyrighted promotional photography. */

export type Voice = {
  key: string;
  name: string;
  role: string;
  label: string;
  descriptor: string;
  seoDescription: string;
  bio: string[];
  highlights: string[];
  topics: string[];
  cta: string;
  href: string;
  destination: string;
  image: {
    src: string;
    width: number;
    height: number;
    focal: string;
    alt: string;
    source_url: string;
    source_title: string;
    author: string;
    license: string;
    license_url: string | null;
    note: string;
  } | null;
};

export const VOICES: Voice[] = [
  {
    key: "joe-rogan",
    name: "Joe Rogan",
    role: "UFC color commentator · podcaster",
    label: "Commentary · Long-form MMA conversations",
    descriptor: "Cageside pattern recognition and long-form conversations with fighters, coaches and personalities shaping combat sports.",
    seoDescription: "Joe Rogan profile from PropBetEdge UFC: his place in UFC commentary, long-form fighter conversations, martial-arts perspective and official Joe Rogan Experience destination.",
    bio: [
      "Joe Rogan occupies an unusual place in the modern fight ecosystem: part live broadcaster, part martial-arts obsessive and part long-form interviewer. His UFC work puts him cageside while the action is unfolding; The Joe Rogan Experience gives him the opposite format — hours rather than seconds — to let fighters, coaches and combat-sports figures explain how they see the game.",
      "That combination matters because MMA is a sport where context can disappear inside a stat line. A takedown can be domination or desperation. A fighter moving backward can be losing ground or deliberately creating a counter. Rogan's best value to a curious fan is the vocabulary around those moments: position, timing, submissions, striking mechanics and the choices that connect one phase of a fight to another.",
      "His martial-arts background also helps explain why his commentary has historically spent so much time on technique. PropBetEdge does not treat any commentator's view as a data source by itself, but technical observations can tell a viewer what to go back and verify in the film and round-level numbers.",
      "The podcast side adds a different research layer. Long conversations can reveal how fighters describe camps, injuries, mindset, training partners and tactical preferences — but any such claim belongs to the speaker and needs to be attributed and time-stamped before it becomes part of serious pre-fight research.",
      "For PropBetEdge readers, Rogan belongs in the product as a gateway into the human language of the sport. Fight DNA can quantify patterns; a good conversation can explain what the people inside the cage think those patterns mean.",
      "PropBetEdge features Rogan as an editorial recommendation only. He is not a PropBetEdge contributor, partner or endorser.",
    ],
    highlights: [
      "Longtime UFC color commentator",
      "Host of The Joe Rogan Experience",
      "Long-form conversations with fighters and coaches",
      "Martial-arts and technical-analysis perspective",
      "Useful bridge between live action and deeper fight discussion",
    ],
    topics: ["UFC commentary", "fighter interviews", "martial arts", "fight culture", "technique", "long-form podcasting"],
    cta: "Listen to Joe Rogan",
    href: "https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk",
    destination: "The Joe Rogan Experience on Spotify",
    image: {
      src: "/media/voices/joe-rogan-660.webp",
      width: 660,
      height: 944,
      focal: "50% 24%",
      alt: "Joe Rogan",
      source_url: "https://commons.wikimedia.org/wiki/File:2026_Joe_Rogan_with_Donald_Trump_at_the_White_House_(cropped).jpg",
      source_title: "2026 Joe Rogan with Donald Trump at the White House (cropped)",
      author: "The White House",
      license: "Public domain",
      license_url: null,
      note: "U.S. federal government work; derivative cropped to Joe Rogan alone, re-encoded to WebP.",
    },
  },
  {
    key: "daniel-cormier",
    name: "Daniel Cormier",
    role: "Former two-division UFC champion · analyst",
    label: "Championship perspective · Fight breakdowns",
    descriptor: "Champion-level analysis through the lens of elite wrestling, cage craft, five-round experience and the realities of fighting at the highest level.",
    seoDescription: "Daniel Cormier profile from PropBetEdge UFC: two-division championship experience, elite wrestling perspective, MMA analysis and his official video destination.",
    bio: [
      "Daniel Cormier brings one of the most information-dense résumés possible to an analyst chair: former UFC heavyweight champion, former UFC light heavyweight champion, elite freestyle wrestler and a fighter who spent years preparing for championship-level opponents with very different styles.",
      "That background makes his analysis particularly valuable when a fight turns on wrestling decisions rather than a simple takedown count. Entry quality, underhooks, head position, fence work, mat returns and the energy cost of repeated grappling exchanges can determine a fight long before a box score makes the pattern obvious.",
      "Cormier also understands the five-round problem from experience. Championship fights introduce a different pacing equation: when to force exchanges, when to bank position, how to recover after a bad round and how much early aggression a fighter can afford before minutes sixteen through twenty-five arrive.",
      "His broadcast work can be strongest when he translates those invisible decisions for viewers in real time. For PropBetEdge, that is complementary to Fight DNA. We can measure attempts, control, pace and historical outcomes; an experienced analyst can help frame why a sequence may be tactically expensive or strategically important.",
      "The same rule applies here as with every outside voice: commentary is perspective, not ground truth. Claims about an injury, camp, game plan or private conversation need their own attributable source before entering the factual layer.",
      "PropBetEdge features Cormier as an editorial recommendation only. He is not a PropBetEdge contributor, partner or endorser.",
    ],
    highlights: [
      "Former UFC heavyweight champion",
      "Former UFC light heavyweight champion",
      "Elite freestyle wrestling background",
      "UFC commentator and fight analyst",
      "First-hand five-round and championship experience",
    ],
    topics: ["fight breakdowns", "wrestling", "cage craft", "championship experience", "UFC analysis", "matchup tactics", "five-round pacing"],
    cta: "Watch Daniel Cormier",
    href: "https://www.youtube.com/@dc_mma",
    destination: "Daniel Cormier on YouTube",
    image: {
      src: "/media/voices/daniel-cormier-660.webp",
      width: 660,
      height: 884,
      focal: "48% 38%",
      alt: "Daniel Cormier",
      source_url: "https://commons.wikimedia.org/wiki/File:Daniel_Cormier_promoting_EA_UFC_5.jpg",
      source_title: "Daniel Cormier promoting EA UFC 5",
      author: "Esfand",
      license: "CC BY 3.0",
      license_url: "https://creativecommons.org/licenses/by/3.0",
      note: "Cropped to head-and-shoulders, re-encoded to WebP; attribution retained on the card.",
    },
  },
  {
    key: "dana-white",
    name: "Dana White",
    role: "UFC President & CEO",
    label: "Leadership · Matchmaking culture · Fight business",
    descriptor: "The executive voice most closely associated with UFC's modern growth, event-making culture and talent pipeline.",
    seoDescription: "Dana White profile from PropBetEdge UFC: UFC President and CEO, his role in the promotion's modern era, Contender Series talent pipeline and official UFC destination.",
    bio: [
      "Dana White is UFC President and CEO and has been the promotion's most visible executive voice through most of its modern growth. His role sits at the intersection of event promotion, matchmaking culture, athlete opportunity, media, distribution and the constant work of turning a combat-sports calendar into a global sports product.",
      "For fight fans, White is also an unusually direct source of primary promotional information. Card announcements, title-fight plans, replacement bouts, Contender Series contracts and major business changes are often discussed by him publicly before the rest of the ecosystem has finished reacting.",
      "That makes source discipline important. A quote from White can be highly relevant to the state of a card, but PropBetEdge should preserve exactly what was said, when it was said and where it came from rather than turning promotional commentary into a stronger factual claim than the source supports.",
      "Dana White's Contender Series adds another reason he belongs in this product. The series is one of the clearest windows into UFC's talent pipeline: prospects arrive with regional records, compete under direct organizational scrutiny and can leave the night with a UFC contract. PropBetEdge tracks that program separately season by season because its history deserves more than a few cards buried in the general schedule.",
      "His perspective also helps explain why some moments matter beyond a single result — new markets, distribution shifts, event concepts, roster opportunities and the business decisions that shape which fights can happen next.",
      "PropBetEdge features White as an editorial subject and recommended official source only. He and UFC are not PropBetEdge contributors, partners or endorsers.",
    ],
    highlights: [
      "UFC President and CEO",
      "Central executive figure in UFC's modern era",
      "Primary public voice for many fight and event announcements",
      "Dana White's Contender Series namesake and contract decision-maker",
      "Key source for understanding the promotion's business and event strategy",
    ],
    topics: ["UFC leadership", "fight announcements", "Contender Series", "matchmaking culture", "sports business", "event strategy", "talent development"],
    cta: "Visit UFC.com",
    href: "https://www.ufc.com/",
    destination: "UFC.com",
    image: null,
  },
];

export function getVoice(key: string): Voice | null {
  return VOICES.find((voice) => voice.key === key) || null;
}

export const VOICES_DISCLAIMER = "Editorial profiles and recommendations. PropBetEdge is independent and is not affiliated with or endorsed by UFC or the featured personalities.";
