/* Curated UFC heritage layer: history eras, Hall of Fame tribute data and the
 * official UFC destinations PropBetEdge points readers toward.
 *
 * Editorial rules for this file:
 * - Every era and honoree links to an official UFC destination. UFC.com is
 *   the record owner; PropBetEdge adds independent context and evidence.
 * - Nothing here is a PropBetEdge "GOAT ranking". Hall of Fame membership and
 *   wing assignments are UFC's designations.
 * - No partnership, sponsorship or endorsement is implied anywhere. */

export const UFC_OFFICIAL = {
  home: "https://www.ufc.com/",
  events: "https://www.ufc.com/events",
  athletes: "https://www.ufc.com/athletes",
  hallOfFame: "https://www.ufc.com/ufc-hall-of-fame",
  ufc1: "https://www.ufc.com/event/ufc-1",
  history30: "https://www.ufc.com/30",
  store: "https://www.ufcstore.com/en/",
  fightPass: "https://www.ufcfightpass.com/",
  youtube: "https://www.youtube.com/@ufc",
  rankings: "https://www.ufc.com/rankings",
  contenderSeries: "https://www.ufc.com/dwcs",
  news: "https://www.ufc.com/news",
} as const;

/* One reusable "Official UFC" destination group. Order matters: the promotion's
 * home first, then the pages readers most often need next to our own data. */
export const OFFICIAL_DESTINATIONS = [
  { key: "home", label: "UFC.com", note: "Official home of the promotion", href: UFC_OFFICIAL.home },
  { key: "athletes", label: "UFC Athletes", note: "Official fighter directory", href: UFC_OFFICIAL.athletes },
  { key: "rankings", label: "UFC Rankings", note: "Official divisional rankings", href: UFC_OFFICIAL.rankings },
  { key: "hall", label: "UFC Hall of Fame", note: "Official inductees and wings", href: UFC_OFFICIAL.hallOfFame },
  { key: "fightpass", label: "UFC Fight Pass", note: "Watch the official archive", href: UFC_OFFICIAL.fightPass },
  { key: "store", label: "UFC Store", note: "Official UFC merchandise", href: UFC_OFFICIAL.store },
] as const;

export type HeritageEra = {
  key: string;
  number: string;
  years: string;
  eyebrow: string;
  title: string;
  summary: string;
  whyItMattered: string;
  moments: Array<{ year: string; text: string }>;
  figures: string[];
  sources: Array<{ label: string; href: string }>;
};

