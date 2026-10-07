# Production tracking acceptance

## Implementation boundary

The background aggregates focused-window state, the active tab of that window,
initialized idle state, and a sender-identified per-tab/per-frame current-document
media registry. A document connection must prove it belongs to the currently
reachable frame before it becomes the owner. Older asynchronous validations,
messages, and disconnects cannot replace or clear the current owner.

Only the active tab is eligible. While non-idle, media is ignored. While idle,
`videoCheck` must be enabled and at least one HTML video/audio element in that tab
must be actually playing, unmuted, and have positive volume. Frame media is
attributed to the top-level tab hostname. `WINDOW_ID_NONE` stops eligibility
synchronously. Focus enumeration is initialization only; runtime focus events
remain authoritative afterward.

Daily schemas/settings keys, popup reads, notifications, fixed +1 seconds, and
15-second persistence are preserved. The existing save gate also remains: stopping
tracking does not introduce a new immediate flush. Full-date rollover, elapsed-time
accounting, and crash-save durability remain backlog items.

## Automated validation

```bash
npm test
npm run typecheck
npm run prod
bash scripts/firefox-dev.sh start
bash scripts/firefox-dev.sh status
bash scripts/firefox-dev.sh logs
bash scripts/firefox-dev.sh stop
```

Unit/integration tests cover the truth table, silent media, multiple tabs/elements,
iframe ownership, document replacement, navigation, tab closure, BFCache,
buffering, initial playback, settings initialization, rapid switching, delayed
queries, overlapping ticks, counter overwrite, stored daily compatibility,
notifications, and the existing save cadence. DOM tests use jsdom; background tests
use WebExtension events, ports, deferred lookups, storage, and fake timers.

The production build succeeds with existing Sass deprecation and bundle-size
warnings. Tests and both application/test typechecks must also pass after review
fixes.

## Local Firefox runtime validation

Validated against Firefox 157 in the dedicated development profile, with the
project runner automatically installing/reloading `dist/`. Local HTTP fixtures
and Firefox's debugger inspected real extension ports and media messages; no
production diagnostic endpoint or test hook was added.

Passed:

- Initial scan of HTML video and audio, followed by real playback reports.
- Actual unmute, zero-volume, positive-volume, and pause changes.
- Multiple elements with independent IDs.
- Cross-origin and inherited-origin srcdoc iframe registration, with Firefox
  sender tab/frame/document IDs.
- Playing element removal and iframe disconnect.
- Navigation to a non-media page: old connection disconnected, new document ID
  registered with an empty snapshot.
- BFCache back navigation: the same Firefox document reconnected through a fresh
  port and resnapshot.
- Canceled navigation: Firefox emitted loading/complete while the original
  document survived; completion revalidated its port and requested a fresh snapshot.
- Settings changes sent from the actual popup extension context disabled and
  re-enabled current-document media scanning without reloading the page.
- Closing the fixture tab disconnected its document.

Temporary probes and autoplay preferences were confined to the dev Firefox and
removed/restored afterward. Runtime evidence is ignored under
`.dev/tracking-runtime-results.json` and `.dev/runtime-media-probe.json`.

This desktop session did not give the development window focus through automated
window activation. Runtime focused-window eligibility is therefore **not claimed**
as validated; it is covered automatically at the state-model level and remains in
human acceptance below. These checks validate production integration rather than
repeat the completed focus/workspace research.

## Independent review

One read-only reviewer inspected the complete change and independently ran the
suite. Two confirmed issues were fixed and reviewed again: popup settings now
travel to content scripts over accepted document ports, and canceled navigation
revalidates surviving documents on completion. No further confirmed defects were
found. The final suite has 55 passing tests.

## Human acceptance checklist

Use `bash scripts/firefox-dev.sh start`, the dedicated Firefox window, a 15-second
idle interval, and `videoCheck` enabled. Use the enabled/disabled action icon for
eligibility; reopen the popup after a scheduled save for stored totals, since it
is intentionally not a live timer. Keep eligible accounting checks running for at
least 16 seconds to allow a scheduled save.

