/* UFC Hall of Fame — PropBetEdge archive tribute dataset.
 *
 * Wing membership follows the official UFC Hall of Fame (docs at
 * UFC_OFFICIAL.hallOfFame). Only facts we are confident in are stored;
 * anything uncertain (an induction year, a record) is null and the UI omits
 * it rather than guessing. Pro records and portraits are resolved at render
 * time from the PropBetEdge fighter archive when the inductee exists there
 * (most inductees pre-date the round-stat archive, so the octagon monogram
 * is the expected fallback). Honors belong to the UFC; PropBetEdge is not
 * affiliated with or endorsed by UFC. */
import { slugify } from "@/lib/slug";

export type HofWingKey = "pioneer" | "modern" | "contributor" | "fight";

export type HofInductee = {
  slug: string;
  name: string;
  wing: Exclude<HofWingKey, "fight">;
  inducted: number | null;
  nationality: string | null;
  weightClasses: string[];
  role?: string;
  titles: string[];
  achievements: string[];
  signatureFights: string[];
  legacy: string;
};

const W = (name: string, wing: HofInductee["wing"], inducted: number | null, nationality: string | null, weightClasses: string[], legacy: string, extra: Partial<HofInductee> = {}): HofInductee => ({
  slug: slugify(name), name, wing, inducted, nationality, weightClasses, titles: [], achievements: [], signatureFights: [], legacy, ...extra,
});

export const HOF_WING_META: Record<HofWingKey, { label: string; short: string; blurb: string }> = {
  pioneer: { label: "Pioneer Wing", short: "Pioneer", blurb: "Fighters whose careers began before the Unified Rules era (debut before November 17, 2000)." },
  modern: { label: "Modern Wing", short: "Modern", blurb: "Fighters who debuted in the Unified Rules era, from The Ultimate Fighter generation to the champions of the 2010s." },
  contributor: { label: "Contributor Wing", short: "Contributor", blurb: "Executives, matchmakers, regulators, producers and broadcasters who built the sport outside the cage." },
  fight: { label: "Fight Wing", short: "Fight", blurb: "Individual bouts honored for their significance, action and enduring place in the sport's history." },
};