export const UFC_ERAS: HeritageEra[] = [
  {
    key: "beginning",
    number: "01",
    years: "1993",
    eyebrow: "The beginning",
    title: "UFC 1 asks the original question",
    summary:
      "On November 12, 1993 in Denver, an eight-man, single-night tournament put fighters from different martial arts into one cage with no weight classes, no judges, no rounds and a rule set that was sparse rather than literally rule-free. The premise was simple and provocative: which style actually works when the other side is not playing your game?",
    whyItMattered:
      "The event was built as a spectacle, but it functioned as an experiment. Every assumption about fighting — that size decides, that striking beats grappling, that a single discipline is enough — was tested in public in one evening. The answers reorganized the sport.",
    moments: [
      { year: "1993", text: "UFC 1 at McNichols Sports Arena in Denver, Colorado. Eight fighters, one night, one winner." },
      { year: "1993", text: "Royce Gracie wins three fights in one evening, submitting larger opponents and finishing the tournament in minutes of total cage time." },
      { year: "1993", text: "Gerard Gordeau's kick on Teila Tuli in the opening fight becomes the enduring image of how raw the early rule set was." },
    ],
    figures: ["Art Davie", "Rorion Gracie", "Royce Gracie", "Ken Shamrock", "Gerard Gordeau"],
    sources: [{ label: "Official UFC 1 event page", href: UFC_OFFICIAL.ufc1 }, { label: "UFC's 30-year history", href: UFC_OFFICIAL.history30 }],
  },
  {
    key: "gracie",
    number: "02",
    years: "1993 – 1995",
    eyebrow: "The Gracie influence",
    title: "Jiu-jitsu shocks the system",
    summary:
      "Royce Gracie was the smallest man in most of his brackets and won UFC 1, UFC 2 and UFC 4. Brazilian jiu-jitsu — position, patience and the submission — proved that a fight could be controlled from the ground by someone who never threw the harder punch.",
    whyItMattered:
      "Before Gracie, most fighters trained one art. After him, grappling literacy became mandatory. Every future champion, whatever their base, had to learn how to stop a takedown, survive on the ground and finish or escape a submission. Mixed martial arts as a single discipline begins here.",
    moments: [
      { year: "1994", text: "UFC 2 expands to a 16-man bracket; Gracie wins four fights in one night." },
      { year: "1994", text: "UFC 4: Gracie submits Dan Severn, a decorated wrestler, after being controlled for most of the fight — the reference case for jiu-jitsu from the bottom." },
      { year: "1995", text: "UFC 5: Gracie and Ken Shamrock fight to a 36-minute draw in the first 'superfight', exposing the limits of no-time-limit bouts." },
    ],
    figures: ["Royce Gracie", "Ken Shamrock", "Dan Severn", "Rorion Gracie"],
    sources: [{ label: "UFC Hall of Fame · Pioneer Wing", href: UFC_OFFICIAL.hallOfFame }, { label: "UFC's 30-year history", href: UFC_OFFICIAL.history30 }],
  },
  {
    key: "rules",
    number: "03",
    years: "1995 – 2000",
    eyebrow: "Rules, regulation, modernization",
    title: "From spectacle to a regulated sport",
    summary:
      "The lawless reputation nearly killed the promotion. Political pressure and lost television distribution forced structural change: time limits, then rounds, mandatory gloves, weight classes, a growing list of fouls and, finally, state athletic-commission sanctioning under a unified rule set.",
    whyItMattered:
      "Regulation did not remove what made the sport compelling; it made the competition repeatable and comparable. Rounds created pacing. Weight classes created divisions and title lineages. Sanctioning made the results an official record — the record this archive is built to hold.",
    moments: [
      { year: "1995", text: "Time limits and judges arrive after the no-time-limit draws of the early superfights." },
      { year: "1997", text: "UFC 12 introduces weight divisions; UFC 14 makes padded gloves mandatory." },
      { year: "1999", text: "UFC 21 adopts five-minute rounds, giving fights the structure still used today." },
      { year: "2000", text: "The Unified Rules of Mixed Martial Arts are adopted; UFC 28 in New Jersey is the first UFC event under them. UFC's Hall of Fame uses this date to divide its Pioneer and Modern wings." },
    ],
    figures: ["Jeff Blatnick", "'Big' John McCarthy", "Marc Ratner", "Mark Coleman", "Randy Couture", "Pat Miletich"],
    sources: [{ label: "Official UFC Hall of Fame", href: UFC_OFFICIAL.hallOfFame }, { label: "UFC's 30-year history", href: UFC_OFFICIAL.history30 }],
  },
  {
    key: "zuffa",
    number: "04",
    years: "2001 – 2004",
    eyebrow: "Zuffa, Dana White and the rebuild",
    title: "New ownership rebuilds the promotion",
    summary:
      "In January 2001 Zuffa, LLC — Lorenzo and Frank Fertitta with Dana White as president — bought the UFC and inherited a brand with a reputation problem and almost no distribution. The rebuild ran on three fronts: regulatory legitimacy state by state, a return to pay-per-view and cable, and fight promotion built around personalities as much as belts.",
    whyItMattered:
      "This is the era in which the UFC became a business capable of surviving. Nevada sanctioning brought the promotion to Las Vegas, the modern home of its biggest cards. The matchmaking, presentation and promotional style established here still shape how fights are announced and sold.",
    moments: [
      { year: "2001", text: "Zuffa acquires the UFC; Dana White becomes president and the promotion's public face." },
      { year: "2001", text: "Nevada sanctions the sport; UFC 33 becomes the first UFC event in Las Vegas." },
      { year: "2002", text: "UFC 40 — Tito Ortiz vs Ken Shamrock — shows the pay-per-view ceiling is far higher than the previous years suggested." },
    ],
    figures: ["Dana White", "Lorenzo Fertitta", "Frank Fertitta III", "Tito Ortiz", "Chuck Liddell", "Matt Hughes"],
    sources: [{ label: "UFC's 30-year history", href: UFC_OFFICIAL.history30 }, { label: "UFC.com", href: UFC_OFFICIAL.home }],
  },
  {
    key: "tuf",
    number: "05",
    years: "2005 – 2011",
    eyebrow: "The Ultimate Fighter and the mainstream",
    title: "Television turns a niche into a mainstream sport",
    summary:
      "The Ultimate Fighter premiered on Spike TV in January 2005 and its live finale on April 9, 2005 — Forrest Griffin against Stephan Bonnar — became one of the most consequential fights in the sport's history. Free-to-air television built an audience, and the UFC's biggest stars became household names.",
    whyItMattered:
      "This was the acceleration. Reality television turned fighters into characters, pay-per-view numbers climbed, international events became routine and the UFC absorbed rival promotions and their champions. The modern superstar era — Liddell, St-Pierre, Silva, Penn, Lesnar — was built on this foundation.",
    moments: [
      { year: "2005", text: "Griffin vs Bonnar at The Ultimate Fighter Finale; both are later inducted into the UFC Hall of Fame Fight Wing." },
      { year: "2006", text: "Chuck Liddell vs Tito Ortiz 2 at UFC 66 marks a pay-per-view high-water mark for the era." },
      { year: "2009", text: "UFC 100 with Brock Lesnar, Georges St-Pierre and Dan Henderson headlines becomes a landmark card." },
      { year: "2011", text: "The UFC signs a broadcast deal with FOX, bringing live cards to network television." },
    ],
    figures: ["Forrest Griffin", "Stephan Bonnar", "Chuck Liddell", "Georges St-Pierre", "Anderson Silva", "BJ Penn", "Brock Lesnar"],
    sources: [{ label: "UFC Hall of Fame · Fight Wing", href: UFC_OFFICIAL.hallOfFame }, { label: "UFC's 30-year history", href: UFC_OFFICIAL.history30 }],
  },
  {
    key: "global",
    number: "06",
    years: "2012 – 2022",
    eyebrow: "Global expansion, women's MMA, championship evolution",
    title: "The sport goes global and the roster changes shape",
    summary:
      "The UFC added women's divisions beginning with the bantamweight title in 2013, followed by strawweight, flyweight and featherweight. Events spread across Brazil, Europe, Asia, Australia and the Middle East. New champions arrived with complete, layered skill sets and the sport's stars became global celebrities.",
    whyItMattered:
      "This era changed who a UFC champion could be and where the sport could travel. Ronda Rousey, Joanna Jędrzejczyk, Amanda Nunes and Valentina Shevchenko built women's title lineages from nothing. Conor McGregor and Khabib Nurmagomedov redefined the commercial ceiling. In 2016 the promotion sold to WME-IMG (now Endeavor) for roughly four billion dollars.",
    moments: [
      { year: "2013", text: "UFC 157: Ronda Rousey vs Liz Carmouche, the first women's fight and title defense in UFC history." },
      { year: "2014", text: "The strawweight division launches through The Ultimate Fighter; Joanna Jędrzejczyk's title run soon follows." },
      { year: "2016", text: "Conor McGregor becomes the first fighter to hold two UFC titles simultaneously at UFC 205 in New York; WME-IMG acquires the UFC." },
      { year: "2018", text: "UFC 229: Khabib Nurmagomedov vs Conor McGregor sets the promotion's pay-per-view record." },
      { year: "2019", text: "ESPN becomes the UFC's U.S. broadcast home; UFC Apex opens in Las Vegas in 2019 and carries the 2020 pandemic schedule." },
    ],
    figures: ["Ronda Rousey", "Joanna Jędrzejczyk", "Amanda Nunes", "Valentina Shevchenko", "Conor McGregor", "Khabib Nurmagomedov", "Jon Jones", "Zhang Weili"],
    sources: [{ label: "UFC Athletes", href: UFC_OFFICIAL.athletes }, { label: "UFC's 30-year history", href: UFC_OFFICIAL.history30 }],
  },
  {
    key: "data",
    number: "07",
    years: "2023 – today",
    eyebrow: "Today · the data era",
    title: "A measurable sport, a global calendar",
    summary:
      "The modern UFC runs a year-round schedule of numbered pay-per-views, Fight Nights and the Contender Series talent pipeline, under TKO Group Holdings since 2023. Every fight now leaves a trail: official results, round-by-round striking and grappling statistics, rankings movement, film, official media and a live fight-week news cycle.",
    whyItMattered:
      "Fights can be understood at round level, not just by the result. That is where PropBetEdge sits: an independent intelligence layer that keeps the schedule, fighter identity, results, round evidence, rankings snapshots, source-linked media and editorial context in one place — while UFC.com and Fight Pass remain the official record and viewing destinations.",
    moments: [
      { year: "2023", text: "UFC and WWE combine under TKO Group Holdings; UFC marks its 30th anniversary." },
      { year: "2024", text: "UFC 300 stacks a card of current and former champions in Las Vegas." },
      { year: "Now", text: "PropBetEdge indexes the live schedule, Fight DNA round evidence, dated rankings snapshots and a results archive that reports its own coverage honestly, event by event." },
    ],
    figures: ["Islam Makhachev", "Alex Pereira", "Ilia Topuria", "Jon Jones", "Valentina Shevchenko", "Zhang Weili"],
    sources: [{ label: "UFC.com", href: UFC_OFFICIAL.home }, { label: "UFC Fight Pass", href: UFC_OFFICIAL.fightPass }, { label: "Official UFC rankings", href: UFC_OFFICIAL.rankings }],
  },
];

