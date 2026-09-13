# NJ SACB public-records request: legacy UFC events (DRAFT, NOT SENT)

Status: **draft for owner review. Do not send without Justin's approval.**
Prepared: 2026-09-13, branch `ufc-legacy-origins-v1`.

## Why

Six UFC events were held in New Jersey during the legacy window. They are the
earliest sanctioned UFC events. No results, officials or scorecards for them
are published online: the New Jersey State Athletic Control Board (SACB)
publishes event results only from about 2008. The records are needed as the
primary-source authority for those events. When they arrive they are stored as
tier-1 `commission_record` claims (`ufc_event_fact_claims`, source
`nj_sacb`). They never overwrite the existing UFCStats/ESPN-lineage rows.

The Origins build does **not** wait for this request.

| Event | Date | Location (canonical archive) |
|---|---|---|
| UFC 28: High Stakes | 2000-11-17 | Atlantic City, NJ |
| UFC 30: Battle on the Boardwalk | 2001-02-23 | Atlantic City, NJ |
| UFC 31: Locked and Loaded | 2001-05-04 | Atlantic City, NJ |
| UFC 32: Showdown in the Meadowlands | 2001-06-29 | East Rutherford, NJ |
| UFC 41: Onslaught | 2003-02-28 | Atlantic City, NJ |
| UFC 50: The War of '04 | 2004-10-22 | Atlantic City, NJ |

## Before sending (owner checklist)

- [ ] Confirm the custodian. SACB sits in the Department of Law & Public Safety (Office of the Attorney General). Submit through the State of New Jersey OPRA request system, choosing that department and naming the SACB as the records holder.
- [ ] Fill in the requester block below. OPRA does not require a stated purpose; none is given.
- [ ] Choose a delivery format (electronic copies preferred) and a fee ceiling.
- [ ] Record the submission date and request number in `docs/legacy/nj_sacb_opra_log.md` (create it on send). New Jersey's normal response period is 7 business days, and the custodian may extend it.

## Request text

> **To:** Custodian of Records, New Jersey Department of Law & Public Safety - State Athletic Control Board
>
> **Requester:** [NAME] · [ORGANIZATION] · [EMAIL] · [MAILING ADDRESS] · [PHONE]
>
> **Records requested (Open Public Records Act, N.J.S.A. 47:1A-1 et seq.):**
>
> For each of the following professional mixed martial arts events promoted under the name "Ultimate Fighting Championship" and held in New Jersey:
>
> 1. UFC 28, November 17, 2000, Atlantic City (Trump Taj Mahal)
> 2. UFC 30, February 23, 2001, Atlantic City (Trump Taj Mahal)
> 3. UFC 31, May 4, 2001, Atlantic City (Trump Taj Mahal)
> 4. UFC 32, June 29, 2001, East Rutherford (Continental Airlines Arena)
> 5. UFC 41, February 28, 2003, Atlantic City (Boardwalk Hall)
> 6. UFC 50, October 22, 2004, Atlantic City (Boardwalk Hall / Trump Plaza, per differing reports)
>
> I request copies of the following records, to the extent they are retained:
>
> a. The official bout results sheet or event result summary, including bout order, winner, method of decision, round and time of stoppage.
> b. Judges' scorecards for each bout that went to a decision, including each judge's name and individual score.
> c. The assignment of officials for each bout: referee, judges, timekeeper(s) and inspectors.
> d. Official weigh-in records (official weights of each contestant).
> e. Medical suspensions issued as a result of the event.
> f. Event licensing or permit records identifying the licensed promoter entity and the venue.
> g. Attendance records, including total attendance and paid attendance, and gate receipt reports or tax reports showing gross gate.
> h. Any event report, result summary or correspondence between the Board and the promoter that reports the event's official results.
>
> Where a record contains personal information exempt under OPRA (for example home addresses, Social Security numbers or medical details), I ask that it be redacted and the rest produced, rather than the record being withheld.
>
> If any requested record was destroyed under an approved records retention schedule, please say which record and cite the applicable retention schedule, so that I do not request it again.
>
> **Preferred format:** electronic copies (PDF) by email. If fees will exceed $[AMOUNT], please contact me before fulfilling the request.
>
> Thank you.

## Mapping on receipt (for the loader, not the request)

| Record | `fact_key` | Scope |
|---|---|---|
| a. results sheet | `result_summary` | bout |
| b. scorecards | `judge`, `judge_score` | bout |
| c. officials | `referee`, `judge`, `timekeeper` | bout |
| d. weigh-ins | `official_weight_lbs` | bout |
| e. suspensions | `medical_suspension` | bout |
| f. licensing | `promoter_entity`, `venue_name`, `sanctioning_body` | event |
| g. attendance / gate | `attendance`, `paid_attendance`, `gate_usd` | event |

Every claim is stored with `source_type='commission_record'`, `source_tier=1` and `source_id=nj_sacb`. The locator names the document plus its sha256. Where a claim disagrees with an existing UFCStats/ESPN-lineage value, the claim opens a `conflict_group`. The canonical row is left as is, and resolution is a separate reviewed step.