export const HOF_INDUCTEES: HofInductee[] = [
  /* ---- Pioneer Wing ---------------------------------------------------- */
  W("Royce Gracie", "pioneer", 2003, "Brazil", ["Open weight"], "Won the UFC 1, 2 and 4 tournaments and made Brazilian jiu-jitsu the first language every future champion had to learn.", {
    titles: ["UFC 1, UFC 2 and UFC 4 tournament winner"], achievements: ["Inaugural Hall of Fame class (2003)", "Submitted larger opponents in the earliest open-weight tournaments"], signatureFights: ["vs Ken Shamrock (UFC 1, 1993)", "vs Dan Severn (UFC 4, 1994)", "vs Kazushi Sakuraba (PRIDE 2000)"],
  }),
  W("Ken Shamrock", "pioneer", 2003, "United States", ["Open weight", "Light heavyweight"], "The original superfight rival and first UFC Superfight Champion; one of the sport's first crossover stars.", {
    titles: ["First UFC Superfight Champion"], achievements: ["Inaugural Hall of Fame class (2003)", "Coached opposite Tito Ortiz on The Ultimate Fighter 3"], signatureFights: ["vs Royce Gracie (UFC 1 and UFC 5)", "vs Dan Severn (UFC 6 and UFC 9)", "vs Tito Ortiz trilogy"],
  }),
  W("Dan Severn", "pioneer", 2005, "United States", ["Open weight", "Heavyweight"], "A decorated amateur wrestler who brought Greco-Roman control to the tournament era and won the UFC 5 tournament and Ultimate Ultimate 1995.", {
    titles: ["UFC 5 tournament winner", "Ultimate Ultimate 1995 winner", "UFC Superfight Champion"], signatureFights: ["vs Royce Gracie (UFC 4)", "vs Ken Shamrock (UFC 6 and UFC 9)"],
  }),
  W("Randy Couture", "pioneer", 2006, "United States", ["Heavyweight", "Light heavyweight"], "Heavyweight and light heavyweight champion whose clinch wrestling and late-career title wins defined longevity in the sport.", {
    titles: ["UFC Heavyweight Champion (multiple reigns)", "UFC Light Heavyweight Champion (multiple reigns)"], achievements: ["First fighter to hold UFC titles in two weight classes", "Won the heavyweight title at 43"], signatureFights: ["vs Chuck Liddell trilogy", "vs Tim Sylvia (UFC 68, 2007)", "vs Pedro Rizzo (UFC 31 and UFC 34)"],
  }),
  W("Mark Coleman", "pioneer", 2008, "United States", ["Heavyweight"], "The first UFC Heavyweight Champion and the wrestler credited with turning ground-and-pound into a game plan.", {
    titles: ["First UFC Heavyweight Champion", "UFC 10 and UFC 11 tournament winner", "PRIDE 2000 Open-Weight Grand Prix winner"], signatureFights: ["vs Dan Severn (UFC 12, 1997)", "vs Pete Williams (UFC 17, 1998)"],
  }),
  W("Chuck Liddell", "pioneer", 2009, "United States", ["Light heavyweight"], "The knockout artist whose light heavyweight reign carried the UFC into the mainstream television era.", {
    titles: ["UFC Light Heavyweight Champion"], achievements: ["Four consecutive title defenses", "Headlined the first UFC pay-per-view to break one million buys (UFC 66)"], signatureFights: ["vs Randy Couture trilogy", "vs Tito Ortiz (UFC 47 and UFC 66)", "vs Wanderlei Silva (UFC 79, 2007)"],
  }),
  W("Matt Hughes", "pioneer", 2010, "United States", ["Welterweight"], "Two-reign welterweight champion whose farm-strong wrestling set the standard for the division through the mid-2000s.", {
    titles: ["UFC Welterweight Champion (two reigns)"], achievements: ["Nine successful welterweight title defenses across two reigns"], signatureFights: ["vs Frank Trigg 2 (UFC 52, 2005 · Fight Wing)", "vs Georges St-Pierre (UFC 50, 2004)", "vs Royce Gracie (UFC 60, 2006)"],
  }),
  W("Tito Ortiz", "pioneer", 2012, "United States", ["Light heavyweight"], "Light heavyweight champion and one of the biggest draws of the early Zuffa era.", {
    titles: ["UFC Light Heavyweight Champion"], achievements: ["Five consecutive light heavyweight title defenses"], signatureFights: ["vs Ken Shamrock trilogy", "vs Chuck Liddell (UFC 47 and UFC 66)", "vs Forrest Griffin (UFC 59, 2006)"],
  }),
  W("Pat Miletich", "pioneer", 2014, "United States", ["Welterweight"], "The first UFC Welterweight Champion and the coach behind Miletich Fighting Systems, one of the sport's first great camps.", {
    titles: ["First UFC Welterweight (then lightweight) Champion"], achievements: ["Coached Matt Hughes, Jens Pulver, Robbie Lawler and Tim Sylvia"],
  }),
  W("Bas Rutten", "pioneer", 2015, "Netherlands", ["Heavyweight"], "Pancrase legend who won the UFC Heavyweight Championship in 1999 and became one of the sport's most recognizable voices.", {
    titles: ["UFC Heavyweight Champion (1999)", "King of Pancrase"], signatureFights: ["vs Kevin Randleman (UFC 20, 1999)"],
  }),
  W("Don Frye", "pioneer", 2016, "United States", ["Open weight", "Heavyweight"], "Tournament winner at UFC 8 and Ultimate Ultimate 1996 whose brawls defined the sport's early toughness.", {
    titles: ["UFC 8 tournament winner", "Ultimate Ultimate 1996 winner"], signatureFights: ["vs Yoshihiro Takayama (PRIDE 21, 2002)"],
  }),
  W("Kevin Randleman", "pioneer", null, "United States", ["Heavyweight"], "Explosive NCAA champion wrestler who won the UFC Heavyweight Championship in 1999 and later shocked PRIDE with an upset of Mirko Cro Cop.", {
    titles: ["UFC Heavyweight Champion (1999–2000)"], signatureFights: ["vs Mirko Cro Cop (PRIDE 2004)"],
  }),
  W("Maurice Smith", "pioneer", 2017, "United States", ["Heavyweight"], "Kickboxer who took the UFC Heavyweight Championship from Mark Coleman in 1997 and proved a striker could beat the wrestlers.", {
    titles: ["UFC Heavyweight Champion (1997)"], signatureFights: ["vs Mark Coleman (UFC 14, 1997)"],
  }),
  W("Kazushi Sakuraba", "pioneer", 2017, "Japan", ["Middleweight", "Open weight"], "Won the UFC Japan heavyweight tournament in 1997 and became the Gracie Hunter of the PRIDE era.", {
    titles: ["UFC Ultimate Japan tournament winner (1997)"], signatureFights: ["vs Royce Gracie (PRIDE 2000, 90 minutes)"],
  }),
  W("Matt Serra", "pioneer", 2018, "United States", ["Welterweight"], "The Ultimate Fighter 4 winner who knocked out Georges St-Pierre for the welterweight title in one of the sport's biggest upsets.", {
    titles: ["UFC Welterweight Champion (2007)", "The Ultimate Fighter 4 winner"], signatureFights: ["vs Georges St-Pierre (UFC 69, 2007)"],
  }),
  W("Rich Franklin", "pioneer", 2019, "United States", ["Middleweight", "Light heavyweight"], "Middleweight champion who defended the belt twice and later fought a generation of light heavyweight stars.", {
    titles: ["UFC Middleweight Champion"], signatureFights: ["vs Anderson Silva (UFC 64 and UFC 77)", "vs Chuck Liddell (UFC 115, 2010)"],
  }),
  W("Minotauro Nogueira", "pioneer", 2021, "Brazil", ["Heavyweight"], "PRIDE heavyweight champion who won the UFC interim heavyweight title in 2008 with the durability and jiu-jitsu that defined his era.", {
    titles: ["UFC Interim Heavyweight Champion (2008)", "PRIDE Heavyweight Champion"], signatureFights: ["vs Tim Sylvia (UFC 81, 2008)", "vs Fedor Emelianenko (PRIDE)"],
  }),
  W("Jens Pulver", "pioneer", 2021, "United States", ["Lightweight"], "The first UFC Lightweight Champion and the face of the division in its first years.", {
    titles: ["First UFC Lightweight Champion (2001)"], signatureFights: ["vs BJ Penn (UFC 35, 2002)"],
  }),
  W("Anderson Silva", "pioneer", 2023, "Brazil", ["Middleweight", "Light heavyweight"], "Middleweight champion for nearly seven years, with the longest title reign and win streak in UFC history at the time.", {
    titles: ["UFC Middleweight Champion (2006–2013)"], achievements: ["Ten consecutive title defenses", "Sixteen-fight UFC win streak"], signatureFights: ["vs Chael Sonnen 1 (UFC 117, 2010 · Fight Wing)", "vs Vitor Belfort (UFC 126, 2011)", "vs Forrest Griffin (UFC 101, 2009)"],
  }),
  W("Wanderlei Silva", "pioneer", null, "Brazil", ["Middleweight", "Light heavyweight"], "PRIDE middleweight champion whose pressure and knockouts made him one of the most feared fighters of his era before his UFC run.", {
    titles: ["PRIDE Middleweight Champion"], signatureFights: ["vs Chuck Liddell (UFC 79, 2007)"],
  }),
  W("Vitor Belfort", "pioneer", null, "Brazil", ["Heavyweight", "Light heavyweight", "Middleweight"], "Won the UFC 12 heavyweight tournament at 19 and remained a title challenger across three divisions for two decades.", {
    titles: ["UFC 12 tournament winner (1997)", "UFC Light Heavyweight Champion (2004)"], signatureFights: ["vs Randy Couture (UFC 46, 2004)"],
  }),
  W("Mark Kerr", "pioneer", null, "United States", ["Heavyweight"], "Two-time UFC tournament winner in 1997 and a PRIDE star whose career became the subject of the documentary The Smashing Machine.", {
    titles: ["UFC 14 and UFC 15 heavyweight tournament winner"],
  }),
  /* ---- Modern Wing ----------------------------------------------------- */
  W("Forrest Griffin", "modern", 2013, "United States", ["Light heavyweight"], "The Ultimate Fighter 1 winner whose finale with Stephan Bonnar is credited with proving the sport to a television audience; later light heavyweight champion.", {
    titles: ["UFC Light Heavyweight Champion (2008)", "The Ultimate Fighter 1 winner"], signatureFights: ["vs Stephan Bonnar 1 (TUF 1 Finale, 2005 · Fight Wing)", "vs Quinton Jackson (UFC 86, 2008)"],
  }),
  W("Stephan Bonnar", "modern", 2013, "United States", ["Light heavyweight"], "The other half of the fight that changed the sport's trajectory, inducted alongside Forrest Griffin.", {
    signatureFights: ["vs Forrest Griffin 1 (TUF 1 Finale, 2005 · Fight Wing)"],
  }),
  W("BJ Penn", "modern", 2015, "United States", ["Lightweight", "Welterweight"], "Two-division champion whose jiu-jitsu and boxing made him the lightweight benchmark of the late 2000s.", {
    titles: ["UFC Lightweight Champion", "UFC Welterweight Champion"], signatureFights: ["vs Matt Hughes (UFC 46, 2004)", "vs Sean Sherk (UFC 84, 2008)", "vs Diego Sanchez (UFC 107, 2009)"],
  }),
  W("Urijah Faber", "modern", 2017, "United States", ["Featherweight", "Bantamweight"], "WEC featherweight champion who carried the lighter weight classes into the UFC and remained a bantamweight title contender for years.", {
    titles: ["WEC Featherweight Champion"], achievements: ["First inductee of the Modern Wing"],
  }),
  W("Ronda Rousey", "modern", 2018, "United States", ["Women's bantamweight"], "First women's champion in UFC history and the fighter who made women's MMA a main-event attraction.", {
    titles: ["Inaugural UFC Women's Bantamweight Champion (2012–2015)"], achievements: ["Six consecutive title defenses", "First woman inducted into the Hall of Fame"], signatureFights: ["vs Liz Carmouche (UFC 157, 2013)", "vs Miesha Tate (UFC 168, 2013)", "vs Cat Zingano (UFC 184, 2015)"],
  }),
  W("Michael Bisping", "modern", 2019, "United Kingdom", ["Middleweight"], "The Ultimate Fighter 3 winner who became the first British UFC champion by knocking out Luke Rockhold in 2016.", {
    titles: ["UFC Middleweight Champion (2016–2017)", "The Ultimate Fighter 3 winner"], signatureFights: ["vs Luke Rockhold (UFC 199, 2016)", "vs Dan Henderson (UFC 204, 2016)"],
  }),
  W("Rashad Evans", "modern", 2019, "United States", ["Light heavyweight"], "The Ultimate Fighter 2 heavyweight winner who dropped to light heavyweight and won the title with a knockout of Forrest Griffin.", {
    titles: ["UFC Light Heavyweight Champion (2008–2009)", "The Ultimate Fighter 2 winner"], signatureFights: ["vs Chuck Liddell (UFC 88, 2008)", "vs Forrest Griffin (UFC 92, 2008)"],
  }),
  W("Georges St-Pierre", "modern", 2020, "Canada", ["Welterweight", "Middleweight"], "Welterweight champion across two reigns and a middleweight title winner; the model of complete, adaptable mixed martial arts.", {
    titles: ["UFC Welterweight Champion (two reigns)", "UFC Middleweight Champion (2017)"], achievements: ["Nine consecutive welterweight title defenses", "Champion in two divisions"], signatureFights: ["vs Matt Hughes (UFC 65, 2006)", "vs BJ Penn 2 (UFC 94, 2009)", "vs Michael Bisping (UFC 217, 2017)"],
  }),
  W("Daniel Cormier", "modern", 2022, "United States", ["Heavyweight", "Light heavyweight"], "Simultaneous heavyweight and light heavyweight champion; elite wrestling applied to the five-round problem.", {
    titles: ["UFC Light Heavyweight Champion (2015–2018)", "UFC Heavyweight Champion (2018–2019)"], achievements: ["Held two UFC titles at the same time"], signatureFights: ["vs Stipe Miocic trilogy", "vs Alexander Gustafsson (UFC 192, 2015)"],
  }),
  W("Khabib Nurmagomedov", "modern", 2022, "Russia", ["Lightweight"], "Retired undefeated as lightweight champion with smothering pressure grappling that opponents never solved.", {
    titles: ["UFC Lightweight Champion (2018–2020)"], achievements: ["Retired 29-0", "Three title defenses, all finishes"], signatureFights: ["vs Conor McGregor (UFC 229, 2018)", "vs Dustin Poirier (UFC 242, 2019)", "vs Justin Gaethje (UFC 254, 2020)"],
  }),
  W("Donald Cerrone", "modern", 2023, "United States", ["Lightweight", "Welterweight"], "The most active fighter of his generation, with the most UFC fights, wins and finishes of anyone at the time of his retirement.", {
    achievements: ["Record holder for the most UFC bouts and finishes when he retired", "Fought across lightweight and welterweight for over a decade"],
  }),
  W("José Aldo", "modern", 2023, "Brazil", ["Featherweight", "Bantamweight"], "The first UFC Featherweight Champion, undefeated at 145 pounds for a decade across the WEC and UFC.", {
    titles: ["Inaugural UFC Featherweight Champion", "WEC Featherweight Champion"], achievements: ["Seven consecutive UFC featherweight title defenses"], signatureFights: ["vs Chad Mendes 2 (UFC 179, 2014)", "vs Frankie Edgar (UFC 156, 2013)"],
  }),
  W("Frankie Edgar", "modern", null, "United States", ["Lightweight", "Featherweight", "Bantamweight"], "Undersized lightweight champion who beat BJ Penn twice and fought title challengers across three divisions.", {
    titles: ["UFC Lightweight Champion (2010–2012)"], signatureFights: ["vs BJ Penn (UFC 112 and UFC 118, 2010)", "vs Gray Maynard trilogy"],
  }),
  W("Joanna Jędrzejczyk", "modern", null, "Poland", ["Women's strawweight"], "Strawweight champion whose volume striking set the division's standard and produced a five-round war with Zhang Weili.", {
    titles: ["UFC Women's Strawweight Champion (2015–2017)"], achievements: ["Five consecutive strawweight title defenses"], signatureFights: ["vs Zhang Weili 1 (UFC 248, 2020)"],
  }),
  W("Shogun Rua", "modern", null, "Brazil", ["Light heavyweight"], "PRIDE 2005 Grand Prix winner who won the UFC Light Heavyweight Championship in 2010 and fought one of the Fight Wing's great wars.", {
    titles: ["UFC Light Heavyweight Champion (2010–2011)", "PRIDE 2005 Middleweight Grand Prix winner"], signatureFights: ["vs Dan Henderson 1 (UFC 139, 2011 · Fight Wing)", "vs Lyoto Machida (UFC 104 and UFC 113)"],
  }),
  W("Amanda Nunes", "modern", 2025, "Brazil", ["Women's bantamweight", "Women's featherweight"], "Two-division women's champion who beat every champion the bantamweight and featherweight divisions had produced.", {
    titles: ["UFC Women's Bantamweight Champion (two reigns)", "UFC Women's Featherweight Champion"], achievements: ["First woman to hold two UFC titles at once"], signatureFights: ["vs Ronda Rousey (UFC 207, 2016)", "vs Cris Cyborg (UFC 232, 2018)"],
  }),
  W("Robbie Lawler", "modern", null, "United States", ["Welterweight"], "Welterweight champion whose second career produced some of the division's most violent title fights.", {
    titles: ["UFC Welterweight Champion (2014–2016)"], signatureFights: ["vs Rory MacDonald 2 (UFC 189, 2015 · Fight Wing)", "vs Carlos Condit (UFC 195, 2016)"],
  }),
  /* ---- Contributor Wing ------------------------------------------------ */
  W("Art Davie", "contributor", 2018, "United States", [], "Co-creator of the original Ultimate Fighting Championship concept and UFC 1.", { role: "Co-founder, UFC 1" }),
  W("Bob Meyrowitz", "contributor", null, "United States", [], "SEG chief who produced and owned the UFC through its first eight years before the Zuffa sale.", { role: "Producer and owner, SEG era" }),
  W("Jeff Blatnick", "contributor", 2015, "United States", [], "Olympic wrestling gold medalist, longtime UFC commentator and the commissioner who helped write and champion the Unified Rules.", { role: "Commentator and commissioner" }),
  W("Marc Ratner", "contributor", 2021, "United States", [], "Nevada athletic commission executive who later led UFC regulatory affairs and drove the sport's legalization state by state.", { role: "Regulatory affairs" }),
  W("Joe Silva", "contributor", 2017, "United States", [], "The UFC's matchmaker for two decades, credited with building the fights that shaped every division.", { role: "Matchmaker" }),
  W("Charles “Mask” Lewis", "contributor", 2009, "United States", [], "TapouT co-founder whose brand and support of fighters helped carry the sport through its lean years.", { role: "TapouT co-founder" }),
  W("Bruce Connal", "contributor", 2018, "United States", [], "Television producer behind UFC's broadcast presentation for more than a decade.", { role: "Broadcast producer" }),
  W("Craig Piligian", "contributor", null, "United States", [], "Producer of The Ultimate Fighter, the reality series that introduced the sport to a mainstream television audience.", { role: "The Ultimate Fighter producer" }),
];

export const HOF_BY_SLUG = new Map(HOF_INDUCTEES.map((h) => [h.slug, h]));
export const HOF_WING_ORDER: HofWingKey[] = ["modern", "pioneer", "contributor", "fight"];

export function inducteesIn(wing: HofInductee["wing"]): HofInductee[] {
  return HOF_INDUCTEES.filter((h) => h.wing === wing).sort((a, b) => (a.inducted ?? 9999) - (b.inducted ?? 9999) || a.name.localeCompare(b.name));
}

export function initialsOf(name: string): string {
  return name.replace(/[“”"]/g, "").split(/\s+/).filter((p) => p.length > 1 || /^[A-Z]$/.test(p)).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}