/* Legacy timeline kept for compact surfaces (footer teasers, JSON-LD). */
export type HeritageMoment = { year: string; eyebrow: string; title: string; body: string; source: string; sourceLabel: string };
export const UFC_HISTORY: HeritageMoment[] = UFC_ERAS.map((era) => ({ year: era.years, eyebrow: era.eyebrow, title: era.title, body: era.summary, source: era.sources[0].href, sourceLabel: era.sources[0].label }));

/* ---- Hall of Fame tribute ------------------------------------------------ */
export type HofWing = { key: string; label: string; subtitle: string; description: string; names: readonly string[] };

export const HOF_WINGS: readonly HofWing[] = [
  {
    key: "pioneer",
    label: "Pioneer Wing",
    subtitle: "Debuted before November 17, 2000",
    description: "Fighters whose careers began before the Unified Rules era. They fought without the structure modern athletes take for granted and built the sport's first title lineages.",
    names: [
      "Royce Gracie", "Ken Shamrock", "Dan Severn", "Randy Couture", "Mark Coleman", "Chuck Liddell", "Matt Hughes", "Tito Ortiz",
      "Pat Miletich", "Bas Rutten", "Minotauro Nogueira", "Don Frye", "Maurice Smith", "Kazushi Sakuraba", "Matt Serra", "Rich Franklin",
      "Kevin Randleman", "Jens Pulver", "Anderson Silva", "Wanderlei Silva", "Vitor Belfort", "Mark Kerr",
    ],
  },
  {
    key: "modern",
    label: "Modern Wing",
    subtitle: "Debuted in the Unified Rules era",
    description: "Champions and contenders of the modern era, from the first Ultimate Fighter generation to two-division champions and the fighters who built the women's divisions.",
    names: [
      "Forrest Griffin", "BJ Penn", "Urijah Faber", "Ronda Rousey", "Michael Bisping", "Rashad Evans", "Georges St-Pierre", "Daniel Cormier",
      "Khabib Nurmagomedov", "Donald Cerrone", "José Aldo", "Frankie Edgar", "Joanna Jędrzejczyk", "Shogun Rua", "Amanda Nunes", "Robbie Lawler",
    ],
  },
  {
    key: "contributors",
    label: "Contributor Wing",
    subtitle: "Built the sport outside the cage",
    description: "Executives, matchmakers, regulators, producers and broadcasters whose work made the sport possible, legal, watchable and safe.",
    names: ["Art Davie", "Bob Meyrowitz", "Jeff Blatnick", "Marc Ratner", "Joe Silva", "Charles “Mask” Lewis", "Bruce Connal", "Craig Piligian"],
  },
];

