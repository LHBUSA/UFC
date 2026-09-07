import { notFound } from "next/navigation";
import type { Bout, Event, Fighter, RankingsSnapshot, PortraitSet, OfficialVideoRow } from "@/lib/db";
import { VideoRail } from "@/components/VideoRail";
import { buildDeskBriefs } from "@/lib/pregame";
import { PregameDesk } from "@/components/PregameDesk";
import { ChampionsShowcase } from "@/components/ChampionsShowcase";
import { ContenderStrip } from "@/components/ContenderStrip";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";

/* Development-only visual QA fixtures for data-driven modules. This route
 * returns 404 on production and on any Vercel deployment; it exists so the
 * Pregame Desk, championship stage and Contender Series strip can be
 * rendered locally without database credentials. Names are synthetic. */
export const dynamic = "force-dynamic";

const fighter = (id: string, name: string, extra: Partial<Fighter> = {}): Fighter => ({
  id, ufcstats_id: null, espn_athlete_id: null, name, nickname: null, dob: "1994-05-01", height_in: 70, reach_in: 72, weight_lbs: 155, stance: "ORTHODOX",
  record_w: 14, record_l: 2, record_d: 0, record_nc: 0, is_active: true,
  career_slpm: 4.9, career_str_acc: 0.49, career_sapm: 3.1, career_str_def: 0.61, career_td_avg: 0.8, career_td_acc: 0.4, career_td_def: 0.78, career_sub_avg: 0.3, ...extra,
});

