/* What this article can actually show, decided from evidence rather than taste.
 *
 * GPT-5.6 Sol writes the narrative. It does not decide what modules appear and
 * it never produces a number that reaches a chart. Everything here is read
 * straight out of the intelligence packet, the DNA snapshots and the video
 * resolver, so a chart is a rendering of a verified column and nothing else.
 *
 * WHY THE MODEL IS KEPT OUT OF CHARTS
 *
 * The two-class number gate protects prose by checking every number in the body
 * against the packet. A chart bypasses that entirely: a fabricated series is a
 * made-up number with a picture around it and no sentence for the gate to
 * inspect. So the model is not asked for chart data, and there is no code path
 * that would accept it.
 *
 * NOTHING IS FORCED
 *
 * A module with no evidence is omitted AND THE OMISSION IS RECORDED. A contract
 * story may carry a fighter card, a video and career context; a matchup story
 * may carry five modules plus DNA. Both are correct. An empty section labelled
 * "Fight DNA" is worse than no section, because it teaches the reader that our
 * sections mean nothing.
 */

const pct = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
const r2 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const has = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** A DNA metric only counts when the builder itself was confident in it. */
function dnaMetric(snapshot, key, { minConfidence = 'medium' } = {}) {
  const m = snapshot?.metrics?.[key];
  if (!m || !has(m.value)) return null;
  const rank = { low: 0, medium: 1, high: 2 };
  if ((rank[m.confidence] ?? 0) < (rank[minConfidence] ?? 1)) return null;
  return {
    key, value: Number(m.value), unit: m.unit ?? null,
    confidence: m.confidence, sample_bouts: m.sample_bouts ?? null,
    sample_rounds: m.sample_rounds ?? null,
  };
}

export async function loadDna(sb, fighterIds = []) {
  const ids = fighterIds.filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await sb.select('ufc_fighter_dna_snapshots',
    `select=fighter_id,as_of_date,coverage_status,archetype,metrics,finish_profile,round_profile,`
    + `sample_bouts,sample_rounds,definition_version`
    + `&fighter_id=in.(${ids.join(',')})&order=as_of_date.desc`);
  const byFighter = new Map();
  for (const r of rows) if (!byFighter.has(r.fighter_id)) byFighter.set(r.fighter_id, r);
  return byFighter;
}

/* ------------------------------------------------------------------ charts */

/**
 * Chart specs, not chart images.
 *
 * Each spec carries its series, its units and the provenance of every value.
 * The renderer draws it; nothing here emits HTML or SVG, because a chart
 * generated as markup by a model is unauditable by definition.
 */
