from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# --- ProPlans: turn a generic feature list into a PBE Picks sales surface. ---
ui = ROOT / "web/components/ui.tsx"
text = ui.read_text()
marker = "export function ProPlans("
start = text.find(marker)
if start < 0:
    raise SystemExit("ProPlans start marker not found")
if "Model probabilities, fair prices and picks stay unavailable until validated" not in text[start:]:
    raise SystemExit("Expected stale ProPlans copy is missing; refusing blind rewrite")

new_pro_plans = r'''export function ProPlans({ active = false, email = null }: { active?: boolean; email?: string | null } = {}) {
  const monthly = PRO_OFFER.plans.monthly, weekly = PRO_OFFER.plans.weekly;
  /* Prefilling the checkout with the signed-in email is what lets the
   * entitlement Stripe grants land on the account the reader is using. */
  const checkout = (url: string) => (email ? `${url}?prefilled_email=${encodeURIComponent(email)}` : url);
  return (
    <div className="plans pro-offer pro-offer-v2" id="pro">
      <div className="plan pro-free-plan">
        <div className="eyebrow dim">Free · Public proof stays public</div>
        <div className="price">$0</div>
        <p className="pro-free-lede">Follow the sport, inspect the evidence and see how PBE Algo works before paying for a call.</p>
        <ul>
          <li>Every upcoming card, main card and prelims</li>
          <li>Fighter records, physicals, fight history and public Fight DNA context</li>
          <li>Fight pages, results and factual round-by-round statistics</li>
          <li>Official rankings, official weigh-ins, newsroom and historical archives</li>
          <li>PBE Algo method, eligibility rules and aggregate model accountability</li>
        </ul>
        <div className="pro-free-actions">
          <Link href="/events" className="btn">Browse the cards</Link>
          <Link href="/algo" className="btn">See PBE Algo proof</Link>
        </div>
      </div>

      <div className="plan pro best pro-picks-plan">
        <div className="pro-picks-kicker">
          <div className="eyebrow">UFC Pro · Founding season</div>
          <span className="pro-picks-pill">PBE PICKS · PRO</span>
        </div>

        <h3 className="pro-picks-title">The model makes the call before the fight. Then it lives with the result.</h3>
        <p className="pro-picks-lede">
          PBE Algo scores every eligible UFC bout from pre-fight data, produces its own win probability and confidence, compares that probability with the fight-week market, and locks the official call before the fight. The result is graded afterward. No hindsight and no deleted losses.
        </p>

        <div className="pro-proof-row" aria-label="PBE Algo accountability">
          <div><b>LOCKED</b><span>before the fight</span></div>
          <div><b>GRADED</b><span>after the result</span></div>
          <div><b>PERMANENT</b><span>record stays on file</span></div>
        </div>

        <div className="pro-pick-lockbox" aria-label="UFC Pro model outputs">
          <div className="pro-pick-lockbox-head"><span>PBE PICKS</span><Link href="/algo">How the model works →</Link></div>
          {[
            ["PBE Pick", "The fighter the model calls"],
            ["Win probability + confidence", "Independent model probability and confidence tier"],
            ["PBE Edge", "Model probability vs the de-vigged market"],
            ["Model drivers", "The strongest factors for and against the call"],
          ].map(([label, detail]) => (
            <div className="pro-pick-lockrow" key={label}>
              <span><b>{label}</b><small>{detail}</small></span>
              <span className="pro-lock-chip">PRO</span>
            </div>
          ))}
        </div>

        <div className="pro-picks-price">
          <div className="price">{monthly.display}<small>/{monthly.cadence}</small><span className="plan-badge">{monthly.badge}</span></div>
          <div className="plan-terms">or {weekly.display}/{weekly.cadence} <span className="plan-badge alt">{weekly.badge}</span> · No free trial · Cancel anytime</div>
        </div>

        <ul className="pro-value-list">
          <li><b>PBE Picks on every eligible bout.</b> Pick, probability, confidence, data quality and no-call reason when a fight is ineligible.</li>
          <li><b>Market intelligence built around the call.</b> Consensus, best available price, de-vigged market probability, PBE Edge and movement when verified fight-week pricing exists.</li>
          <li><b>Fight DNA beneath the model.</b> Matchup DNA, round progression, stance, pace, attack distribution, grappling context and fighter tendencies.</li>
          <li><b>A learning loop with guardrails.</b> Graded fights train challenger models; the live champion never silently changes and promotion requires evidence.</li>
        </ul>

        {active ? (
          <div className="pro-cta-row">
            <Link href="/algo/card" className="btn gold">Open Current PBE Picks</Link>
            <Link href="/account" className="btn">Account</Link>
          </div>
        ) : (
          <div className="pro-cta-row">
            <a href={checkout(monthly.checkoutUrl)} className="btn gold" data-plan="monthly">Unlock PBE Picks · {monthly.display}/mo</a>
            <a href={checkout(weekly.checkoutUrl)} className="btn" data-plan="weekly">Fight Week · {weekly.display}/wk</a>
          </div>
        )}

        <div className="pro-receipt-line"><b>Every official call has a receipt.</b> Locked before the fight, graded afterward, and never backfilled from the backtest. <Link href="/algo">See the public proof →</Link></div>
        <div className="faint label mt-3">Secure checkout by Stripe. Access unlocks on your UFC account once Stripe confirms the subscription; use the same email at checkout.</div>
      </div>
    </div>
  );
}'''
ui.write_text(text[:start] + new_pro_plans + "\n")


