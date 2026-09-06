/* Curated UFC heritage layer.
 *
 * This file is intentionally source-forward. PropBetEdge can add editorial
 * context, but official UFC history/Hall of Fame pages remain the canonical
 * destinations and are linked everywhere this data is presented.
 */

export const UFC_OFFICIAL = {
  home: "https://www.ufc.com/",
  athletes: "https://www.ufc.com/athletes",
  hallOfFame: "https://www.ufc.com/ufc-hall-of-fame",
  ufc1: "https://www.ufc.com/event/ufc-1",
  history30: "https://www.ufc.com/30",
  store: "https://www.ufcstore.com/en/",
  fightPass: "https://www.ufcfightpass.com/",
  youtube: "https://www.youtube.com/channel/UCvgfXK4nTYKudb0rFR6noLA",
  rankings: "https://www.ufc.com/rankings",
} as const;

export type HeritageMoment = {
  year: string;
  eyebrow: string;
  title: string;
  body: string;
  source: string;
  sourceLabel: string;
};

export const UFC_HISTORY: HeritageMoment[] = [
  {
    year: "1993",
    eyebrow: "The experiment",
    title: "UFC 1 asks the original question",
    body: "On November 12, 1993 in Denver, an eight-man tournament matched contrasting martial-arts styles in a format with no weight classes, judges or timeouts. The rule set was sparse rather than literally rule-free. Royce Gracie won three fights in one night and Brazilian jiu-jitsu became impossible for the wider fight world to ignore.",
    source: UFC_OFFICIAL.ufc1,
    sourceLabel: "Official UFC 1 event page",
  },
  {
    year: "1994–1996",
    eyebrow: "Style vs style",
    title: "The specialists start becoming mixed fighters",
    body: "The earliest era was still dominated by the question of which style could survive another. Wrestlers, grapplers, kickboxers and submission specialists forced one another to adapt. The sport was already moving away from single-discipline certainty toward the blended skill set that defines modern MMA.",
    source: UFC_OFFICIAL.history30,
    sourceLabel: "UFC 30-year history",
  },
  {
    year: "1997",
    eyebrow: "The rulebook grows up",
    title: "Gloves, divisions and structure arrive",
    body: "Standardized fight gloves, additional rules and weight-class structure emerged as the sport moved toward regulation. The chaos of the first tournaments was giving way to a repeatable athletic competition without removing the core problem-solving that made the sport compelling.",
    source: "https://www.ufc.com/authentic-fight-glove",
    sourceLabel: "UFC fight-glove history",
  },
  {
    year: "2000",
    eyebrow: "Modern era",
    title: "UFC 28 becomes the rules dividing line",
    body: "UFC identifies November 17, 2000 and UFC 28 as the start of its modern era because the event used the Unified Rules of Mixed Martial Arts. It is also the date the UFC Hall of Fame uses to separate its Pioneer and Modern wings.",
    source: UFC_OFFICIAL.hallOfFame,
    sourceLabel: "Official UFC Hall of Fame",
  },
  {
    year: "2001",
    eyebrow: "The rebuild",
    title: "A new ownership era begins",
    body: "The Zuffa era began in 2001 and the promotion entered a long rebuilding period. Dana White became the public face of that expansion while the organization pushed regulation, presentation and athlete development toward a mainstream sports product.",
    source: UFC_OFFICIAL.history30,
    sourceLabel: "UFC 30-year history",
  },
  {
    year: "2005",
    eyebrow: "Breakthrough television",
    title: "The Ultimate Fighter changes the audience",
    body: "The Ultimate Fighter and the Forrest Griffin–Stephan Bonnar finale became one of the defining accelerants in UFC's move into the mainstream. The fight is now enshrined in the UFC Hall of Fame Fight Wing.",
    source: UFC_OFFICIAL.hallOfFame,
    sourceLabel: "Official UFC Hall of Fame",
  },
  {
    year: "2010s",
    eyebrow: "Global sport",
    title: "Champions become complete MMA athletes",
    body: "The modern athlete increasingly needed layered striking, wrestling, jiu-jitsu, conditioning, cage craft and tactical preparation. Women's divisions, global champions and deeper international talent pools expanded what a UFC roster and championship lineage could look like.",
    source: UFC_OFFICIAL.history30,
    sourceLabel: "UFC 30-year history",
  },
  {
    year: "Today",
    eyebrow: "Fight intelligence era",
    title: "The sport is now measurable at round level",
    body: "A modern card can be understood through identity, records, title lineage, round-level striking and grappling, results, ranking movement, media, video and fight-week state changes. PropBetEdge's job is to connect those layers without pretending an independent data product is the official record owner.",
    source: UFC_OFFICIAL.home,
    sourceLabel: "UFC.com",
  },
];

