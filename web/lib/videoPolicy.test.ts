/* Video availability policy. Run: npm run test:story-media
 *
 * GitHub issue #19: UFC Brasil's XMK-nCzDxGo answered oEmbed with HTTP 200,
 * was stored embeddable=true, and rendered as a dead YouTube box for U.S.
 * readers. oEmbed 200 is not proof of regional playability. */
import test from "node:test";
import assert from "node:assert/strict";
import { videoPlayability, regionBlocked, isViewable, renderablePlanVideos, railInitialSelection, type PlanVideo, type LiveVideoState } from "./videoPolicy.ts";

const oembedOnly = { discovery: "atom_feed", region_restriction: null, embed_check: { method: "oembed", status: 200 } };

/* The two clips on the live Silva/Delgado content plan, as stored. */
const good: PlanVideo = { id: "2eac84c2", video_id: "H3CPKzY34CY", url: "https://www.youtube.com/watch?v=H3CPKzY34CY", title: "O MELHOR DE JEAN SILVA E JOSE MIGUEL DELGADO | Noche UFC", publisher: "UFC Brasil", language: "pt", embeddable: true, video_type: "other", matched_tier: 2, matched_on: "bout+fighter" };
const blockedCopy: PlanVideo = { id: "5824fbd8", video_id: "XMK-nCzDxGo", url: "https://www.youtube.com/watch?v=XMK-nCzDxGo", title: "Aquecimento Noche UFC: Silva x Delgado | Maratona de Lutas Completas", publisher: "UFC Brasil", language: "pt", embeddable: true, video_type: "other", matched_tier: 2, matched_on: "bout+fighter" };
const live = (id: string, over: Partial<LiveVideoState> = {}): [string, LiveVideoState] => [id, { provider_video_id: id, embeddable: true, link_status: "published", channel_name: "UFC Brasil", source_metadata: oembedOnly, ...over }];

test("oEmbed 200 alone is 'unverified', never 'playable'", () => {
  assert.equal(videoPlayability({ embeddable: true, source_metadata: oembedOnly }), "unverified");
});

test("Data API region answer that allows the US is 'playable'", () => {
  assert.equal(videoPlayability({ embeddable: true, source_metadata: { discovery: "youtube_data_api_v3", region_restriction: null } }), "playable");
  assert.equal(videoPlayability({ embeddable: true, source_metadata: { region_check: { method: "youtube_data_api" }, region_restriction: { allowed: ["US", "BR"] } } }), "playable");
});

test("known regionRestriction excluding the US is 'blocked'", () => {
  assert.equal(videoPlayability({ embeddable: true, source_metadata: { region_check: { method: "youtube_data_api" }, region_restriction: { allowed: ["BR", "PT"] } } }), "blocked");
  assert.equal(videoPlayability({ embeddable: true, source_metadata: { region_check: { method: "youtube_data_api" }, region_restriction: { blocked: ["US"] } } }), "blocked");
});

test("a recorded observed_region_block is honoured without a Data API answer", () => {
  const sm = { ...oembedOnly, observed_region_block: { regions: ["US"], method: "player_observed" } };
  assert.equal(regionBlocked({ source_metadata: sm }), true);
  assert.equal(isViewable({ embeddable: true, source_metadata: sm }), false);
  assert.equal(videoPlayability({ embeddable: true, source_metadata: sm }), "blocked");
  assert.equal(videoPlayability({ embeddable: true, source_metadata: sm }, "BR"), "unverified");
});

test("Silva/Delgado as hot-fixed: blocked clip suppressed, good clip kept with provenance", () => {
  const hotfixedCopy = { ...blockedCopy, embeddable: false };
  const out = renderablePlanVideos([good, hotfixedCopy], new Map([live("H3CPKzY34CY"), live("XMK-nCzDxGo", { embeddable: false })]));
  assert.deepEqual(out.map((v) => v.video_id), ["H3CPKzY34CY"]);
  assert.equal(out[0].playability, "unverified");
  assert.equal(out[0].lang, "pt");
  assert.equal(out[0].publisher, "UFC Brasil");
  assert.equal(out[0].matched_tier, 2);
  assert.equal(out[0].matched_on, "bout+fighter");
});

test("live state wins over a stale plan copy: a block recorded after publication suppresses the clip", () => {
  const out = renderablePlanVideos([good, blockedCopy], new Map([live("H3CPKzY34CY"), live("XMK-nCzDxGo", { source_metadata: { ...oembedOnly, observed_region_block: { regions: ["US"] } } })]));
  assert.deepEqual(out.map((v) => v.video_id), ["H3CPKzY34CY"]);
});

test("a plan copy saying embeddable=false is never overridden by a live true", () => {
  const out = renderablePlanVideos([{ ...blockedCopy, embeddable: false }], new Map([live("XMK-nCzDxGo")]));
  assert.equal(out.length, 0);
});

test("a video rejected after publication disappears", () => {
  assert.equal(renderablePlanVideos([good], new Map([live("H3CPKzY34CY", { link_status: "rejected" })])).length, 0);
});

test("no live row: the plan copy is judged on its own, region fields included", () => {
  assert.deepEqual(renderablePlanVideos([good]).map((v) => v.playability), ["unverified"]);
  assert.equal(renderablePlanVideos([{ ...good, region_restriction: { allowed: ["BR"] } }]).length, 0);
  assert.deepEqual(renderablePlanVideos([{ ...good, region_verified: true }]).map((v) => v.playability), ["playable"]);
});

test("a copy without a provider id is never rendered", () => {
  assert.equal(renderablePlanVideos([{ ...good, video_id: undefined }]).length, 0);
});

test("legacy rail selection mirrors the rail: English-first, capped at max", () => {
  const row = (id: string, channel: string, title: string, published_at: string) => ({ id, provider: "youtube", provider_video_id: id, channel_id: "c", channel_name: channel, channel_verified_source: true, url: `https://www.youtube.com/watch?v=${id}`, title, description: null, published_at, duration_sec: null, thumbnail_url: null, embeddable: true, video_type: "highlights", fighter_ids: [], event_id: null, bout_id: null, article_id: null, source_metadata: null });
  const rows = [row("pt1", "UFC Brasil", "Melhores momentos", "2026-09-11T10:00:00Z"), row("en1", "UFC", "Highlights one", "2026-09-10T10:00:00Z"), row("en2", "UFC", "Highlights two", "2026-09-09T10:00:00Z"), row("en3", "UFC", "Highlights three", "2026-09-08T10:00:00Z")];
  assert.deepEqual(railInitialSelection(rows, 3).map((v) => v.id), ["en1", "en2", "en3"]);
});