# --- Homepage heading: make the Pro value proposition explicit. ---
home = ROOT / "web/app/page.tsx"
h = home.read_text()
h = replace_once(
    h,
    '<SectionHead eyebrow="Free vs Pro" title="Everything public is free. The edge is Pro." /><ProPlans />',
    '<SectionHead eyebrow="Free vs Pro" title="Public proof is free. PBE Picks are Pro." /><ProPlans />',
    "homepage Pro heading",
)
home.write_text(h)


# --- /pro: PBE Algo becomes the flagship, with truth-backed live proof. ---
pro = ROOT / "web/app/pro/page.tsx"
p = pro.read_text()
p = replace_once(
    p,
    'title: "UFC Pro — Fight DNA Intelligence Layer & Fight Week Access",\n  description: "PropBetEdge UFC Pro founding season: $9.99/month or $3.99/week, no free trial, cancel anytime. PBE Algo win probabilities with a locked, graded record, plus the proprietary Fight DNA intelligence layer (matchup DNA, round intelligence, fight-week desk, market movement, officials tendencies).",',
    'title: "UFC Pro — PBE Picks, UFC Predictions, Fight DNA & Market Edge",\n  description: "UFC Pro unlocks PBE Picks from the PropBetEdge fight model: independent win probabilities, confidence, PBE Edge, model drivers and a locked graded record for eligible UFC bouts, plus Fight DNA and fight-week intelligence. $9.99/month or $3.99/week.",',
    "Pro metadata",
)

page_head_pattern = re.compile(
    r'''      <PageHead\n        crumbs=\{\[\{ name: "Pro" \}\]\}\n        eyebrow="UFC Pro"\n        title="PBE Algo and Fight DNA\. Model claims only when earned\."\n        lede="UFC Pro is built around PBE Algo, Fight DNA and fight-week intelligence\. Every PBE Algo call is locked before the fight and graded after it, and nothing is shown that the model did not produce\."\n      />'''
)
new_page_head = '''      <PageHead
        crumbs={[{ name: "Pro" }]}
        eyebrow="UFC Pro · PBE Picks · Proprietary fight model"
        title="PBE Algo calls the fights. UFC Pro shows you every call."
        lede="Every eligible bout. Independent win probabilities. Confidence. PBE Edge. Fight DNA. Official calls lock before the fight and are graded afterward — with the record left intact."
      />'''
p, count = page_head_pattern.subn(new_page_head, p, count=1)
if count != 1:
    raise SystemExit(f"Pro PageHead: expected one match, found {count}")

start_section = p.find('      <section className="card hi mt-6 pro-algo"')
end_section = p.find('      <section className="pro-dna"', start_section)
if start_section < 0 or end_section < 0:
    raise SystemExit("Pro algo sales section markers not found")

