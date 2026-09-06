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
 * ever removed, the card falls back to the branded treatment (see
 * components/VoiceImage.tsx) rather than showing broken media. */

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
    /* Focal point of the face inside the derivative (percentages). */
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
    seoDescription: "Joe Rogan profile from PropBetEdge UFC: his place in MMA commentary, long-form fighter conversations, combat-sports background and official Joe Rogan Experience destination.",
    bio: [
      "Joe Rogan is a longtime UFC color commentator, comedian and host of The Joe Rogan Experience. His connection to mixed martial arts spans decades, combining a martial-arts background with cageside commentary and long-form conversations across the fight world.",
      "For fight fans, the value is context. Extended interviews with fighters, coaches and combat-sports personalities can reveal how people inside the sport talk about preparation, technique, competition and the culture around MMA beyond what a result line or stat table can show.",
      "PropBetEdge features Rogan as an editorial recommendation only. He is not a PropBetEdge contributor, partner or endorser.",
    ],
    highlights: [
      "Longtime UFC color commentator",
      "Host of The Joe Rogan Experience",
      "Long-form conversations with fighters and coaches",
      "Deep personal background in martial arts and combat sports",
    ],
    topics: ["UFC commentary", "fighter interviews", "martial arts", "fight culture", "long-form podcasting"],
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
    seoDescription: "Daniel Cormier profile from PropBetEdge UFC: two-division championship experience, elite wrestling perspective, MMA analysis and his official video destination.",
    bio: [
      "Daniel Cormier is a former UFC heavyweight and light heavyweight champion, an Olympic-level freestyle wrestler and a prominent MMA commentator and analyst. His perspective combines championship experience with an elite wrestling background and years of studying fights from the broadcast desk.",
      "Cormier's breakdowns are especially useful when a matchup turns on positioning, wrestling exchanges, clinch work, pace or the difference between what a statistic says and how that action actually develops inside the cage.",
      "PropBetEdge features Cormier as an editorial recommendation only. He is not a PropBetEdge contributor, partner or endorser.",
    ],
    highlights: [
      "Former UFC heavyweight champion",
      "Former UFC light heavyweight champion",
      "Olympic-level freestyle wrestling background",
      "UFC commentator and fight analyst",
    ],
    topics: ["fight breakdowns", "wrestling", "championship experience", "UFC analysis", "matchup tactics"],
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
];

export function getVoice(key: string): Voice | null {
  return VOICES.find((voice) => voice.key === key) || null;
}

export const VOICES_DISCLAIMER = "Editorial recommendations. PropBetEdge is not affiliated with or endorsed by the featured personalities.";
