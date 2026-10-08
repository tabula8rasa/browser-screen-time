# MVP implementation and acceptance

Status: READY TO SHIP MVP, 2026-10-08. This document maps the MVP requirements
to production behavior and records release evidence. Historical tracking acceptance
remains in TRACKING_ACCEPTANCE.md; no new human focus/workspace acceptance is claimed.

## Requirement mapping

| MVP requirement | Implementation / acceptance source |
|---|---|
| All hostnames; focused active tab; idle HTML video/audio exception | Existing trackingState/awake/videoCheck/background; unchanged tracking regression suite and accepted Firefox/Hyprland evidence |
| Daily aggregates preserved; no visit counts or live popup | Existing Counter/browser.storage.local/popup; daily schema and saved-snapshot tests |
| Local detailed sessions and domain registry | SessionHistory/SessionStorage; effective-decision publications, FIFO mutations, normalized dictionary, finite safe endpoints |
| Exact raw history; no smoothing writes | Session clock/lifecycle/storage; timelinePresentation copies only displayed ranges |
| Total Screen Time / Most Used Site / Daily Average | dashboardData and dashboard metric cards, using saved aggregates; missing calendar dates count in average |
| Total Screen Time by Day | Daily stacked bars, website selection, bounded 30-day chart pages for long custom periods; each bar remains one day |
| Time Distribution | Aggregate domain shares, six leading domains and remaining aggregate Other |
| Day Timeline | Real positive session intervals, raw-duration Top 4 and Other; selected day/capture-calendar group; decreasing smoothing and exact raw zoom |
| Changes vs Previous Period | Immediately preceding equal-length calendar period; zero baseline labelled New/No change |
| Year Heatmap | Selected end-date year, local daily aggregates, independent website filter |
| Single dashboard / approved reference | Dark responsive dashboard with no analytics sidebar; settings/back control |
| Import/export/reset compatibility | Legacy daily maps, full versioned overwrite, daily-only merge invalidation; detailed merge rejected; settings preserved |
| Every hostname survives Firefox storage/export transport | Shared additive reserved-key codec and JSON-string export RPC; ordinary daily records and canonical backup formats preserved |
| Local-first/privacy | Local storage and IndexedDB; local initials/icons; no backend/account/sync/history upload |
| Exclusions | No Pomodoro, visits, live popup updates, cloud or cross-device synchronization |

## Data and interruption decisions

Daily accounting seconds and observed session milliseconds remain separate datasets.
No timeline is invented for legacy aggregate-only records. Incomplete/unavailable
coverage is explicitly labelled; only full proven observed coverage can establish
an empty observed day. Capture-local calendar bounds stay fixed after travel;
DST uses true day bounds and repeated-hour offset labels.

Replacement uses strict IndexedDB intent plus conservative history invalidation.
Recovery preserves actual saved daily values, including partial results, and never
replays an import/reset/merge target. History timeouts quarantine unknown outcomes;
they never authorize a competing writer. Unsupported strict intent durability fails
before changing daily data. Arbitrary disk/power failure cannot make independent
storage APIs atomic and is not a supported shared-durability guarantee.

## Release verification

- Baseline: 124 automated tests, both typechecks, production build and diff-check passed.
- Native baseline: Firefox 157 strict transaction reported strict and completed a
  fixture roundtrip; extension reload/fresh native probe passed; background is
  nonpersistent. No machine-power-loss test was performed.
- Native product checks: supported 300-second idle setting with actual focused
  A→B→STOP transitions passed. Reload preserved all 24 finite session rows exactly
  and kept saved daily values unchanged. Wide (1064 CSS pixels) and narrow (426)
  dashboard views exposed all eight sections without page overflow; raw zoom
  preserved queried session records.
- Final integrated automation: 240 tests across 23 files passed. Application and
  test typechecks, production build, and `git diff --check` passed. The build retains
  bundle-size warnings.
- Repaired-product native checks: all 12 Object.prototype hostname keys survived
  overwrite, merge, both canonical JSON exports, full roundtrip and reload. Ordinary
  daily storage shape remained unchanged. Genuine focused accounting and the
  15-second persistence cadence passed for `constructor` and fractional legacy
  data, preserving represented numbers. The real dashboard rendered all 14
  canonical chart segments with exact hostname/value titles.
- Native transfers: legacy overwrite/merge and affected-detail invalidation,
  detailed-merge rejection without mutation, reset of both datasets with settings
  retained, and full history restoration with remapped IDs passed. Corrupt open
  metadata rejected reset without daily mutation or an intent.
- Native strict-intent interruptions before daily removal and after removal/before
  set passed: reload preserved the actual saved prefix, discarded affected detail,
  and never replayed a target.
- Fresh independent cold audit and repair re-review: **READY TO SHIP MVP**, with
  no confirmed correctness blocker. It inspected the complete implementation,
  tracking compatibility, persistence/transfers, UI semantics and native evidence.

## Residual platform boundaries

Session history records observed decisions with finite checkpoints; it does not
infer suspended/restart time or promise a hard crash-loss bound. Arbitrary machine
power loss and disk failure were not tested and cannot provide cross-store atomicity.
Native real-time midnight/DST and machine suspension were not exercised; deterministic
calendar, timezone and discontinuity tests cover those contracts. Forced process
kill and natural event-page unloading were not observed; extension reload and
background recreation were verified. Existing tracking
support excludes Web Audio and closed shadow roots. No automatic history retention
is configured. Daily totals use the existing JavaScript Number accounting and its
representational limits; this MVP does not redesign that counter.

The original development-profile daily/history/settings baseline was restored,
owned fixture tabs were removed, zoom/foreground were restored, and the isolated
Firefox runner was stopped. Runtime evidence and orchestration state remain ignored
under `.dev/mvp-orchestrator/`.