new_algo_section = '''      <section className="card hi mt-6 pro-algo pro-algo-sales" aria-labelledby="pro-algo-title">
        <div className="eyebrow">UFC Pro flagship · PBE Picks · {algoIsLive ? (algoRecord.locked_predictions ? `${algoRecord.locked_predictions} official call${algoRecord.locked_predictions === 1 ? "" : "s"} locked` : "official calls active · first lock pending") : "official record begins at first lock"}</div>
        <h2 id="pro-algo-title" className="serif">The call. The probability. The edge. The receipt.</h2>
        <p className="dim sm pro-algo-sales-lede">
          PBE Algo scores every eligible UFC bout from pre-fight data only. UFC Pro gets the fighter call, win probability, confidence and data quality, fight-week consensus and best available odds, the de-vigged market probability, PBE Edge, and the model&apos;s own drivers for and against. Ineligible bouts show NO MODEL CALL with the reason instead of forcing a pick.
        </p>

        {algoRecord.locked_predictions > 0 ? (
          <div className="pro-algo-proof" aria-label="Live PBE Algo record">
            <div><b>{algoRecord.locked_predictions}</b><span>Locked calls</span></div>
            <div><b>{algoRecord.decided ? `${algoRecord.wins}-${algoRecord.losses}` : "—"}</b><span>Live record</span></div>
            <div><b>{algoRecord.hit_rate == null ? "—" : `${(Number(algoRecord.hit_rate) * 100).toFixed(1)}%`}</b><span>Hit rate</span></div>
            <div><b>{algoRecord.pending}</b><span>Awaiting result</span></div>
          </div>
        ) : (
          <div className="pro-algo-proof-empty">
            <b>THE LIVE RECORD STARTS AT THE FIRST OFFICIAL LOCK.</b>
            <span>No backtest result is borrowed into the live record, and provisional calls are not counted as official picks.</span>
          </div>
        )}

        <div className="pro-algo-receipt">
          <div><span className="eyebrow">Accountability by design</span><strong>Every official call has a receipt.</strong></div>
          <p>Locked on the database clock before the fight. Graded against the stored official result. Corrections are dated revisions; losses do not disappear. Graded fights can train challenger models, but the live champion cannot silently replace itself.</p>
        </div>

        <div className="row mt-3">
          <Link href={active ? "/algo/card" : "/algo"} className="btn gold">{active ? "Open Current PBE Picks" : "See PBE Algo proof"}</Link>
          {active ? <Link href="/algo/record" className="btn">Full track record</Link> : <Link href="#pro" className="btn">Unlock UFC Pro</Link>}
        </div>
      </section>

'''
p = p[:start_section] + new_algo_section + p[end_section:]

p = replace_once(
    p,
    '<h2 id="pro-dna-title">Go beyond the fight record.</h2>\n            <p>UFC Pro is founding access to the Fight DNA intelligence layer as it deepens, not simply more stats. Pro surfaces ship against the same evidence-backed system:</p>',
    '<h2 id="pro-dna-title">The intelligence layer beneath the call.</h2>\n            <p>PBE Picks are the decision surface. Fight DNA is the evidence-backed fighter and matchup layer underneath it — versioned context that goes far beyond a record or a raw stat dump:</p>',
    "Fight DNA hierarchy",
)
p = replace_once(
    p,
    '["Fight DNA over surface stats", "Opponent stance, pace, attack distribution, grappling context and as-of historical features are being built as a versioned intelligence layer rather than a stat dump."],',
    '["Fight DNA beneath the model", "Opponent stance, pace, attack distribution, grappling context and as-of historical features are rebuilt as versioned intelligence rather than a stat dump."],',
    "Fight DNA support card",
)
p = replace_once(
    p,
    'description: "Founding access to the PropBetEdge Fight DNA intelligence layer, Fight Week intelligence and deeper evidence packets for UFC, with model-derived claims displayed only when validated. No free trial; cancel anytime.",',
    'description: "UFC Pro unlocks PBE Picks from the PropBetEdge fight model: independent win probabilities, confidence, PBE Edge, model drivers and a locked graded record for eligible UFC bouts, plus Fight DNA and fight-week intelligence.",',
    "Product schema description",
)
pro.write_text(p)