function buildCharts(packet, dna) {
  const charts = [];
  const p = packet.primary;
  const o = packet.opponent;
  const pd = dna.get(p?.fighter_id);
  const od = o ? dna.get(o.fighter_id) : null;

  /* 1. Striking exchange. Needs both sides, or it is a bar chart of one bar. */
  if (o && has(p?.career?.sig_strikes_landed_per_min) && has(o?.career?.sig_strikes_landed_per_min)) {
    charts.push({
      id: 'striking_exchange',
      type: 'grouped_bar',
      title: 'Striking exchange, per minute',
      unit: 'significant strikes / min',
      source: 'ufc_fighters career averages',
      series: [
        { label: p.name, landed: r2(p.career.sig_strikes_landed_per_min), absorbed: r2(p.career.sig_strikes_absorbed_per_min) },
        { label: o.name, landed: r2(o.career.sig_strikes_landed_per_min), absorbed: r2(o.career.sig_strikes_absorbed_per_min) },
      ],
      legend: ['landed', 'absorbed'],
    });
  }

  /* 2. Grappling. Percentages are stored 0-100 in ufc_fighters. */
  if (o && (has(p?.career?.takedowns_per_15min) || has(o?.career?.takedowns_per_15min))) {
    charts.push({
      id: 'grappling_profile',
      type: 'grouped_bar',
      title: 'Grappling profile',
      source: 'ufc_fighters career averages',
      series: [
        { label: p.name, takedowns_per_15: r2(p.career.takedowns_per_15min), td_accuracy_pct: p.career.takedown_accuracy_pct, td_defence_pct: p.career.takedown_defence_pct },
        { label: o.name, takedowns_per_15: r2(o.career.takedowns_per_15min), td_accuracy_pct: o.career.takedown_accuracy_pct, td_defence_pct: o.career.takedown_defence_pct },
      ],
      legend: ['takedowns_per_15', 'td_accuracy_pct', 'td_defence_pct'],
    });
  }

  /* 3. How this fighter's wins actually end. One fighter is enough here —
   *    it is a composition, not a comparison. */
  const f = p?.form;
  if (f && f.wins > 0) {
    charts.push({
      id: 'finish_history',
      type: 'stacked_bar',
      title: `How ${p.name} wins`,
      unit: 'wins',
      source: 'ufc_bout_results archive',
      sample_note: `${f.wins} archived wins`,
      series: [{
        label: p.name,
        ko_tko: f.wins_by_ko_tko, submission: f.wins_by_submission, decision: f.wins_by_decision,
      }],
      legend: ['ko_tko', 'submission', 'decision'],
    });
  }

  /* 4. Round-by-round pace, straight out of the DNA round profile. This is the
   *    one a reader cannot get anywhere else. */
  const rounds = pd?.round_profile?.rounds;
  if (rounds && typeof rounds === 'object') {
    const points = [];
    for (const k of ['1', '2', '3', '4', '5']) {
      const v = rounds[k]?.sig_att_per_min?.value;
      if (has(v)) points.push({ round: Number(k), sig_attempts_per_min: r2(v), rounds_sampled: rounds[k]?.rounds ?? null });
    }
    if (points.length >= 2) {
      charts.push({
        id: 'round_pace',
        type: 'line',
        title: `${p.name}: output by round`,
        unit: 'significant strike attempts / min',
        source: 'ufc_fighter_dna_snapshots round_profile',
        series: points,
      });
    }
  }

  /* 5. DNA traits, compared when we hold both sides. Every trait carries its
   *    own confidence, so a low-confidence metric never reaches the chart. */
  const TRAITS = [
    ['sig_accuracy', 'Striking accuracy'],
    ['sig_defense', 'Striking defence'],
    ['td_accuracy', 'Takedown accuracy'],
    ['control_share', 'Control share'],
    ['finish_rate', 'Finish rate'],
  ];
  if (pd) {
    const rows = [];
    for (const [key, label] of TRAITS) {
      const a = dnaMetric(pd, key);
      const b = od ? dnaMetric(od, key) : null;
      if (!a && !b) continue;
      rows.push({
        trait: label, metric_key: key,
        [p.name]: a ? pct(a.value) : null,
        ...(o ? { [o.name]: b ? pct(b.value) : null } : {}),
        confidence: a?.confidence ?? b?.confidence ?? null,
        sample_bouts: a?.sample_bouts ?? b?.sample_bouts ?? null,
      });
    }
    if (rows.length >= 2) {
      charts.push({
        id: 'dna_traits',
        type: o ? 'grouped_bar' : 'bar',
        title: o ? 'Fight DNA, head to head' : `${p.name}: Fight DNA`,
        unit: '%',
        source: `ufc_fighter_dna_snapshots (definition v${pd.definition_version}, as of ${pd.as_of_date})`,
        series: rows,
      });
    }
  }

  /* 6. Odds, only when this exact bout is priced. */
  const prices = packet.market?.odds_status === 'available' ? (packet.market.prices || []) : [];
  const h2h = prices.filter((x) => x.market === 'h2h' && has(x.price));
  if (h2h.length >= 2) {
    charts.push({
      id: 'market_prices',
      type: 'bar',
      title: 'Moneyline, by book',
      unit: 'American odds',
      source: `ufc_market_observations, observed ${packet.market.observed_at}`,
      series: h2h.map((x) => ({ label: `${x.outcome} (${x.book})`, price: x.price })),
    });
  }

  return charts;
}

/* ------------------------------------------------------------------ plan */

/**
 * Decide the modules, and record what was left out and why.
 *
 * @returns {{modules, omitted, chart_count, video_tier}}
 */