1. Focus Firefox on a non-media site, interact normally, then leave it idle:
   TRACK while non-idle, STOP while idle. Background playing video/audio must not
   change either outcome.
2. In the active tab, play an unmuted positive-volume real video, then audio:
   remain TRACK while idle. Pause/end each: STOP. Mute or set volume to zero:
   STOP; restore sound while playback continues: TRACK.
3. While idle, switch between a playing media tab and a non-media tab: only the
   active media tab qualifies. Two simultaneously playing background tabs still
   cannot enable the non-media tab.
4. While idle with active qualifying media, focus another application or switch
   away from the Firefox Hyprland workspace: immediate STOP. Return to Firefox:
   resolve the current active tab and resume only when it qualifies.
5. Open two Firefox windows on different domains and rapidly alternate window
   focus/tab activation, including moving a tab between windows: only the active
   tab of the focused window receives seconds.
6. Exercise a real site's iframe playback and temporary network buffering. An
   active parent tab qualifies through its audible iframe; removing/navigating
   the frame clears only that document. Short waiting/stalled periods retain
   established playback; pause/end/error stop it.
7. Verify popup today/week/month reads, a notification threshold, and import,
   export, and reset using disposable dev-profile data. The UI and stored formats
   should retain their existing behavior. Disable `videoCheck`: idle media no
   longer qualifies, but normal non-idle tracking continues.

No normal Firefox profile or its AMO extension participates in these checks.


## Guided manual acceptance — 2026-10-07

Status: complete for the performed acceptance scenarios; all passed after the
authorized popup and merge corrections. Natural buffering was not encountered
and is explicitly NOT OBSERVED, not claimed as a manual PASS. Only the dedicated
`.dev/firefox-profile` participated.
The current source was rebuilt by the runner; Firefox confirmed the temporary
extension is loaded from this repository's `dist/` with a running background.
Previous final validation: 55 tests passed, both typechecks passed, production
build passed. `git diff --check` passed at acceptance startup.

Idle interval: minimum supported 15 seconds; `videoCheck` enabled. Observer-only
runtime probes record focus, idle, tab activation, media, notifications, saves,
and the live counter reference after its first scheduled persistence. Probes do
not replace the tracking decision or accounting. Evidence is ignored under
`.dev/manual-observations.jsonl`; original dev-profile storage is backed up in
`.dev/manual-storage-baseline.json`. No scenario is marked PASS without evidence.