export default async function QaPreview() {
  if (process.env.VERCEL_ENV || process.env.NODE_ENV === "production" && process.env.PBE_QA_PREVIEW !== "1") notFound();
  const event: Event = { id: "ev-1", ufcstats_id: null, espn_event_id: null, name: "UFC 999: Alpha vs. Bravo", event_date: "2026-09-19", venue: "T-Mobile Arena", city: "Las Vegas", region: "NV", country: "USA", card_status: "announced", is_ppv: true };
  const a = fighter("f-a", "Alpha Silva", { nickname: "Lord", reach_in: 69, height_in: 67, career_slpm: 5.6, career_sapm: 4.2, career_str_acc: 0.52, career_str_def: 0.54, career_td_avg: 0.3, career_td_def: 0.62, record_w: 17, record_l: 3 });
  const b = fighter("f-b", "Bravo Kane", { nickname: "The Engine", reach_in: 73, height_in: 71, stance: "SOUTHPAW", career_slpm: 3.4, career_sapm: 2.6, career_str_acc: 0.47, career_str_def: 0.63, career_td_avg: 3.1, career_td_acc: 0.44, career_td_def: 0.8, career_sub_avg: 1.2, record_w: 12, record_l: 2 });
  const c = fighter("f-c", "Charlie Ortega", { career_slpm: 4.2, career_td_avg: 1.9, career_td_def: 0.7 });
  const dd = fighter("f-d", "Delta Moreno", { stance: "SWITCH", career_slpm: 4.8, career_sapm: 4.6, career_str_def: 0.5, career_td_avg: 0.5, career_td_def: 0.55 });
  const e1 = fighter("f-e", "Echo Vance", { career_slpm: null, career_td_avg: null, career_str_acc: null, record_w: 6, record_l: 0 });
  const f1 = fighter("f-f", "Foxtrot Reyes", { career_slpm: 3.9, career_td_avg: 2.2 });
  const bout = (id: string, x: Fighter, y: Fighter, order: number, extra: Partial<Bout> = {}): Bout => ({ id, ufcstats_id: null, espn_competition_id: null, event_id: event.id, weight_class: "LIGHTWEIGHT", is_womens: false, is_title: false, scheduled_rounds: 3, card_position: "MAIN", bout_order: order, status: "scheduled", fighter_a: x, fighter_b: y, result: null, ...extra });
  const bouts = [bout("b-1", a, b, 1, { is_title: true, scheduled_rounds: 5 }), bout("b-2", c, dd, 2, { weight_class: "WELTERWEIGHT" }), bout("b-3", e1, f1, 3, { weight_class: "FEATHERWEIGHT" })];
  const briefs = await buildDeskBriefs(event, bouts, 3);
  /* Fixture portraits: the self-hosted voice photos stand in for fighter art so the desk crop system can be inspected locally. */
  const ps = (id: string, src: string): PortraitSet => ({ id, portrait: src, card: src, thumb: src, license: "Public domain", author: "fixture", source_url: null, kind: "public_domain", stored_first_party: true });
  const fixtureImgs = new Map<string, PortraitSet>([[a.id, ps("img-a", "/media/voices/joe-rogan-660.webp")], [b.id, ps("img-b", "/media/voices/dana-white-900.webp")], [c.id, ps("img-c", "/media/voices/daniel-cormier-660.webp")]]);
  const espnStyle = new Map<string, PortraitSet>([[a.id, ps("img-a", "/media/voices/joe-rogan-660.webp")], [b.id, { ...ps("espn:1", "/brand/mark.svg"), kind: "display_fallback", stored_first_party: false }]]);
  /* Fixture videos: real public uploads from the official UFC channel (ids only, embedded on click). */
  const vid = (id: string, title: string, type: string, hoursAgo: number, event_id: string | null = event.id): OfficialVideoRow => ({ id: `v-${id}`, provider: "youtube", provider_video_id: id, channel_id: "UCvgfXK4nTYKudb0rFR6noLA", channel_name: "UFC", channel_verified_source: true, url: `https://www.youtube.com/watch?v=${id}`, title, description: null, published_at: new Date(Date.now() - hoursAgo * 3600e3).toISOString(), duration_sec: null, thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, embeddable: true, video_type: type, fighter_ids: [], event_id, bout_id: null, article_id: null });
  const videos = [
    vid("cs-T1Qgb-sk", "Noche UFC: Silva vs Delgado - September 12th | Fight Promo", "fight_preview", 3),
    vid("XCNaLgqYJ8E", "UFC Paris: Post-Fight Press Conference", "post_fight", 26),
    vid("NJPZ53NvBNM", "Joshua Van vs Tatsuro Taira | FULL FIGHT | Crypto.com UFC 331", "full_fight", 40),
    vid("lyCaScONJNs", "Salahdine Parnasse Octagon Interview | UFC Paris", "interview", 30),
    vid("OraJxNt3BdM", "Greatest Mexican Fighters Of All Time | Noche UFC", "highlights", 50),
  ];
  const champs = [a, b, c, dd].map((f, i) => ({ ...f, id: `c-${i}`, name: ["Alpha Silva", "Bravo Kane", "Charlie Ortega", "Delta Moreno"][i] }));
  const rankings: RankingsSnapshot = {
    captured_at: new Date().toISOString(), snapshot_date: new Date().toISOString().slice(0, 10), source_url: "https://www.ufc.com/rankings",
    divisions: ["Heavyweight", "Light Heavyweight", "Middleweight", "Welterweight"].map((label, i) => ({
      key: label.toUpperCase().replace(" ", "_"), label, is_womens: false, is_p4p: false,
      champion: { name: champs[i].name, ufc_slug: null, fighter_id: champs[i].id },
      entries: [1, 2, 3].map((rank) => ({ rank, name: `Contender ${rank}`, ufc_slug: null, fighter_id: null, change: 0, is_new: false })),
    })),
  };
  const dwcsNext: Event = { ...event, id: "dw-1", name: "Dana White's Contender Series Season 10 Week 6", event_date: "2026-09-15", is_ppv: false, venue: "UFC Apex", city: "Las Vegas" };
  const dwcsLast: Event = { ...dwcsNext, id: "dw-0", name: "Dana White's Contender Series Season 10 Week 5", event_date: "2026-09-08", card_status: "complete" };
  const mains = new Map<string, Bout>([["dw-1", bout("db-1", e1, f1, 1, { event_id: "dw-1" })], ["dw-0", bout("db-0", c, dd, 1, { event_id: "dw-0", result: { bout_id: "db-0", winner_id: c.id, method: "KO_TKO", method_raw: "KO", round: 2, time_sec: 143, time_format: null, referee: null, finish_detail: null, result_source: "espn", has_stats: false, scorecards: null, judge_1: null, judge_2: null, judge_3: null } })]]);
  return (
    <div className="wrap page">
      <div className="eyebrow mb-4">QA fixtures · synthetic names · development only</div>
      <section id="qa-pregame" className="mb-7"><PregameDesk event={event} briefs={briefs} imgs={fixtureImgs} /></section>
      <section id="qa-pregame-single" className="mb-7"><PregameDesk event={event} briefs={briefs.slice(0, 1)} imgs={espnStyle} compact /></section>
      <section id="qa-pregame-fallback" className="mb-7"><PregameDesk event={event} briefs={briefs.slice(0, 1)} compact /></section>
      <section id="qa-video-desk" className="mb-7"><VideoRail variant="desk" videos={videos} title="Inside fight week" eyebrow="Video desk · latest official video" /></section>
      <section id="qa-video-timeline" className="mb-7"><VideoRail variant="timeline" videos={videos} title="Fight-week video" eyebrow="Official channels · event relevance first" /></section>
      <section id="qa-video-rail" className="mb-7"><VideoRail videos={videos.slice(0, 3)} title="Alpha Silva · official video" eyebrow="Official channels · attached by fighter identity" max={3} /></section>
      <section id="qa-champions" className="mb-7"><ChampionsShowcase rankings={rankings} fighters={new Map(champs.map((f) => [f.id, f]))} imgs={new Map()} /></section>
      <section id="qa-dwcs" className="mb-7"><ContenderStrip next={dwcsNext} last={dwcsLast} mains={mains} counts={new Map([["dw-1", 5], ["dw-0", 5]])} freshness={new Date().toISOString()} /></section>
      <section id="qa-belts" className="mb-7" style={{ display: "flex", gap: 40, alignItems: "end", flexWrap: "wrap" }}><ChampionshipBelt size="hero" label="Hero" /><ChampionshipBelt size="card" label="Card" /><ChampionshipBelt size="mini" label="Mini" /></section>
    </div>
  );
}
