import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, JsonLd } from "@/components/ui";
import { eventSlug, fighterSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";
import {
  allBouts,
  countsTowardsRecord,
  linkFighters,
  linkedFinale,
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

const CLASS_LABEL: Record<TufBout["classification"], string> = {
  professional: "Professional",
  exhibition: "Exhibition",
  unverified: "Unverified",
};

function Name({ name, linked }: { name: string; linked: Map<string, LinkedFighter> }) {
  const f = linked.get(name);
  if (!f) return <span className="tuf-name">{name}</span>;
  return (
    <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(f)}`}>
      {name}
    </Link>
  );
}

function BoutRow({ b, linked }: { b: TufBout; linked: Map<string, LinkedFighter> }) {
  const pro = countsTowardsRecord(b);
  return (
    <li className={`tuf-bout${pro ? " is-pro" : ""}`}>
      <span className="tuf-bout-names">
        <Name name={b.a} linked={linked} />
        <em>vs</em>
        <Name name={b.b} linked={linked} />
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
        {b.episode ? <span className="tuf-ep">Episode {b.episode}</span> : null}
      </span>
      {(b.replacement || b.tournament_deciding) && (
        <span className="tuf-bout-note">
          {b.tournament_deciding ? <b>Tournament-deciding bout. </b> : null}
          {b.replacement}
        </span>
      )}
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
    ...(season.teams ?? []).flatMap((t) => t.roster.map((r) => r.name)),
    ...(season.coaches_full ?? []).map((c) => c.name),
    ...season.coaches,
    ...season.winners.map((w) => w.fighter),
  ];
  const [linked, finale] = await Promise.all([linkFighters(names), linkedFinale(season.finale_event, season.finale_date)]);

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
              {(season.coaches_full ?? season.coaches.map((name) => ({ name, team: "", role: "head" }))).map((c, i) => (
                <li key={`${c.name}-${i}`} className={c.role === "head" ? "is-head" : ""}>
                  <Name name={c.name} linked={linked} />
                  {c.team ? <small>{c.team}{c.role !== "head" ? " · assistant" : ""}</small> : null}
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
                  <Name name={c.fighter} linked={linked} />
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
                  <Name name={w.fighter} linked={linked} />
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
                    <li key={r.name}>
                      <Name name={r.name} linked={linked} />
                      {r.country ? <small>{r.country}</small> : null}
                      {r.note ? <em>{r.note}</em> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ---- bracket ---- */}
      {season.bracket?.length ? (
        <section className="wrap tuf-section">
          <div className="tuf-section-head">
            <h2>Tournament</h2>
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
                        <BoutRow key={`${b.a}-${b.b}-${i}`} b={b} linked={linked} />
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