export type HofFeatured = { name: string; wing: string; inducted: string; blurb: string };
export const HOF_FEATURED: HofFeatured[] = [
  { name: "Royce Gracie", wing: "Pioneer Wing", inducted: "2003 · inaugural class", blurb: "Won UFC 1, 2 and 4 and made jiu-jitsu the first language every future champion had to learn." },
  { name: "Ken Shamrock", wing: "Pioneer Wing", inducted: "2003 · inaugural class", blurb: "The original superfight rival, first UFC Superfight Champion and one of the sport's first crossover stars." },
  { name: "Randy Couture", wing: "Pioneer Wing", inducted: "2006", blurb: "Heavyweight and light heavyweight champion whose clinch wrestling and late-career title wins defined longevity." },
  { name: "Chuck Liddell", wing: "Pioneer Wing", inducted: "2009", blurb: "The knockout artist whose light heavyweight reign carried the UFC into the mainstream television era." },
  { name: "Ronda Rousey", wing: "Modern Wing", inducted: "2018", blurb: "First women's champion in UFC history and the fighter who made women's MMA a main-event attraction." },
  { name: "Georges St-Pierre", wing: "Modern Wing", inducted: "2020", blurb: "Welterweight champion across two reigns and a middleweight title winner; the model of complete, adaptable MMA." },
  { name: "Daniel Cormier", wing: "Modern Wing", inducted: "2022", blurb: "Simultaneous heavyweight and light heavyweight champion; elite wrestling applied to the five-round problem." },
  { name: "Khabib Nurmagomedov", wing: "Modern Wing", inducted: "2022", blurb: "Retired undefeated as lightweight champion; smothering pressure grappling that opponents never solved." },
];