export async function buildContentPlan(sb, { packet, article, hero, videos = null, dna = new Map() }) {
  const modules = [];
  const omitted = [];
  const p = packet.primary;
  const o = packet.opponent;
  const pd = dna.get(p?.fighter_id);

  const add = (id, title, data) => modules.push({ id, title, ...data });
  const skip = (id, reason) => omitted.push({ id, reason });

  /* Always: the bettor's read and the sourcing. Both come from the packet the
   * article was written from, so they cannot disagree with the prose. */
  add('bettors_edge', "Bettor's Edge", {
    data: article.bettor_angle,
    note: (article.bettor_angle?.markets || []).includes('none')
      ? 'no actionable edge; stated rather than manufactured' : null,
  });

  add('source_methodology', 'Sources and method', {
    data: {
      trigger: packet.source ? { publisher: packet.source.publisher, url: packet.source.url, published_at: packet.source.published_at } : null,
      first_party_tables: ['ufc_fighters', 'ufc_bouts', 'ufc_bout_results', 'ufc_bout_round_stats', 'ufc_rankings']
        .concat(pd ? ['ufc_fighter_dna_snapshots'] : [])
        .concat(packet.market?.odds_status === 'available' ? ['ufc_market_observations'] : []),
      model: article.model,
      gate: article.validation,
      odds_status: packet.market?.odds_status,
      model_status: packet.model?.model_status,
    },
  });

  /* Fighter card: always, when we have a subject at all. */
  if (p) {
    add('fighter_card', p.name, {
      data: {
        name: p.name, nickname: p.nickname, record: p.record, age: p.age,
        stance: p.stance, height: p.height, reach_in: p.reach_in, weight_lbs: p.weight_lbs,
        rankings: p.rankings || null,
      },
    });
  } else skip('fighter_card', 'no primary fighter resolved');

  if (o) {
    add('fighter_comparison', `${p.name} vs ${o.name}`, {
      data: {
        a: { name: p.name, record: p.record, reach_in: p.reach_in, age: p.age, stance: p.stance, career: p.career },
        b: { name: o.name, record: o.record, reach_in: o.reach_in, age: o.age, stance: o.stance, career: o.career },
        edges: packet.edges,
      },
    });
  } else skip('fighter_comparison', 'no booked opponent in our tables, so there is nothing to compare against');

  if (pd) {
    add('fight_dna', 'Fight DNA', {
      data: {
        as_of: pd.as_of_date, coverage: pd.coverage_status, archetype: pd.archetype,
        sample_bouts: pd.sample_bouts, sample_rounds: pd.sample_rounds,
        definition_version: pd.definition_version,
        traits: Object.fromEntries(
          ['sig_accuracy', 'sig_defense', 'td_accuracy', 'td_landed_per_15', 'control_share',
            'finish_rate', 'ko_finish_rate', 'submission_finish_rate', 'knockdowns_per_15']
            .map((k) => [k, dnaMetric(pd, k)]).filter(([, v]) => v),
        ),
      },
    });
  } else skip('fight_dna', 'no Fight DNA snapshot for this fighter');

  const f = p?.form;
  if (f?.last_five?.length) {
    add('recent_form', 'Recent form', {
      data: {
        last_five: f.last_five,
        archive_bouts: f.archive_bouts,
        days_since_last_bout: f.days_since_last_bout,
        finish_rate_on_wins_pct: f.finish_rate_on_wins_pct,
        /* The caveat travels with the number, not in a footnote. */
        sample_note: `${f.wins} archived wins`,
        opponent_last_five: o?.form?.last_five || null,
      },
    });
  } else skip('recent_form', 'no completed bouts in our archive for this fighter');

  if (p?.round_data) {
    add('round_style_stats', 'Round and style data', {
      data: { ...p.round_data, opponent: o?.round_data || null },
    });
  } else skip('round_style_stats', 'no round-level statistics recorded for this fighter');

  if (packet.market?.odds_status === 'available') {
    add('market_snapshot', 'Market', {
      data: { observed_at: packet.market.observed_at, books: packet.market.books, prices: packet.market.prices },
    });
  } else {
    skip('market_snapshot', packet.market?.reason || 'no verified price for this bout');
  }

  if (packet.bout) {
    add('bout_context', 'The booking', {
      data: {
        opponent: packet.bout.opponent, weight_class: packet.bout.weight_class,
        is_title: packet.bout.is_title, scheduled_rounds: packet.bout.scheduled_rounds,
        card_position: packet.bout.card_position, status: packet.bout.status, event: packet.bout.event,
      },
    });
  } else skip('bout_context', 'this fighter has no upcoming bout in our schedule');

  if (hero) {
    add('hero_media', 'Hero image', {
      data: { image_id: hero.id, r2_key: hero.r2_key, credit: hero.credit },
    });
  } else skip('hero_media', 'no rights-cleared portrait with a complete credit for the primary subject');

  const vids = videos?.videos || [];
  if (vids.length) {
    add('official_video', 'Official video', {
      data: { tier: videos.tier, videos: vids },
      note: `matched at tier ${videos.tier} (${vids[0]?.matched_on})`,
    });
  } else {
    skip('official_video', videos?.reason || 'no high-confidence official video involves this story subject');
  }

  const charts = buildCharts(packet, dna);
  if (charts.length) {
    add('charts', 'Data', { data: charts, note: 'every series is a read of a verified column; no value is model-generated' });
  } else skip('charts', 'not enough verified numeric data to plot anything honest');

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    modules,
    omitted,
    chart_count: charts.length,
    video_tier: videos?.tier ?? null,
    module_ids: modules.map((m) => m.id),
  };
}