export const HOF_WINGS = [
  {
    key: "modern",
    label: "Modern Wing",
    subtitle: "Debuted in the modern era",
    names: [
      "Robbie Lawler", "Amanda Nunes", "Shogun Rua", "Joanna Jędrzejczyk", "Frankie Edgar", "José Aldo",
      "Donald Cerrone", "Khabib Nurmagomedov", "Daniel Cormier", "Georges St-Pierre", "Rashad Evans",
      "Michael Bisping", "Ronda Rousey", "Urijah Faber", "BJ Penn", "Forrest Griffin",
    ],
  },
  {
    key: "pioneer",
    label: "Pioneer Wing",
    subtitle: "Built the sport before the modern rules era",
    names: [
      "Mark Kerr", "Vitor Belfort", "Wanderlei Silva", "Anderson Silva", "Jens Pulver", "Kevin Randleman",
      "Rich Franklin", "Matt Serra", "Kazushi Sakuraba", "Maurice Smith", "Don Frye", "Minotauro Nogueira",
      "Bas Rutten", "Pat Miletich", "Tito Ortiz", "Matt Hughes", "Chuck Liddell", "Mark Coleman",
      "Randy Couture", "Dan Severn", "Ken Shamrock", "Royce Gracie",
    ],
  },
  {
    key: "contributors",
    label: "Contributor Wing",
    subtitle: "Changed the sport outside active competition",
    names: ["Craig Piligian", "Marc Ratner", "Art Davie", "Bruce Connal", "Joe Silva", "Bob Meyrowitz", "Jeff Blatnick", "Charles “Mask” Lewis"],
  },
] as const;

export const HOF_FIGHTS = [
  "Israel Adesanya vs Kelvin Gastelum",
  "Anderson Silva vs Chael Sonnen 1",
  "Robbie Lawler vs Rory MacDonald 2",
  "Cub Swanson vs Doo Ho Choi",
  "Jon Jones vs Alexander Gustafsson 1",
  "Diego Sanchez vs Clay Guida",
  "Shogun Rua vs Dan Henderson 1",
  "Mark Coleman vs Pete Williams",
  "Matt Hughes vs Frank Trigg 2",
  "Forrest Griffin vs Stephan Bonnar 1",
] as const;

/* Not a PropBetEdge GOAT ranking. These are lenses for talking about legacy
 * without turning an editorial page into an unsupported definitive list. */
export const LEGACY_LENSES = [
  { label: "Pioneer impact", body: "Who changed what fighters had to learn? Royce Gracie is the unavoidable starting point for that conversation." },
  { label: "Championship dominance", body: "Title wins, defenses, quality of opposition and sustained control of a division matter more than a single highlight." },
  { label: "Multi-division achievement", body: "Winning at championship level across weight classes adds a different kind of difficulty to a legacy case." },
  { label: "Technical evolution", body: "The greats do not only win — they introduce problems the next generation has to solve." },
  { label: "Longevity", body: "Elite performance across eras and changing opponent pools is its own historical signal." },
  { label: "Cultural impact", body: "Some fighters permanently change who watches, where the sport travels or what future athletes believe is possible." },
] as const;