| Scenario | Result | Evidence |
|---|---|---|
| Focused Firefox, non-idle active ordinary tab | PASS | Window 1, tab 3 (example.com), idle=active; live total/domain reached 69s, only example.com credited. Consecutive samples increased by +1; scheduled saves observed. On return to chat, WINDOW_ID_NONE disabled tracking and counter stayed 69s. |
| Workspace without Firefox stops tracking | PASS | Repeat: focus ID 1 credited example.com up to 119s; workspace-away emitted WINDOW_ID_NONE and disabled icon. Counter stayed 119s for ~39s, including ~14s with idle=active, proving STOP before idle. First attempt had inconclusive setup. |
| Workspace return resumes correct tab | PASS | Focus returned to window 1/tab 3 with idle=active; example.com grew 119s → 137s, other domains absent. Scheduled save observed; return to chat stopped at 137s. |
| Another tiled application while Firefox visible stops tracking | PASS | User confirmed same-workspace tiled application with Firefox visible. WINDOW_ID_NONE stopped at 144s, regain resumed, subsequent loss stopped at 151s. Counter stable for ~60s afterward, including ~14s idle=active before idle. |
| Rapid application focus switching | PASS | Three rapid recorded gain/loss cycles (about 2s per focus period). Counter rose 151s → 158s only across focused periods; ticks observed in transition samples preceded the loss event. Stayed 158s after final WINDOW_ID_NONE, including ~14s idle=active. |
| Two Firefox windows: only focused window's active tab counted | PASS | A=window 1/example.com, B=window 45/example.org. Sustained A focus raised example.com to 173s while example.org stayed 3s; B focus raised example.org 3s → 13s while example.com stayed 173s. Transition sample's prior-domain tick occurred before the focus event. Final loss stopped total at 186s. |
| Rapid Firefox-window switching: no stale attribution | PASS | Five alternating A/B cycles recorded via focus IDs 1 and 45, with NONE transitions between them. Counter 186s → 197s (example.com 173→176, example.org 13→21), consistent with one-second ticks in corresponding focus intervals. Final sustained B focus increased only example.org; after final NONE neither increased. |
| Ordinary active tab while idle stops | PASS | Window 1/tab 3 remained focused, empty media snapshot. Idle event after ~15s disabled tracking; live counter stayed 213s (example.com 191s, example.org 22s) through 16 focused-idle samples. |
| Active unmuted positive-volume real video while idle counts | PASS | YouTube tab 6 focused in window 1, playing=true/muted=false/volume=1. Across 22 focused-idle samples YouTube grew 39s → 60s (+21), other domains unchanged; scheduled saves continued. |
| Background video with ordinary active tab while idle stops | PASS | YouTube tab 6 remained playing/unmuted in background (native audible=true verified afterward), tab 3/example.com active in focused window 1. After idle, total stayed 295s/example.com 211s for ~15s; YouTube stayed 62s throughout. |
| Active unmuted positive-volume HTML audio while idle counts | PASS | HTML audio tab 7 active in focused window 1, playing/unmuted/volume=1. During focused idle, 127.0.0.1 grew 34s → 54s (+20); all other domains, including background YouTube, stayed fixed. Scheduled saves continued. |
| Background audio with ordinary active tab while idle stops | PASS | HTML audio tab 7 remained background and native audible=true/unmuted. Ordinary tab 3 in focused window 1 stopped at idle: total 366s/example.com 227s stayed fixed for ~17s. Audio stayed 55s and YouTube stayed 62s. |
| Active muted video while idle stops | PASS | YouTube tab 6 reported playing=true, muted=true, volume=1. Focused idle disabled tracking; counter stayed 385s/YouTube 81s through ~26s idle despite background audible audio. |
| Active zero-volume media while idle stops | PASS | HTML audio tab 7 playing=true, muted=false, volume=0 verified natively and via detector. Focused-idle counter stayed 410s/audio 77s for ~17s; background media did not override. Non-idle silent media counted as required. |
| Playing active media loses Firefox focus and stops | PASS | Repeat with terminal: audio tab 7 playing/unmuted/volume=1 in window 1; WINDOW_ID_NONE stopped at total 455s/audio 97s. Stable afterward for ~39s, including ~29s before idle. First A→B attempt was different setup and correctly tracked the focused Firefox window. |
| Pause/resume | PASS | YouTube pause emitted playing=false and focused-idle total stayed 481s/YouTube 110s for 15 samples. Native Play emitted playing=true, unmuted/volume=1; focused-idle YouTube resumed 129s → 147s (+18), other domains fixed. |
| Navigation away clears playing media | PASS | YouTube tab 6 navigated to example.net. Old video removed, top/iframe ports disconnected; new Firefox document ID registered empty snapshot. YouTube stayed 157s afterward; focused-idle new page stopped at total 542s for ~15s despite background audio. |
| Playing tab close clears media | PASS | Playing audio tab 7 was closed and disappeared from native tab list; its document port disconnected (one transient reconnect during teardown also disconnected). New active ordinary tab 6 stopped at focused idle: total 565s remained fixed, audio stayed 104s. |
| Natural buffering, if encountered | NOT OBSERVED | No natural buffering was identified during real-site acceptance; no network disruption was forced. Automated waiting/stalled coverage passed. |
| Popup Today / This week / This month | PASS — after authorized fix | Actual toolbar popup: Today 609s with correct other=49s, week 615s, month 628s; totals and domain-row sums matched storage at each period selection. Saved snapshot behavior preserved. The initial other-row defect and approved correction are recorded below. |
| Settings reach tracker | PASS | Actual UI checkbox disabled videoCheck: new audio tab 10 registered empty snapshot, playing/unmuted/volume=1 audio stopped at focused idle (665s total). Re-enabling through the same settings UI caused the same document/port to rescan and report playback without reload; focused-idle audio grew 139s → 150s (+11), other domains unchanged. Idle remained 15s. |
| Notification smoke test | PASS | Actual Settings enabled notifications at the supported 900s interval. After imported audio baseline 895s, production accounting crossed 900s once and called browser.notifications.create with correct domain and 15min 0s text. Native API succeeded with notification ID 0; no notification error observed. Subsequent saved counter continued normally. |
| Export | PASS | Actual Settings Export downloaded .dev/exports/browser-screen-time-2026-10-07.json; parseable JSON matched saved daily schema/data exactly, total and domain sum 687s, settings excluded. UI success confirmed. |
| Import merge | PASS — after authorized fix | Actual UI retest matched the complete expected data: today 920s (audio 906, example.net 10, new domain 4), yesterday 30s, new day 9s; untouched days retained 777s/15s. Settings unchanged. Tracker received merged current-day data. Evidence: .dev/manual-merge-retest-result.json. Subsequent runtime persistence also passed. |
| Import overwrite | PASS | Actual UI file selection imported .dev/acceptance-overwrite.json. All four daily records matched exactly (today 905s, yesterday 25s, month boundary 15s, outside month 777s); previous domain records removed, settings unchanged. UI success confirmed. |
| Reset | PASS | Actual UI empty overwrite removed all date keys and preserved settings. Tracker received empty current-day data; subsequent example.com accounting started from zero and saved only that domain/current day, without resurrecting history. Evidence: .dev/manual-reset-result.json and .dev/manual-reset-persistence-result.json. |

