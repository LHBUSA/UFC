import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, JsonLd, Avatar } from "@/components/ui";
import { eventSlug, fighterSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";
import type { PortraitSet } from "@/lib/db";
import {
  allBouts,
  countsTowardsRecord,
  linkSeasonNames,
  linkedFinale,
  portraitsFor,
  seasonBySlug,
  seasons,
  type LinkedFighter,
  type SeasonDetail,
  type TufBout,
} from "@/lib/tuf";

/* /tuf/[slug] — one season.
 *
 * The bracket is the season; the finale card is the database's. This page
 * joins them and copies neither, so the professional result at the end of the
 * tournament exists once, in ufc_bouts, and is linked to rather than restated
 * with slightly different wording. */
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return seasons().map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const s = seasonBySlug(slug);
  if (!s) return { title: { absolute: "Not found | PropBetEdge UFC" } };
  const champs = s.winners.map((w) => w.fighter).join(", ");
  const title = `${s.name} | PropBetEdge UFC`;
  const description = s.season_state === "ongoing"
    ? `${s.name}: coaches ${s.coaches.join(" and ")}, ${s.weight_classes.join(" and ")}. Season in progress.`
    : `${s.name}: coaches ${s.coaches.join(" and ") || "rotating"}, ${s.weight_classes.join(" and ")}${champs ? `, won by ${champs}` : ""}.`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/tuf/${s.slug}` },
    openGraph: { title, description, type: "website", url: `${SITE.url}/tuf/${s.slug}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

const STAFF_ORDER: Record<string, number> = { head: 0, assistant: 1, guest: 2, other: 3 };
const STAFF_LABEL: Record<string, string> = { head: "head coach", assistant: "assistant coach", guest: "guest coach", other: "staff" };

const CLASS_LABEL: Record<TufBout["classification"], string> = {
  professional: "Professional",
  exhibition: "Exhibition",
  unverified: "Unverified",
};

/* A name, with its canonical portrait when one exists. The fallback is the
 * shared Avatar's initials treatment rather than a grey box or a stand-in
 * face — a wrong face is worse than no face. */
function Name({
  name,
  linked,
  faces,
  size = 0,
}: {
  name: string;
  linked: Map<string, LinkedFighter>;
  faces?: Map<string, PortraitSet>;
  size?: number;
}) {
  const f = linked.get(name);
  const img = faces?.get(name) ?? null;
  const label = f ? (
    <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(f)}`}>
      {name}
    </Link>
  ) : (
    <span className="tuf-name">{name}</span>
  );
  if (!size) return label;
  return (
    <span className="tuf-person">
      <Avatar f={{ name }} img={img} size={size} className="tuf-face" />
      {label}
    </span>
  );
}

function BoutRow({ b, linked, faces }: { b: TufBout; linked: Map<string, LinkedFighter>; faces?: Map<string, PortraitSet> }) {
  const pro = countsTowardsRecord(b);
  return (
    <li className={`tuf-bout${pro ? " is-pro" : ""}`}>
      <span className="tuf-bout-names">
        <Name name={b.a} linked={linked} faces={faces} size={28} />
        <em>vs</em>
        <Name name={b.b} linked={linked} faces={faces} size={28} />
      </span>
      <span className="tuf-bout-meta">
        {b.winner ? (
          <span className="tuf-res">
            <b>{b.winner}</b>
            {b.method ? ` · ${b.method}` : ""}
            {b.round ? ` · R${b.round}` : ""}
            {b.time ? ` ${b.time}` : ""}
          </span>
        ) : (
          <span className="tuf-res tuf-none">Result unavailable</span>
        )}
        <span className={`tuf-class tuf-class-${b.classification}`}>{CLASS_LABEL[b.classification]}</span>
        {/* Season 21 was scored rather than bracketed, and what a win was worth
          * rose through the season. Without the number the twelve bouts look
          * like an unordered list; with it they read as the standings they
          * were. No other season carries points, so no other season shows one. */}
        {typeof b.points === "number" ? <span className="tuf-ep">{b.points} pts</span> : null}
        {b.episode ? <span className="tuf-ep">Episode {b.episode}</span> : null}
      </span>
      {(b.replacement || b.tournament_deciding || b.wildcard || b.result_note) && (
        <span className="tuf-bout-note">
          {b.tournament_deciding ? <b>Tournament-deciding bout. </b> : null}
          {b.wildcard ? <b>Wild Card bout. </b> : null}
          {b.result_note ? `${b.result_note} ` : null}
          {b.replacement}
        </span>
      )}
      {b.sources?.length ? (
        <span className="tuf-bout-src">
          {b.sources.map((src) => (
            <a key={src.repair} href={src.url} rel="nofollow noopener" target="_blank">
              Corrected from UFC.com
            </a>
          ))}
        </span>
      ) : null}
    </li>
  );
}

export default async function TufSeason({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = seasonBySlug(slug);
  if (!s) notFound();
  const season = s as SeasonDetail;

  const bouts = allBouts(season);
  const names = [
    ...bouts.flatMap((b) => [b.a, b.b]),
    ...(season.bracket ?? []).flatMap((wc) => wc.stages.flatMap((st) => (st.disputed ?? []).flatMap((b) => [b.a, b.b]))),
    ...(season.teams ?? []).flatMap((t) => t.roster.map((r) => r.name)),
    ...(season.coaches_full ?? []).map((c) => c.name),
    ...season.coaches,
    ...season.winners.map((w) => w.fighter),
    ...(season.champions ?? []).map((c) => c.fighter),
    ...(season.final_bouts ?? []).flatMap((f) => [f.a, f.b]),
  ];
  const [linked, finale] = await Promise.all([linkSeasonNames(season.slug, names), linkedFinale(season.finale_event, season.finale_date)]);
  const faces = await portraitsFor(linked);

  const proCount = bouts.filter(countsTowardsRecord).length;
  const exCount = bouts.length - proCount;

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow={`Season ${season.number} · ${season.year}`}
            title={season.name}
            lede={
              season.season_state === "ongoing"
                ? "This season is still airing. No tournament winner exists yet, and none is shown."
                : season.coaches.length
                  ? `${season.coaches.join(" against ")}, ${season.weight_classes.join(" and ").toLowerCase()}.`
                  : season.coaches_note || ""
            }
            crumbs={[{ name: "The Ultimate Fighter", href: "/tuf" }, { name: `Season ${season.number}` }]}
          />
        </div>
      </div>

      {/* ---- hero: coaches and champions ---- */}
      <section className="wrap tuf-hero">
        <div className="tuf-hero-side">
          <h2>Coaches</h2>
          {season.coaches.length ? (
            <ul className="tuf-people">
              {(season.coaches_full?.length ? season.coaches_full : season.coaches.map((name) => ({ name, team: null, role: "head" as const })))
                /* Head coaches first, then the staff who coached, then the
                 * rest; a nutritionist is not listed as a coach. */
                .filter((c) => c.role !== "other")
                .sort((x, y) => STAFF_ORDER[x.role] - STAFF_ORDER[y.role])
                .map((c, i) => (
                  <li key={`${c.name}-${i}`} className={c.role === "head" ? "is-head" : ""}>
                    <Name name={c.name} linked={linked} faces={faces} size={c.role === "head" ? 56 : 34} />
                    <small>
                      {[c.team, STAFF_LABEL[c.role], "discipline" in c ? c.discipline : null].filter(Boolean).join(" · ")}
                    </small>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="tuf-none">{season.coaches_note || "Coaches unrecorded for this season."}</p>
          )}
        </div>
        <div className="tuf-hero-side">
          <h2>Champions</h2>
          {season.season_state === "ongoing" ? (
            <p className="tuf-none">The season has not finished. A winner will appear when one exists.</p>
          ) : season.champions?.length ? (
            <ul className="tuf-people">
              {season.champions.map((c) => (
                <li key={c.weight_class} className="is-head">
                  <Name name={c.fighter} linked={linked} faces={faces} size={56} />
                  <small>
                    {c.weight_class}
                    {c.won_tournament ? " · won the tournament" : ""}
                    {c.received_title ? ` · ${c.received_title}` : c.received_contract ? " · awarded a UFC contract" : " · contract not recorded"}
                  </small>
                </li>
              ))}
            </ul>
          ) : season.winners.length ? (
            <ul className="tuf-people">
              {season.winners.map((w) => (
                <li key={w.weight_class} className="is-head">
                  <Name name={w.fighter} linked={linked} faces={faces} size={56} />
                  <small>{w.weight_class}</small>
                </li>
              ))}
            </ul>
          ) : season.finalists?.length ? (
            <div>
              <p className="tuf-none">Winner unverified — sources disagree. Finalists:</p>
              <ul className="tuf-people">
                {season.finalists.map((f) => (
                  <li key={f.weight_class}>
                    {f.fighters.join(" vs ")}
                    <small>{f.weight_class}</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="tuf-none">No winner recorded for this season.</p>
          )}
          {season.winner_note ? <p className="tuf-fine">{season.winner_note}</p> : null}
        </div>
      </section>

      {/* ---- finale card, linked not copied ---- */}
      <section className="wrap tuf-section">
        <div className="tuf-section-head">
          <h2>Finale</h2>
        </div>
        {finale ? (
          <p className="tuf-linkcard">
            <Link href={`/events/${eventSlug(finale)}`}>
              <b>{finale.name}</b>
              <span>{finale.event_date}</span>
            </Link>
            <small>
              Read from our own event records. The card&rsquo;s bouts are not restated here — there is one copy of every
              professional result and it lives on the event page.
            </small>
          </p>
        ) : season.unresolved_finale ? (
          <p className="tuf-none">
            <b>Finale not linked.</b> {season.unresolved_finale.why_wrong ? `${season.unresolved_finale.why_wrong} ` : ""}
            {season.unresolved_finale.blocker}
            {season.unresolved_finale.candidate_card ? ` Candidate card: ${season.unresolved_finale.candidate_card}.` : ""}
          </p>
        ) : season.finale_event ? (
          <p className="tuf-none">
            <b>{season.finale_event}</b>
            {season.finale_date ? ` · ${season.finale_date}` : ""} — the card is not loaded into our database yet, so it is
            named rather than linked. Nothing is invented in the meantime.
          </p>
        ) : (
          <p className="tuf-none">No finale card recorded for this season.</p>
        )}
      </section>

      {season.final_bouts?.length ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head">
            <h2>Tournament finals</h2>
            <p>Each verified by the exact finalist-versus-finalist bout in our own records — not by a champion appearing
              somewhere on a card, which is not evidence and once linked two seasons to the wrong night.</p>
          </div>
          <ul className="tuf-bouts">
            {season.final_bouts.map((f, i) => (
              <li className="tuf-bout is-pro" key={`f-${i}`}>
                <span className="tuf-bout-names">
                  <Name name={f.a} linked={linked} />
                  <em>vs</em>
                  <Name name={f.b} linked={linked} />
                </span>
                <span className="tuf-bout-meta">
                  <span className="tuf-res">
                    {f.winner ? <b>{f.winner}</b> : null}
                    {f.method ? ` · ${f.method}` : ""}
                    {f.round ? ` · R${f.round}` : ""}
                  </span>
                  <span className="tuf-class tuf-class-professional">{f.weight_class}</span>
                  <span className="tuf-ep">{f.event} · {f.date}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- teams ---- */}
      {season.teams?.length ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head">
            <h2>Teams</h2>
            <p>Contestants link to their canonical profile where one exists. A name that does not link never fought under
              our records — it is not a second profile.</p>
          </div>
          <div className="tuf-teams">
            {season.teams.map((t) => (
              <div className="tuf-team" key={t.name}>
                <h3>
                  {t.name}
                  {t.region ? <small>{t.region}</small> : null}
                </h3>
                <ul>
                  {t.roster.map((r) => (
                    <li key={r.name} className={r.status === "withdrawn" ? "is-withdrawn" : ""}>
                      <Name name={r.name} linked={linked} faces={faces} size={34} />
                      {r.country || r.pick || r.status ? (
                        <small>
                          {[
                            r.pick ? `Pick ${r.pick}` : null,
                            r.country,
                            r.status === "withdrawn" ? "Withdrew" : r.status === "replacement" ? "Replacement" : null,
                          ].filter(Boolean).join(" · ")}
                        </small>
                      ) : null}
                      {r.note ? <em>{r.note}</em> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ---- team competition (a season decided on points, not a bracket) ---- */}
      {season.team_competition ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head">
            <h2>Team competition</h2>
            <p>{season.team_competition.note}</p>
          </div>

          {season.team_competition.standings?.length ? (
            <div className="tuf-standings">
              {season.team_competition.standings.map((row, i) => (
                <div className={`tuf-standing${i === 0 ? " is-winner" : ""}`} key={row.team}>
                  <span className="tuf-standing-team">{row.team}</span>
                  <span className="tuf-standing-pts">{row.points ?? "—"} pts</span>
                  <span className="tuf-standing-wins">{row.wins ?? "—"} wins</span>
                </div>
              ))}
            </div>
          ) : null}

          {season.team_competition.concluding_bout ? (
            <div className="tuf-concluding">
              <h3>Concluding bout</h3>
              <p className="tuf-concluding-note">{season.team_competition.concluding_bout.note}</p>
              <div className="tuf-concluding-bout">
                <span className="tuf-concluding-names">
                  <b>{season.team_competition.concluding_bout.winner}</b>
                  {" def. "}
                  {season.team_competition.concluding_bout.winner === season.team_competition.concluding_bout.a
                    ? season.team_competition.concluding_bout.b
                    : season.team_competition.concluding_bout.a}
                </span>
                <span className="tuf-concluding-meta">
                  {[
                    season.team_competition.concluding_bout.method,
                    season.team_competition.concluding_bout.round ? `R${season.team_competition.concluding_bout.round}` : null,
                    season.team_competition.concluding_bout.weight_class,
                  ].filter(Boolean).join(" · ")}
                </span>
                <span className="tuf-concluding-event">
                  {season.team_competition.concluding_bout.event}
                  {season.team_competition.concluding_bout.date ? ` · ${season.team_competition.concluding_bout.date}` : ""}
                </span>
                {season.team_competition.concluding_bout.verified_against ? (
                  <span className="tuf-concluding-verified">
                    Verified against {season.team_competition.concluding_bout.verified_against}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ---- bracket ---- */}
      {season.bracket?.length ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head">
            <h2>{season.team_competition ? "Series results" : "Tournament"}</h2>
            <p>
              {proCount} professional · {exCount} exhibition or unverified. House bouts are unsanctioned and are excluded
              from professional records and every professional stat aggregate.
            </p>
          </div>
          {season.bracket.map((wc) => (
            <div className="tuf-bracket" key={wc.weight_class}>
              <h3>{wc.weight_class}</h3>
              {wc.stages.map((st) => (
                <div className="tuf-stage" key={st.stage}>
                  <div className="tuf-stage-head">
                    <h4>{st.label}</h4>
                    {st.status === "unverified" ? <span className="tuf-pill tuf-pill-thin">Unverified</span> : null}
                  </div>
                  {st.note ? <p className="tuf-fine">{st.note}</p> : null}
                  {st.bouts.length ? (
                    <ul className="tuf-bouts">
                      {st.bouts.map((b, i) => (
                        <BoutRow key={`${b.a}-${b.b}-${i}`} b={b} linked={linked} faces={faces} />
                      ))}
                    </ul>
                  ) : (
                    <p className="tuf-none">Not recorded. Nothing is reconstructed for this round.</p>
                  )}
                  {st.disputed?.length ? (
                    <div className="tuf-disputed">
                      <h5>Listed by a source but not reconciled</h5>
                      <ul className="tuf-bouts">
                        {st.disputed.map((b, i) => (
                          <li key={`d-${i}`} className="tuf-bout is-disputed">
                            <span className="tuf-bout-names">
                              <Name name={b.a} linked={linked} />
                              <em>vs</em>
                              <Name name={b.b} linked={linked} />
                            </span>
                            <span className="tuf-bout-meta">
                              <span className="tuf-class tuf-class-unverified">Not counted</span>
                            </span>
                            <span className="tuf-bout-note">{b.dispute}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : (
        <section className="wrap tuf-section">
          <div className="tuf-section-head"><h2>Tournament</h2></div>
          <p className="tuf-none">
            The bracket for this season has not been loaded. Season metadata, coaches and champions above are sourced;
            the round-by-round tournament is not yet in the archive.
          </p>
        </section>
      )}

      {/* ---- provenance ---- */}
      <section className="wrap tuf-section">
        {season._conflicts?.length ? (
          <div className="tuf-conflicts">
            <h2>Where sources disagree</h2>
            {season._conflicts.map((c, i) => (
              <p key={i}>
                <b>{c.field}</b> — {c.detail}
              </p>
            ))}
          </div>
        ) : null}
        {season._provenance ? (
          <p className="tuf-note">
            Season data from <a href={season._provenance.primary} rel="nofollow noopener" target="_blank">the season record</a>,
            retrieved {season._provenance.retrieved}. {season._provenance.note}
          </p>
        ) : null}
      </section>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "TVSeason",
          name: season.name,
          seasonNumber: season.number,
          datePublished: String(season.year),
          partOfSeries: { "@type": "TVSeries", name: "The Ultimate Fighter" },
          url: `${SITE.url}/tuf/${season.slug}`,
        }}
      />
    </>
  );
}
