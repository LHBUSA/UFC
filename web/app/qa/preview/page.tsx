import { notFound } from "next/navigation";
import type { Bout, Event, Fighter, RankingsSnapshot, PortraitSet, OfficialVideoRow } from "@/lib/db";
import { VideoRail } from "@/components/VideoRail";
import { buildDeskBriefs } from "@/lib/pregame";
import { PregameDesk } from "@/components/PregameDesk";
import { ChampionsShowcase } from "@/components/ChampionsShowcase";
import { ContenderStrip } from "@/components/ContenderStrip";
import { ChampionshipBelt } from "@/components/ChampionshipBelt";
import { FightWeekPage } from "@/components/FightWeek";
import { assemblePacket } from "@/lib/fightweek";
import { eventSlug } from "@/lib/slug";
import { OfficialVideoModule, type ContentPlan } from "@/components/plan";
import { TrainingCorner, NewCampNote } from "@/components/TrainingCorner";
import { trainingPayload, type StintRow } from "@/lib/training";

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
  const bouts = [bout("b-1", a, b, 1, { is_title: true, scheduled_rounds: 5, card_position: "main" }), bout("b-2", c, dd, 2, { weight_class: "WELTERWEIGHT", card_position: "main" }), bout("b-3", e1, f1, 3, { weight_class: "FEATHERWEIGHT", card_position: "prelim" })];
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
    /* Fixture for the embed fallback: the ingest recorded a US region block, so the card renders poster + message + Watch on YouTube instead of a player. */
    { ...vid("cs-T1Qgb-sk", "Noche UFC: Silva vs Delgado | Region-restricted fixture", "fight_preview", 5), id: "v-blocked", source_metadata: { language: "en", region_restriction: { blocked: ["US"] } } },
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
  const mains = new Map<string, Bout>([["dw-1", bout("db-1", e1, f1, 1, { event_id: "dw-1" })], ["dw-0", bout("db-0", c, dd, 1, { event_id: "dw-0", result: { bout_id: "db-0", winner_id: c.id, method: "KO_TKO", method_raw: "KO", round: 2, time_sec: 143, time_format: null, referee: null, finish_detail: null, result_source: "espn", has_stats: false, scorecards: null, judge_1: null, judge_2: null, judge_3: null, source_url: null } })]]);
  const packet = assemblePacket({ event, bouts, live: bouts, briefs, imgs: fixtureImgs, framing: new Map(), videos, done: false, roundCoverage: new Map(), updated: new Date().toISOString(), rankingsDate: rankings.snapshot_date, sources: ["UFC Stats career averages (fixture)", `Official rankings snapshot ${rankings.snapshot_date} (fixture)`, "Fight DNA not available for the fixture pairing", "Archived results (fixture)", "Event card as published (fixture)"] });
  /* Content-plan video module as the Silva/Delgado story stored it BEFORE the
   * issue #19 hotfix: both UFC Brasil clips oEmbed-verified, neither
   * region-verified. XMK-nCzDxGo does not play in the U.S.; clicking it here
   * must end on the poster fallback, never a dead YouTube box. */
  const brasil = (id: string, uuid: string, title: string, published_at: string) => ({ id: uuid, url: `https://www.youtube.com/watch?v=${id}`, title, language: "pt", provider: "youtube", video_id: id, publisher: "UFC Brasil", embeddable: true, matched_on: "bout+fighter", video_type: "other", matched_tier: 2, published_at, thumbnail_url: `https://i1.ytimg.com/vi/${id}/hqdefault.jpg` });
  const planFixture: ContentPlan = { modules: [{ id: "official_video", title: "Official video", data: { tier: 2, videos: [brasil("H3CPKzY34CY", "qa-v1", "O MELHOR DE JEAN SILVA E JOSE MIGUEL DELGADO | Noche UFC", "2026-09-11T15:00:07Z"), brasil("XMK-nCzDxGo", "qa-v2", "Aquecimento Noche UFC: Silva x Delgado | Maratona de Lutas Completas", "2026-09-10T20:48:26Z")] } }] };
  /* Training & Corner fixture: a two-camp history (observed, then a cited switch), cited fighting-out-of,
   * training base and coaches, and the NEW CAMP note the chronology proves. Synthetic names and URLs. */
  const tEv = (over: Partial<StintRow["evidence"][number]>) => ({ observation_id: "o", source_key: "espn_athlete_association", source_url: "https://example.invalid/capture", certainty: "OBSERVED" as const, relationship_type: "AFFILIATION", value_raw: "", external_ref: null, captured_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-12-20T06:00:00Z", effective_from: null, source_published_at: null, ...over });
  const tStints: StintRow[] = [
    { fighter_id: "f-a", stint_no: 1, camp_id: "c1", camp_name: "Northside Combat Club", camp_slug: "northside", stint_start_at: "2026-09-26T22:00:00Z", first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-12-20T06:00:00Z", joined_on: null, certainty: "OBSERVED", next_stint_start_at: "2027-01-15T00:00:00Z", next_first_observed_at: "2027-01-20T06:00:00Z", left_on: null, is_current: false, evidence: [tEv({})] },
    { fighter_id: "f-a", stint_no: 2, camp_id: "c2", camp_name: "Harbor Fight Team", camp_slug: "harbor", stint_start_at: "2027-01-15T00:00:00Z", first_observed_at: "2027-01-20T06:00:00Z", last_confirmed_at: "2027-03-01T06:00:00Z", joined_on: "2027-01-15", certainty: "STATED", next_stint_start_at: null, next_first_observed_at: null, left_on: null, is_current: true, evidence: [tEv({ source_key: "ufc_training_manual", source_url: "https://example.invalid/announcement", certainty: "STATED", captured_at: "2027-01-20T06:00:00Z" })] },
  ];
  const tChanges = [
    { id: "x1", kind: "AFFILIATION_CHANGED_OBSERVED" as const, previous_value: "Northside Combat Club", new_value: "Harbor Fight Team", previous_camp_id: "c1", new_camp_id: "c2", supersedes_event_id: null, effective_on: null, observed_at: "2027-01-20T06:00:00Z", source_url: "https://example.invalid/capture" },
    { id: "x2", kind: "CAMP_CHANGED_CONFIRMED" as const, previous_value: "Northside Combat Club", new_value: "Harbor Fight Team", previous_camp_id: "c1", new_camp_id: "c2", supersedes_event_id: "x1", effective_on: "2027-01-15", observed_at: "2027-01-22T06:00:00Z", source_url: "https://example.invalid/announcement" },
  ];
  const tPlace = (city: string, region: string) => ({ city, region, country: "USA", value_raw: `${city}, ${region}`, certainty: "STATED" as const, source_key: "ufc_training_manual", source_url: "https://example.invalid/profile", captured_at: "2027-01-22T06:00:00Z", source_published_at: null });
  const trainingFull = trainingPayload({
    current: { fighter_id: "f-a", current_camp: { camp_id: "c2", name: "Harbor Fight Team", slug: "harbor", first_observed_at: "2027-01-20T06:00:00Z", last_confirmed_at: "2027-03-01T06:00:00Z", joined_on: "2027-01-15", certainty: "STATED", evidence: tStints[1].evidence },
      fighting_out_of: tPlace("Miami", "Florida"), training_location: { ...tPlace("Deerfield Beach", "Florida"), camp_id: "c2", camp_name: "Harbor Fight Team" },
      coaches: [{ coach_id: "k1", name: "Sam Hollis", slug: "sam-hollis", role: "STRIKING", since: "2027-01-15", certainty: "STATED", source_key: "ufc_training_manual", source_url: "https://example.invalid/staff", captured_at: "2027-01-22T06:00:00Z" },
        { coach_id: "k2", name: "Rae Duarte", slug: "rae-duarte", role: "WRESTLING", since: null, certainty: "STATED", source_key: "ufc_training_manual", source_url: "https://example.invalid/staff", captured_at: "2027-01-22T06:00:00Z" }],
      other_camps: [], updated_at: "2027-03-01T06:00:00Z" },
    stints: tStints, changes: tChanges, lastBoutDate: "2026-12-13",
  });
  const trainingReported = trainingPayload({ current: { fighter_id: "f-c", current_camp: { camp_id: "c4", name: "Team Nogueira", slug: "team-nogueira", first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-09-27T06:00:00Z", joined_on: null, certainty: "OBSERVED", evidence: [tEv({})] }, fighting_out_of: null, training_location: null, coaches: [], other_camps: [], updated_at: "2026-09-27T06:00:00Z" },
    stints: [{ ...tStints[0], fighter_id: "f-c", camp_id: "c4", camp_name: "Team Nogueira", is_current: true }],
    changes: [{ id: "rm1", kind: "CAMP_MOVE_REPORTED", previous_value: null, new_value: "American Top Team", previous_camp_id: null, new_camp_id: "c9", supersedes_event_id: null, effective_on: null, observed_at: "2026-09-27T00:10:00Z", source_url: "https://example.invalid/report", exact_date_known: false, source_published_at: "2026-03-08T00:00:00Z" }], lastBoutDate: null });
  const trainingEspnOnly = trainingPayload({ current: { fighter_id: "f-b", current_camp: { camp_id: "c3", name: "Kill Cliff FC", slug: "kill-cliff-fc", first_observed_at: "2026-09-26T22:00:00Z", last_confirmed_at: "2026-09-26T22:00:00Z", joined_on: null, certainty: "OBSERVED", evidence: [tEv({})] }, fighting_out_of: null, training_location: null, coaches: [], other_camps: [], updated_at: "2026-09-26T22:00:00Z" },
    stints: [{ ...tStints[0], fighter_id: "f-b", camp_id: "c3", camp_name: "Kill Cliff FC", is_current: true }], changes: [], lastBoutDate: null });

  return (
    <div className="wrap page">
      <div className="eyebrow mb-4">QA fixtures · synthetic names · development only</div>
      <section id="qa-fight-week" className="mb-7"><FightWeekPage packet={packet} archive={false} /></section>
      <section id="qa-fw-teaser" className="mb-7"><PregameDesk event={event} briefs={briefs} imgs={fixtureImgs} mode="teaser" meta={{ fights: bouts.length, updated: new Date().toISOString() }} /></section>
      <section id="qa-fw-cta" className="mb-7"><PregameDesk event={event} briefs={briefs} imgs={fixtureImgs} mode="cta" meta={{ fights: bouts.length, updated: new Date().toISOString(), href: `/pregame/${eventSlug(event)}`, hub: true }} /></section>
      <section id="qa-pregame" className="mb-7"><PregameDesk event={event} briefs={briefs} imgs={fixtureImgs} /></section>
      <section id="qa-pregame-single" className="mb-7"><PregameDesk event={event} briefs={briefs.slice(0, 1)} imgs={espnStyle} compact /></section>
      <section id="qa-pregame-fallback" className="mb-7"><PregameDesk event={event} briefs={briefs.slice(0, 1)} compact /></section>
      <section id="qa-video-desk" className="mb-7"><VideoRail variant="desk" videos={videos} title="Inside fight week" eyebrow="Video desk · latest official video" /></section>
      <section id="qa-video-timeline" className="mb-7"><VideoRail variant="timeline" videos={videos} title="Fight-week video" eyebrow="Official channels · event relevance first" /></section>
      <section id="qa-video-rail" className="mb-7"><VideoRail videos={videos.slice(0, 3)} title="Alpha Silva · official video" eyebrow="Official channels · attached by fighter identity" max={3} /></section>
      <section id="qa-plan-video" className="mb-7" style={{ maxWidth: 760 }}><OfficialVideoModule plan={planFixture} /></section>
      <section id="qa-champions" className="mb-7"><ChampionsShowcase rankings={rankings} fighters={new Map(champs.map((f) => [f.id, f]))} imgs={new Map()} /></section>
      <section id="qa-dwcs" className="mb-7"><ContenderStrip next={dwcsNext} last={dwcsLast} mains={mains} counts={new Map([["dw-1", 5], ["dw-0", 5]])} reported={new Map()} freshness={new Date().toISOString()} /></section>
      <div id="qa-training-full" className="mb-7"><TrainingCorner training={trainingFull} fighterName="Alpha Silva" /><NewCampNote note={trainingFull.new_camp_since_last_bout} fighterName="Alpha Silva" /></div>
      <div id="qa-training-espn-only" className="mb-7"><TrainingCorner training={trainingEspnOnly} fighterName="Bravo Kane" /></div>
      <div id="qa-training-reported" className="mb-7"><TrainingCorner training={trainingReported} fighterName="Charlie Ortega" /></div>
      <section id="qa-belts" className="mb-7" style={{ display: "flex", gap: 40, alignItems: "end", flexWrap: "wrap" }}><ChampionshipBelt size="hero" label="Hero" /><ChampionshipBelt size="card" label="Card" /><ChampionshipBelt size="mini" label="Mini" /></section>
    </div>
  );
}