Focus setup recheck: PASS. The labeled dev window emitted focus ID 1, idle became active, and example.com resumed counting (69s → 107s across the observed focus periods). Returning to chat emitted WINDOW_ID_NONE; the live counter stopped at 107s. This confirms window identity, not yet the specific workspace-away scenario.

Real-video setup verified: YouTube tab 6/frame 0 reported playing=true, muted=false, volume=1. Idle video acceptance countdown follows separately.

HTML-audio setup verified: local tab 7/frame 0 reports playing=true, muted=false, volume=1; native audio controls play a quiet looping WAV, without Web Audio.


### Acceptance halted at popup smoke test

Today rendering exposed a confirmed existing presentation defect: saved domains
227 + 157 + 104 + 49 + 34 = 571 seconds; the popup correctly shows 571 total,
but `other` displays 1 instead of 34. `Counter.mostUsed()` omits the final entry
and initializes the sum to 1. The relevant production files are unchanged from
HEAD, so this is not a tracking regression. No production code was modified.
Acceptance is halted as requested; remaining settings, notifications, export,
import, reset, and week/month checks remain pending. The dedicated dev environment
is retained for reproducing the issue; the normal Firefox remains untouched.


### Authorized popup correction and acceptance resume

The user authorized fixing the confirmed `other` calculation. The production
change is confined to `counter.ts`: sum the entire tail of the sorted domains,
starting at zero. Stored daily data and popup load/period-change behavior remain
unchanged; no live updates were added. Seven regression cases cover fifth/multiple
remaining domains, four-domain and zero remainder cases, and existing inclusive
Today/week/month date boundaries with outside-range data excluded.

After the correction: all 62 tests passed, application/test typechecks passed,
production build passed with existing warnings, and `git diff --check` passed.
The runner automatically reloaded the extension. Runtime probes were reconnected
without changing the dev-profile statistics. Acceptance resumes with Today retest.

Today retest after authorized fix: PASS. Actual toolbar popup showed 10min 9s = saved 609s; individual domains 227+157+104+72 and other=49 sum exactly 609. The other row now correctly represents example.org=49s. Popup remained a saved-data snapshot; no live refresh was introduced. Evidence appended to .dev/manual-ui-observations.jsonl.

This week smoke test: PASS. Actual toolbar popup selected week and showed 10min 15s = 615s, matching all saved data in the existing inclusive week interval. Domain rows plus other sum to 615. This disposable profile currently has only today; multi-date inclusion/exclusion is separately covered by the new automated boundary tests.