# --- Dedicated presentation styles. ---
css = ROOT / "web/app/pro-gate.css"
c = css.read_text()
css_marker = "/* ---- UFC Pro sales v2: PBE Picks first ---- */"
if css_marker in c:
    raise SystemExit("Sales v2 CSS marker already exists")
c += r'''

/* ---- UFC Pro sales v2: PBE Picks first ---- */
.pro-offer-v2 { grid-template-columns: minmax(0, .82fr) minmax(0, 1.35fr); align-items: stretch; gap: clamp(14px, 2vw, 22px); }
.pro-offer-v2 .plan { min-width: 0; }
.pro-free-plan { background: linear-gradient(180deg, rgba(255,255,255,.018), transparent 42%), var(--pbe-ink-2); }
.pro-free-lede { color: var(--pbe-dim); font-size: var(--fs-sm); margin: 0 0 var(--s-3); max-width: 52ch; }
.pro-free-actions, .pro-cta-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

.pro-picks-plan { overflow: hidden; isolation: isolate; background: radial-gradient(circle at 82% -12%, rgba(212,175,55,.16), transparent 36%), linear-gradient(155deg, rgba(212,175,55,.055), transparent 46%), var(--pbe-ink-2); box-shadow: 0 0 0 1px var(--pbe-gold-soft), 0 22px 52px rgba(0,0,0,.28); }
.pro-picks-plan::before { content: ""; position: absolute; inset: 0 0 auto; height: 2px; background: linear-gradient(90deg, transparent, var(--pbe-gold), transparent); opacity: .9; pointer-events: none; }
.pro-picks-kicker { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pro-picks-pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--pbe-gold); border-radius: 999px; padding: 5px 9px; color: var(--pbe-gold); background: rgba(212,175,55,.06); font: 800 10px/1 var(--pbe-font-data); letter-spacing: .11em; }
.pro-picks-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--pbe-gold); box-shadow: 0 0 10px var(--pbe-gold); }
.pro-picks-title { max-width: 20ch; margin: 12px 0 8px; color: var(--pbe-paper); font: 700 clamp(24px, 3vw, 36px)/1.04 var(--pbe-font-display); letter-spacing: -.025em; }
.pro-picks-lede { color: var(--pbe-dim); font-size: var(--fs-sm); line-height: 1.7; max-width: 78ch; }

.pro-proof-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: var(--s-4) 0; overflow: hidden; border: 1px solid var(--pbe-line-strong); border-radius: var(--r-sm); background: var(--pbe-line); }
.pro-proof-row > div { display: grid; gap: 3px; min-width: 0; padding: 13px 14px; background: rgba(8,8,7,.82); }
.pro-proof-row b { color: var(--pbe-gold); font: 800 12px/1 var(--pbe-font-data); letter-spacing: .1em; }
.pro-proof-row span { color: var(--pbe-faint); font-size: 11px; }

.pro-pick-lockbox { margin: var(--s-4) 0; border: 1px solid rgba(212,175,55,.34); border-radius: var(--r-sm); background: rgba(0,0,0,.2); overflow: hidden; }
.pro-pick-lockbox-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 11px 13px; border-bottom: 1px solid var(--pbe-line); background: rgba(212,175,55,.045); font: 800 11px/1.2 var(--pbe-font-data); letter-spacing: .09em; color: var(--pbe-gold); }
.pro-pick-lockbox-head a { color: var(--pbe-dim); font: 700 11px/1.2 var(--pbe-font-body); letter-spacing: 0; }
.pro-pick-lockrow { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 12px; padding: 10px 13px; border-bottom: 1px solid var(--pbe-line); }
.pro-pick-lockrow:last-child { border-bottom: 0; }
.pro-pick-lockrow > span:first-child { display: grid; gap: 2px; }
.pro-pick-lockrow b { color: var(--pbe-paper); font-size: 13px; }
.pro-pick-lockrow small { color: var(--pbe-faint); font-size: 11px; line-height: 1.35; }
.pro-lock-chip { border-radius: 999px; border: 1px solid var(--pbe-gold); color: var(--pbe-gold); padding: 4px 7px; font: 800 9px/1 var(--pbe-font-data); letter-spacing: .08em; }

.pro-picks-price { margin: var(--s-4) 0; }
.pro-picks-price .price { margin-bottom: 7px; }
.pro-value-list { margin-top: 0 !important; }
.pro-value-list li { color: var(--pbe-dim); line-height: 1.55; }
.pro-value-list li b { color: var(--pbe-paper); }
.pro-receipt-line { margin-top: var(--s-4); padding-top: var(--s-3); border-top: 1px solid var(--pbe-line); color: var(--pbe-faint); font-size: 11px; line-height: 1.55; }
.pro-receipt-line b { color: var(--pbe-paper); }
.pro-receipt-line a { color: var(--pbe-gold); font-weight: 700; }

.pro-algo-sales { position: relative; overflow: hidden; background: radial-gradient(circle at 86% 0, rgba(212,175,55,.11), transparent 33%), var(--pbe-ink-2); }
.pro-algo-sales > * { position: relative; z-index: 1; }
.pro-algo-sales h2 { margin: 7px 0 8px; font-size: clamp(26px, 3.6vw, 42px); line-height: 1.04; max-width: 18ch; }
.pro-algo-sales-lede { max-width: 82ch !important; line-height: 1.7; }
.pro-algo-proof { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: var(--s-4) 0; overflow: hidden; border: 1px solid var(--pbe-line-strong); border-radius: var(--r-sm); background: var(--pbe-line); }
.pro-algo-proof > div { display: grid; gap: 3px; padding: 14px; background: rgba(8,8,7,.8); }
.pro-algo-proof b { color: var(--pbe-paper); font: 800 clamp(18px, 2.4vw, 28px)/1 var(--pbe-font-data); }
.pro-algo-proof span { color: var(--pbe-faint); font-size: 11px; }
.pro-algo-proof-empty { display: grid; gap: 5px; margin: var(--s-4) 0; padding: 14px 16px; border: 1px solid rgba(212,175,55,.34); border-radius: var(--r-sm); background: rgba(212,175,55,.045); }
.pro-algo-proof-empty b { color: var(--pbe-gold); font: 800 11px/1.25 var(--pbe-font-data); letter-spacing: .09em; }
.pro-algo-proof-empty span { color: var(--pbe-dim); font-size: var(--fs-sm); }
.pro-algo-receipt { display: grid; grid-template-columns: minmax(0,.8fr) minmax(0,1.4fr); gap: 18px; align-items: start; margin: var(--s-4) 0; padding: 16px; border-top: 1px solid var(--pbe-line); border-bottom: 1px solid var(--pbe-line); }
.pro-algo-receipt > div { display: grid; gap: 5px; }
.pro-algo-receipt strong { color: var(--pbe-paper); font: 700 19px/1.15 var(--pbe-font-display); }
.pro-algo-receipt p { color: var(--pbe-dim); font-size: var(--fs-sm); line-height: 1.65; margin: 0; }

@media (max-width: 800px) {
  .pro-offer-v2 { grid-template-columns: minmax(0,1fr); }
  .pro-picks-title { max-width: 24ch; }
  .pro-algo-proof { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pro-algo-receipt { grid-template-columns: minmax(0,1fr); }
}
@media (max-width: 520px) {
  .pro-proof-row { grid-template-columns: minmax(0,1fr); }
  .pro-pick-lockbox-head { align-items: flex-start; flex-direction: column; }
  .pro-cta-row .btn { flex: 1 1 100%; text-align: center; }
}
'''
css.write_text(c)


# --- Guard the sales truth and the removal of obsolete copy. ---
final_ui = ui.read_text()
final_pro = pro.read_text()
final_home = home.read_text()
assert "The model makes the call before the fight. Then it lives with the result." in final_ui
assert "Model probabilities, fair prices and picks stay unavailable until validated" not in final_ui
assert "PBE Algo calls the fights. UFC Pro shows you every call." in final_pro
assert "Public proof is free. PBE Picks are Pro." in final_home
assert "Every official call has a receipt." in final_ui
print("UFC Pro sales surfaces refreshed")
