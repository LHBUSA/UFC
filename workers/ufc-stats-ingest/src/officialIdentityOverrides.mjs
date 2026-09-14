/* Audited identity exceptions for the official UFC statistics feed.
 *
 * Each entry lets ONE official fighter on ONE official fight map to ONE of our
 * fighters when the feed carries a value that conflicts with verified canonical
 * data. It never changes canonical data: our fighter row (name, DOB, aliases,
 * external ids) stays as it is; only round rows and queue state may be written.
 *
 * An entry is honoured only when (enforced in mapOfficialFighters):
 *   - the official fight id AND official fighter id match exactly,
 *   - our fighter is one of the two corners of the bout being processed,
 *   - the compact normalized names are identical (spacing differences only),
 *   - the OTHER corner matches exactly (canonical name or stored alias),
 * and, as for every bout, the card identity and the stored result must agree.
 */
export const OFFICIAL_IDENTITY_OVERRIDES = [
  {
    key: 'kwon-won-il-dob-2026-09-14',
    official_event_id: '1334',
    official_fight_id: '13113',
    official_fighter_id: '4484',
    fighter_id: '6c5fdca6-fbe3-464f-8e27-28518a568d70',
    fighter_name: 'Kwon Won Il',
    canonical_dob: '1995-06-24',
    official_feed_name: 'Kwon WonIl',
    official_feed_dob: '1995-07-24',
    discrepancy: 'UFC official feed DOB 1995-07-24 conflicts with canonical 1995-06-24; ESPN (6/24/1995), Tapology (1995-06-24) and Sherdog (Jun 24, 1995) independently report 1995-06-24',
    identity_basis: 'same DWCS 10.5 card (2026-09-08), exact opponent Apollo Gomes (name + DOB 2000-07-10), stored result agrees (Gomes, unanimous decision, 3 rounds, 5:00), compact name identical, no other fighter with this name',
    approved: { by: 'owner', on: '2026-09-14' },
    evidence: 'docs/ops/evidence/kwon_won_il_dob_discrepancy_2026-09-14.json',
  },
];