This month smoke test: PASS. Selected month rendered 10min 28s = saved 628s; domain rows (227+157+104+91) plus other=49 sum to 628. Only today exists in this test profile; multi-date boundary correctness is covered by automated tests.


### Acceptance halted at import merge

The actual Settings import/add operation exposed a confirmed existing storage
defect. Before/import/expected/actual snapshots and UI evidence are retained in
`.dev/manual-merge-result.json`; the original export and pre-merge backup are
retained under `.dev/`. Tracking was ineligible on the Settings page during the
operation, so accounting does not explain the changed historical records.

`CounterStorage.mergeStorage()` uses mutating `Object.assign` calls that replace
imported records with existing records and make both operands share the same
objects. Existing daily/domain values are consequently added to themselves; even
days absent from the import are doubled, and new domains in overlapping days are
lost. `counterStorage.ts` is unchanged from HEAD: this is a pre-existing defect,
not a tracking regression or an unreliable test setup.

Acceptance is stopped before reset and final validation. No production correction
for merge has been made. The dedicated dev environment is retained for reproduction;
the normal Firefox profile remains untouched.


### Authorized merge correction — automated checks passed

The user authorized correction of merge and its required integration.
`CounterStorage.mergeStorage()` now combines imported days without mutating
either input, retains days/domains absent from the import, and sends the final
merged current day to the running tracker. Settings and daily storage schema
remain unchanged. Eight added regression tests cover the original multi-day
reproduction, unchanged inputs, empty import, zero values, empty history,
historical-only import, rejected invalid input, inherited-property domain names,
and subsequent background accounting/persistence (some checks share a test).

All 70 tests passed; both typechecks and production build passed (existing eight
warnings). `git diff --check` passed. The runner automatically reloaded at
12:08:36 local time; observer probes reconnected to the running extension.
Manual merge remains FAIL until the same UI operation is retested. The pre-merge
backup is prepared as `.dev/acceptance-merge-restore.json`; no normal-profile data
is involved.

Pre-merge baseline restoration through the actual overwrite UI: PASS. Stored days
returned exactly to 913/25/15/777 seconds, settings unchanged, UI reported success.
Evidence: `.dev/manual-merge-restore-result.json`. Merge retest follows.

Merge UI retest after authorized correction: PASS. All daily/domain values and
settings match the precomputed result; runtime counter message contains the
merged current day. The initial failure remains documented above.

Post-merge runtime accounting/persistence: PASS. Active example.net added seconds
and a scheduled save retained the imported audio=906s/new domain=4s, all untouched
historical days, and settings. Saved total equals the sum of domains. Evidence:
`.dev/manual-merge-persistence-result.json`.

Reset via existing empty overwrite import: storage removal PASS. All date keys
were removed, settings retained exactly, and tracker received an empty current-day
overwrite message. Actual UI reported success. Post-reset counting/save retest
follows before the reset scenario is marked complete. Evidence:
`.dev/manual-reset-result.json`.

Post-reset accounting/persistence: PASS. User activated example.com rather than
the requested example.net; both are ordinary non-media pages, so the reset check
is unaffected. Native tab/focus samples confirm attribution to actual example.com.
Saved total 24s/live 25s contain only that domain; historical days did not reappear
and settings are unchanged.


### Final validation — 2026-10-07

All performed guided focus/workspace, multiple-window, idle/media, lifecycle,
popup/settings, notification API, export, overwrite, merge, and reset scenarios
passed. The initial popup and merge failures were confirmed pre-existing defects,
corrected with explicit user authorization, and retested successfully. Natural
buffering was not encountered; no artificial network disruption was introduced.
Iframe, multiple-element, BFCache, and buffering integration evidence remains in
the earlier local Firefox validation and automated tests; those are not claimed
as new human observations. Notification smoke verifies the successful native API
call, rather than independently confirming desktop toast visibility.

Final checks: 70 tests passed across seven test files; application and test
typechecks passed; production build passed with the existing eight Sass/bundle
warnings. Final logs are `.dev/manual-final-tests.log`,
`.dev/manual-final-typecheck.log`, and `.dev/manual-final-build.log`.
Temporary observation timers/listeners were removed, observer/media fixture
processes stopped, and development-only download preferences restored.
No normal Firefox profile was used or modified. No commit was created.

