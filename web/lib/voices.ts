/* Notable MMA voices — editorial discovery module and internal profile pages.
 *
 * This is recommended listening/viewing and independent editorial profiling.
 * Nobody listed here is affiliated with, partnered with, or endorsing
 * PropBetEdge, and the copy must never imply that. Outbound links go to each
 * person's own official destination (verified 2026-09-06), never to fan pages
 * or mirrors.
 *
 * Portraits are self-hosted derivatives of permissively licensed photographs
 * (no hotlinking); the source, author and licence are kept here so the card
 * can print a credit and so the rights trail is auditable. If a portrait is
 * unavailable, the card uses the branded fighter/octagon treatment instead
 * of borrowing copyrighted promotional photography. */

export type VoiceLink = { label: string; href: string; note?: string };
export type VoiceMoment = { year: string; text: string };

export type Voice = {
  key: string;
  name: string;
  role: string;
  label: string;
  descriptor: string;
  seoDescription: string;
  lede: string;
  bio: string[];
  whyItMatters: string[];
  knownFor: string[];
  signature: string;
  highlights: string[];
  topics: string[];
  timeline: VoiceMoment[];
  recommended: VoiceLink[];
  official: VoiceLink[];
  cta: string;
  href: string;
  destination: string;
  image: {
    src: string;
    hero?: string;
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
    label: "Podcast · MMA conversations",
    descriptor: "Long-form conversations with fighters, coaches and personalities shaping combat sports.",
    seoDescription: "Joe Rogan profile from PropBetEdge UFC: his place in UFC commentary since the late 1990s, The Joe Rogan Experience and JRE MMA Show, martial-arts perspective and official listening destinations.",
    lede: "Part cageside broadcaster, part martial-arts obsessive, part long-form interviewer. Rogan is the voice most fans hear when a fight turns, and the one they hear again for three hours afterwards.",
    bio: [
      "Joe Rogan occupies an unusual place in the modern fight ecosystem. His UFC broadcast work — which began in 1997 as a backstage interviewer before he moved to the color-commentary chair in 2002 — puts him cageside while the action is unfolding. The Joe Rogan Experience, launched in 2009, gives him the opposite format: hours rather than seconds, so fighters, coaches, cornermen and combat-sports figures can explain how they see the game.",
      "That combination matters because MMA is a sport where context disappears inside a stat line. A takedown can be domination or desperation. A fighter moving backward can be losing ground or deliberately loading a counter. Rogan's value to a curious fan is the vocabulary around those moments: position, timing, submission mechanics, striking geometry and the choices that connect one phase of a fight to the next.",
      "His own martial-arts background — taekwondo competition as a teenager, later Brazilian jiu-jitsu black belts under Eddie Bravo and Jean Jacques Machado — explains why his commentary has always spent so much time on technique rather than narrative. He tends to call what a fighter is trying to do before the result makes it obvious.",
      "The podcast adds a research layer that broadcast television cannot. Long conversations reveal how fighters describe camps, injuries, mindset, training partners and tactical preferences. PropBetEdge treats those statements as attributed perspective, not verified fact: any such claim belongs to the speaker and needs a time-stamped source before it enters serious pre-fight research.",
      "For PropBetEdge readers, Rogan is a gateway into the human language of the sport. Fight DNA quantifies patterns; a good conversation explains what the people inside the cage think those patterns mean.",
      "PropBetEdge features Rogan as an editorial recommendation only. He is not a PropBetEdge contributor, partner or endorser.",
    ],
    whyItMatters: [
      "He has called more UFC title fights than any other commentator, across every era from the pre-Zuffa promotion to the TKO era.",
      "The JRE MMA Show is one of the few mainstream formats that gives coaches and fighters uninterrupted time to talk technique.",
      "His live reactions have become part of how iconic moments are remembered, which makes him a cultural reference point as much as an analyst.",
    ],
    knownFor: ["Cageside color commentary on UFC pay-per-views", "The Joe Rogan Experience (2009– )", "The JRE MMA Show", "Technical, grappling-literate fight calls", "Long-form interviews with fighters and coaches"],
    signature: "The technical eye at the broadcast table",
    highlights: ["UFC broadcast team since 1997", "Host of The Joe Rogan Experience", "Brazilian jiu-jitsu black belt", "Taekwondo competitor before broadcasting", "JRE MMA Show fighter and coach conversations"],
    topics: ["UFC commentary", "fighter interviews", "martial arts", "fight culture", "technique", "long-form podcasting"],
    timeline: [
      { year: "1997", text: "Joins the UFC broadcast as a backstage and post-fight interviewer." },
      { year: "2002", text: "Moves to the color-commentary chair alongside Mike Goldberg, a pairing that defines the sound of the sport for over a decade." },
      { year: "2009", text: "The Joe Rogan Experience launches; MMA figures become a recurring part of its rotation." },
      { year: "2017", text: "The JRE MMA Show begins as a dedicated fight-talk series." },
      { year: "2020", text: "JRE moves to Spotify under an exclusive licensing deal, later expanding back to other platforms." },
    ],
    recommended: [
      { label: "The Joe Rogan Experience", href: "https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk", note: "Official show page on Spotify" },
      { label: "PowerfulJRE on YouTube", href: "https://www.youtube.com/@joerogan", note: "Official channel with full episodes and clips" },
    ],
    official: [
      { label: "The Joe Rogan Experience on Spotify", href: "https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk" },
      { label: "PowerfulJRE on YouTube", href: "https://www.youtube.com/@joerogan" },
    ],
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
    label: "Analysis · Fight breakdowns",
    descriptor: "Champion-level analysis, fight breakdowns and perspective from one of MMA's most accomplished competitors.",
    seoDescription: "Daniel Cormier profile from PropBetEdge UFC: two-division UFC champion, Olympic wrestler, UFC Hall of Famer, broadcaster and analyst, with his official video destination.",
    lede: "Two belts at the same time, an Olympic wrestling pedigree and years of championship five-rounders. When Cormier explains a fight, he is describing decisions he has had to make himself.",
    bio: [
      "Daniel Cormier brings one of the most information-dense résumés possible to an analyst chair. He was a two-time U.S. Olympic wrestler and world-championship medalist before he ever fought, then became UFC light heavyweight champion in 2015 and UFC heavyweight champion in 2018 — holding both titles simultaneously — and was inducted into the UFC Hall of Fame in 2022.",
      "That background makes his analysis particularly valuable when a fight turns on wrestling decisions rather than a simple takedown count. Entry quality, underhooks, head position, fence work, mat returns and the energy cost of repeated grappling exchanges can decide a fight long before the box score makes the pattern obvious.",
      "Cormier also understands the five-round problem from experience. His trilogies with Jon Jones and Stipe Miocic were fought at the top of the sport, and championship rounds introduce a different pacing equation: when to force exchanges, when to bank position, how to recover after a bad round and how much early aggression a fighter can afford before minutes sixteen through twenty-five arrive.",
      "His broadcast work — as a UFC commentator and across ESPN's MMA coverage — is strongest when he translates those invisible decisions for viewers in real time. For PropBetEdge that is complementary to Fight DNA: we can measure attempts, control, pace and historical outcomes; an experienced champion can explain why a sequence is tactically expensive or strategically important.",
      "The same rule applies here as with every outside voice: commentary is perspective, not ground truth. Claims about an injury, camp, game plan or private conversation need their own attributable source before they enter the factual layer.",
      "PropBetEdge features Cormier as an editorial recommendation only. He is not a PropBetEdge contributor, partner or endorser.",
    ],
    whyItMatters: [
      "One of a handful of fighters to hold two UFC championships at once, giving his breakdowns first-hand authority on title-fight pacing.",
      "His wrestling pedigree lets him read clinch and takedown battles that most viewers only see as a result.",
      "He moved straight from active championship competition into broadcasting, so his analysis reflects the current sport rather than a previous era.",
    ],
    knownFor: ["Simultaneous UFC heavyweight and light heavyweight champion", "Olympic freestyle wrestler (2004, 2008)", "UFC commentary and fight breakdowns", "ESPN MMA analysis", "UFC Hall of Fame Modern Wing (2022)"],
    signature: "Championship experience translated in real time",
    highlights: ["Former UFC heavyweight champion", "Former UFC light heavyweight champion", "Two-time U.S. Olympic wrestler", "UFC Hall of Fame inductee (2022)", "UFC commentator and ESPN analyst"],
    topics: ["fight breakdowns", "wrestling", "cage craft", "championship experience", "UFC analysis", "matchup tactics", "five-round pacing"],
    timeline: [
      { year: "2004 · 2008", text: "Represents the United States in Olympic freestyle wrestling." },
      { year: "2015", text: "Wins the UFC light heavyweight championship against Anthony Johnson at UFC 187." },
      { year: "2018", text: "Knocks out Stipe Miocic at UFC 226 to add the heavyweight title and become a simultaneous two-division champion." },
      { year: "2020", text: "Retires after the Miocic trilogy and moves full-time into broadcasting and analysis." },
      { year: "2022", text: "Inducted into the UFC Hall of Fame Modern Wing." },
    ],
    recommended: [
      { label: "Daniel Cormier on YouTube", href: "https://www.youtube.com/@dc_mma", note: "Official channel: fight breakdowns and reaction videos" },
      { label: "ESPN MMA", href: "https://www.espn.com/mma/", note: "Where much of his broadcast analysis appears" },
    ],
    official: [
      { label: "Daniel Cormier on YouTube", href: "https://www.youtube.com/@dc_mma" },
      { label: "UFC Hall of Fame", href: "https://www.ufc.com/ufc-hall-of-fame" },
    ],
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
    label: "Promoter · UFC era-defining figure",
    descriptor: "The executive voice most associated with the UFC's growth from a controversial early spectacle into a global combat-sports powerhouse.",
    seoDescription: "Dana White profile from PropBetEdge UFC: UFC President since 2001 and CEO, his role in the Zuffa rebuild, The Ultimate Fighter, global expansion, the Contender Series pipeline and the TKO era, with official UFC destinations.",
    lede: "Every era of the modern UFC has run through his office. White has been the promotion's president since the 2001 Zuffa purchase and its public face through television, global expansion, a pandemic schedule and the TKO era.",
    bio: [
      "Dana White has been the president of the Ultimate Fighting Championship since January 2001, when Zuffa, LLC — Lorenzo and Frank Fertitta, with White as a minority partner and president — bought a promotion that had lost its television distribution and most of its regulatory standing. He became UFC CEO under TKO Group Holdings in 2023. No executive is more closely identified with the sport's move from banned spectacle to mainstream global business.",
      "His route into the role was through the fighters. A Boston-area boxing-gym background led to managing Tito Ortiz and Chuck Liddell in the late 1990s, which is how he learned the previous owners were looking to sell and connected them to the Fertittas. The management background shaped the promotional style that followed: personalities first, rivalries sold hard, and a willingness to argue publicly with athletes, media and regulators.",
      "The first Zuffa years were a rebuild. State-by-state sanctioning, a return to pay-per-view and cable, and heavy losses until The Ultimate Fighter reached Spike TV in 2005. The Griffin–Bonnar finale that April is the moment the promotion itself credits with turning the business around; the reality-television pipeline it created is still the way many fighters reach the roster.",
      "From there the calendar and the map expanded: FOX in 2011, the first women's fight in 2013 with Ronda Rousey, UFC Fight Pass the same year, the 2016 sale to WME-IMG for roughly four billion dollars with White staying in charge, the ESPN era from 2019, and the UFC Apex and 'Fight Island' schedule that kept the sport running through 2020 when most sports stopped.",
      "Dana White's Contender Series, launched in 2017, is the reason he appears in the PropBetEdge product directly. The series is the clearest window into the UFC's talent pipeline: prospects arrive with regional records, compete under direct organizational scrutiny and can leave the night with a contract. PropBetEdge tracks the program season by season because its history deserves more than a few cards buried in the general schedule.",
      "For readers, White is also an unusually direct source of primary promotional information. Card announcements, title-fight plans, replacement bouts, contract decisions and business changes are often discussed by him publicly before the rest of the ecosystem has reacted. That makes source discipline important: PropBetEdge preserves exactly what was said, when and where, rather than turning promotional commentary into a stronger factual claim than the source supports.",
      "PropBetEdge features White as an editorial subject and recommended official source only. He and the UFC are not PropBetEdge contributors, partners or endorsers.",
    ],
    whyItMatters: [
      "He is the constant across every modern era: the Zuffa rebuild, The Ultimate Fighter, network television, women's divisions, the sale to Endeavor, ESPN and TKO.",
      "His public statements are primary-source material for card changes, title plans and roster decisions.",
      "Dana White's Contender Series is the most visible route from regional MMA to the UFC roster, and PropBetEdge indexes it as its own track.",
    ],
    knownFor: ["UFC President since 2001, CEO since 2023", "Leading the Zuffa-era rebuild of the promotion", "The Ultimate Fighter and the television breakthrough", "Dana White's Contender Series talent pipeline", "Fight announcements and matchmaking culture"],
    signature: "The promoter who defined the modern UFC's presentation",
    highlights: ["UFC President & CEO", "Central executive figure in the UFC's modern era", "Primary public voice for many fight and event announcements", "Dana White's Contender Series namesake and contract decision-maker", "Key source for understanding the promotion's business and event strategy"],
    topics: ["UFC leadership", "fight announcements", "Contender Series", "matchmaking culture", "sports business", "event strategy", "talent development"],
    timeline: [
      { year: "2001", text: "Zuffa buys the UFC; White becomes president and the promotion's public face." },
      { year: "2005", text: "The Ultimate Fighter airs on Spike TV; the Griffin–Bonnar finale changes the business." },
      { year: "2011", text: "The UFC reaches network television with FOX." },
      { year: "2013", text: "Women's MMA arrives at UFC 157; UFC Fight Pass launches." },
      { year: "2016", text: "The promotion sells to WME-IMG (Endeavor); White remains president." },
      { year: "2017", text: "Dana White's Contender Series begins its first season." },
      { year: "2019 – 2020", text: "ESPN becomes the U.S. broadcast home; the UFC Apex and 'Fight Island' carry the pandemic schedule." },
      { year: "2023", text: "UFC and WWE combine under TKO Group Holdings; White becomes UFC CEO as the promotion turns 30." },
      { year: "2026", text: "UFC Freedom 250 in June headlines a summer of marquee cards indexed in the PropBetEdge schedule." },
    ],
    recommended: [
      { label: "UFC.com", href: "https://www.ufc.com/", note: "Official home for announcements, events and rankings" },
      { label: "UFC on YouTube", href: "https://www.youtube.com/@ufc", note: "Official channel: press conferences, weigh-ins and free fights" },
      { label: "Dana White's Contender Series", href: "https://www.ufc.com/dwcs", note: "Official DWCS destination" },
    ],
    official: [
      { label: "UFC.com", href: "https://www.ufc.com/" },
      { label: "UFC on YouTube", href: "https://www.youtube.com/@ufc" },
      { label: "Dana White's Contender Series (official)", href: "https://www.ufc.com/dwcs" },
      { label: "UFC Fight Pass", href: "https://www.ufcfightpass.com/" },
    ],
    cta: "Visit UFC.com",
    href: "https://www.ufc.com/",
    destination: "UFC.com",
    image: {
      src: "/media/voices/dana-white-660.webp",
      hero: "/media/voices/dana-white-900.webp",
      width: 660,
      height: 880,
      focal: "50% 30%",
      alt: "Dana White",
      source_url: "https://commons.wikimedia.org/wiki/File:U.S._Park_Police_Officers_meet_Dana_White_at_the_UFC_Freedom_250_Press_Conference_(27)_(cropped).jpg",
      source_title: "U.S. Park Police Officers meet Dana White at the UFC Freedom 250 Press Conference (cropped)",
      author: "Sgt. Christian Brown, U.S. Park Police",
      license: "Public domain",
      license_url: null,
      note: "U.S. federal government work (2026); resized and re-encoded to WebP, no additional crop.",
    },
  },
];

export function getVoice(key: string): Voice | null {
  return VOICES.find((voice) => voice.key === key) || null;
}

export const VOICES_DISCLAIMER = "Editorial profiles and recommendations. PropBetEdge is independent and is not affiliated with or endorsed by UFC or the featured personalities.";