export type HofFight = { fight: string; event: string; year: string; note: string };
export const HOF_FIGHTS: HofFight[] = [
  { fight: "Forrest Griffin vs Stephan Bonnar 1", event: "The Ultimate Fighter Finale", year: "2005", note: "The fight credited with proving the sport to a television audience." },
  { fight: "Mark Coleman vs Pete Williams", event: "UFC 17", year: "1998", note: "Williams' head-kick knockout of the dominant wrestler — one of the first great upsets of the rules era." },
  { fight: "Matt Hughes vs Frank Trigg 2", event: "UFC 52", year: "2005", note: "Hughes survives a low blow and a near-finish, then carries Trigg across the cage and submits him." },
  { fight: "Diego Sanchez vs Clay Guida", event: "The Ultimate Fighter 9 Finale", year: "2009", note: "Three rounds of relentless pace that became the reference point for a lightweight war." },
  { fight: "Anderson Silva vs Chael Sonnen 1", event: "UFC 117", year: "2010", note: "Four and a half rounds of domination undone by a fifth-round triangle." },
  { fight: "Shogun Rua vs Dan Henderson 1", event: "UFC 139", year: "2011", note: "A five-round fight in which both men were nearly finished and neither stopped coming forward." },
  { fight: "Jon Jones vs Alexander Gustafsson 1", event: "UFC 165", year: "2013", note: "The closest anyone came to Jones' light heavyweight title in his first reign." },
  { fight: "Robbie Lawler vs Rory MacDonald 2", event: "UFC 189", year: "2015", note: "A welterweight title fight remembered for the stare-down between rounds four and five." },
  { fight: "Cub Swanson vs Doo Ho Choi", event: "UFC 206", year: "2016", note: "A three-round featherweight exchange with both fighters hurt and both refusing to slow down." },
  { fight: "Israel Adesanya vs Kelvin Gastelum", event: "UFC 236", year: "2019", note: "An interim middleweight title fight decided in a fifth round both men needed to win." },
];

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