`git diff --check`: PASS. The repository runner stopped successfully and status
confirmed stopped; the isolated development profile and evidence files are retained
under ignored `.dev/`. Changes remain uncommitted for user approval.


## Independent cold-review follow-up

The completed guided acceptance above describes the earlier build. The independent
cold review then identified additional production and tooling defects; its fixes
retain the approved tracking architecture and daily data/settings contracts.

- Firefox minimum is raised to 153 after a full API audit (see TRACKING.md).
  Unsupported tabs.onReplaced is optional; a regression verifies startup without it.
- Rejected active-tab resolution recovers on the existing 1s cadence, with guarded
  focus/tab generations and no tick credited during resolution. Tests cover the
  exact same-tab recovery, single-flight retry, focus loss, and stale tab results.
- Recursively nested open shadow roots are scanned/observed; roots attached to
  existing hosts are discovered within 1s. Closed roots remain explicitly out of
  scope. Tests cover initial video/audio, dynamic media/root creation, identity
  during buffered light/shadow moves, removal, nested host removal, closed roots,
  and full pagehide/BFCache observer/listener/timer cleanup.
- A deterministic pre-fix test reproduced permanent handshake rejection after one
  failed current-document sendMessage. The same live port now gets at most three
  guarded retries (1/2/4s). Tests cover recovery, exhaustion, disconnect/navigation
  cancellation, and a newer owner superseding an old retry.
- CounterStorage.set awaits the actual browser write. Rejected/delayed helper writes
  and rejection handling/recovery at the next 15s persistence cadence are tested.
- Vitest 3/jsdom 26/Vite 6 replace the Node-incompatible test stack. Vite is overridden
  across its consumers; Rollup 4.59 avoids newer native Node22.20 requirements.
  Existing TypeScript 5.2.2, Sass 1.66.1, and Node typings 20.5.6 are restored/pinned.
  The complete existing web-ext linter chain requires Node ^22.13.0 || >=24.0.0,
  now documented and declared. Test dependencies do not raise that floor.

Targeted real Firefox 157 checks passed in the runner's dedicated development
profile. With the first native current-document request deliberately rejected,
the live content script sent exactly one hello and recovered via a fresh snapshot
about 1s later. Real unmuted positive-volume audio was observed in nested open
roots, then in a root attached later to an existing host without a light-DOM
mutation. Moving the original element light→shadow retained its identity;
removal cleared both IDs. Fixture tab closure was performed through native tabs
API. No production test hook was introduced. Runtime evidence is ignored at
`.dev/cold-runtime-result.json`. Temporary autoplay changes apply only to the dev
profile and are restored during cleanup. Focus/accounting retry races and storage
failures are covered deterministically in automated tests; this targeted run does
not claim a new human focus/workspace acceptance pass.

### Separate logical changes retained for future commits

The earlier user-authorized Other/merge corrections are **not requirements of the
tracking implementation**. Their work is preserved and must be committed separately:

1. Tracking: background/awake/media/state/types/manifest, the CounterStorage.set
   await hunk, tracking/persistence/compatibility tests, tooling and tracking docs.
2. Popup Other arithmetic: counter.ts mostUsed hunk and tests/counter.test.ts.
3. Import merge arithmetic: counterStorage.ts mergeStorage hunk,
   tests/counterStorage.test.ts, and the isolated post-merge accounting integration
   test in tests/background.test.ts. Stage the latter two shared production/test
   files by hunks rather than including merge in tracking.

No work was reverted, staged, or committed. Independent follow-up review and final
validation results follow below.


### Cold-review follow-up final validation

Exactly one new read-only reviewer inspected these fixes and independently passed
88 tests, both typechecks, and diff-check. It found no confirmed new defect.
Its non-blocking concern is unmeasured full-DOM discovery cost on large dynamic
pages and frames; no speculative architecture/performance change was made.

A final concurrent build/test run exposed a 5s cold-import test timeout under CPU
contention, with no failed production assertion. Test workers are now capped at
two; assertions, isolation, and timeouts are unchanged. The same reviewer checked
that small tooling follow-up and found no regression. The full suite subsequently
passed all 88 tests across nine files. Application/test typechecks and production
build passed; restoring original Sass reduced warnings to the three existing
bundle-size/performance warnings. Lower-bound Node 22.13.0 separately passed the
88-test suite, both typechecks, and production build. Runtime targeted checks and
API audit are recorded above. A clean npm ci was used after lockfile resolution.

TypeScript and Sass were unintentionally upgraded by the earlier broad dependency
resolution, not required by tracking. Their original versions are restored and
pinned. Remaining shared transitive upgrades are required by the added test stack
(e.g. Vite requires newer postcss/es-module-lexer, jsdom requires punycode ^2.3.1);
full consumer/range evidence is ignored in `.dev/cold-lock-audit.json`.

Runtime probes/fixture were stopped, the original dev-only autoplay preference
restored, and the repo runner stopped successfully. The dev profile/evidence remain
under ignored `.dev/`; normal Firefox was not used or modified. The saved guided
manual acceptance remains historical evidence for unchanged business rules, not
an assertion that all those human scenarios were repeated after these narrow fixes.
Other/merge remain separate logical changes as documented above. Nothing is staged
or committed. Final repeat logs: `.dev/cold-final-tests.log`,
`.dev/cold-final-typecheck.log`, `.dev/cold-final-build.log`.


## Final handshake race correction

A later independent review confirmed a combined ordering not covered by the
previous recovery tests: current hello starts validation; delayed old hello advances
the shared frame generation; old validation rejects and owns the only retry timer;
old disconnect cancels that timer; current validation succeeds but is discarded
as stale. The current port stays live/unaccepted with no retry, and its media
updates cannot qualify. A deterministic regression was added **before changing
production code** and reproduced all these conditions, failing on the required
eventual current acceptance. Pre-fix evidence is ignored at
`.dev/handshake-race-before-fix-test.log`.

Recovery now belongs to a frame's eligible live unaccepted candidate set rather
than an initiating connection. The single frame timer retains the lifecycle/frame
validation generations, retired-document policy, and existing bounded 1/2/4s
retry chain. Disconnect removes only its own candidate; it cancels the timer only
when no eligible unaccepted candidate remains. Every acceptance still requires a
successful native current-token response matching a live Firefox sender-identified
port. The content-side single hello/port lifecycle is unchanged.

The regression now verifies old disconnect preserves recovery, current acceptance
occurs exactly once, old messages/disconnect cannot restore stale media, and only
accepted current snapshots qualify. Additional cases cover navigation/current
disconnect before recovery, cancellation of in-flight retry results after replacement,
and exhaustion after exactly three retries with no timer/retry left. The existing
disconnect test now explicitly closes its previously exhausted candidate before
checking dead-only recovery cancellation; live candidates must no longer be abandoned.

Only background.ts, tests/background.test.ts, TRACKING.md, and this acceptance
record are changed by this follow-up. Daily schema, settings, business decisions,
content-side hello/media lifecycle, Other/merge, and tooling remain untouched.
Validation and the focused read-only review results follow below.


Focused independent read-only review: exactly one new reviewer inspected only
handshake ownership/retry races and found no confirmed issue. It independently
passed all 43 background integration tests and diff-check, verified the pre-fix
failure evidence, frame-candidate recovery, token/generation guards, cancellation,
and unchanged bounded retry chain. No reviewer edits or further production fixes
were needed. Full post-review validation results are recorded below.

Post-review validation: PASS. The exact regression alone passes; the full suite
passes **94 tests in nine files**. Application and test typechecks each pass.
Production build passes with the three existing bundle-size/performance warnings.
`git diff --check` passes, and a before/after hash check confirms only the intended
background implementation and tests changed among production/test/public/skill
files; the only other follow-up edits are these two tracking documents. Existing
uncommitted Other/merge/tooling work is preserved. No files were staged or committed.
Final logs are ignored under `.dev/handshake-race-final-*.log`.
