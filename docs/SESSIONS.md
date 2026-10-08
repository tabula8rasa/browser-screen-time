# Session history design

Status: implementation contract, 2026-10-07. Autonomous MVP authorization supersedes earlier approval-only scope notes; production implementation and validation are tracked below. This document specifies the next local session-history milestone; the reviewed tracking engine remains stable infrastructure. Earlier historical implementation notes in TRACKING.md and TRACKING_ACCEPTANCE.md are not instructions to rebuild that engine.

## 1. Goals, boundaries, and repository baseline

Record the hostname and exact observed start/end of each continuous effective tracked period, in chronological order, including factual gaps. Preserve existing daily aggregates independently in `browser.storage.local`; add normalized detailed history in IndexedDB. Support future Day Timeline and zoom without changing raw records for presentation.

Non-goals: tracking-policy changes, elapsed-time counter redesign, fixing aggregate date rollover, migrating aggregates, reconstructing old sessions, dashboard/Timeline/Pomodoro/UI implementation, smoothing, backend, synchronization, visits, live popup updates, and committing this design.

Inspected: AGENTS.md, docs/MVP.md, docs/TRACKING.md, docs/TRACKING_ACCEPTANCE.md; background.ts, trackingState.ts, awake.ts, videoCheck.ts, types.ts; counter.ts, counterStorage.ts, domainTime.ts, utils.ts, settingsStorage.ts, components/settings.tsx; manifest, webpack, package/lockfile configuration and existing test harness/replacement tests.

Current facts affecting this design:

- `trackingTab(state, media)` is the one eligibility interpreter; `background.ts/recalculate()` assigns `effectiveTab`. Focus/tab/document generations reject stale API responses.
- The existing tracker conservatively invalidates the active tab to STOP before asynchronous resolution on activation, focus, and navigation. These intervals are factual **observed decision gaps**, even on the same hostname.
- The counter validates the tab on its one-second cadence, adds exactly +1 second, and persists on the existing gated 15-second cadence. Its rollover compares day-of-month only; sessions must not reuse it.
- `counter:replace` is already background-owned, serialized, drains pending daily saves and blocks counting during replacement. Empty legacy overwrite `{}` is the current reset path; there is no dedicated reset button. Legacy `counter` messages replace in-memory daily state, not all stored history.
- Daily JSON is the unwrapped `YYYY M D → CounterDailyData` map, including colors. Settings are excluded from export and preserved on data reset. `getSavedKeys()` currently excludes only `settings`; explicit valid-date filtering remains desirable for data operations, but the corrected replacement intent lives only in IDB metadata, not storage.local.
- Manifest V3 uses Firefox background scripts, minimum Firefox 153, with storage/idle/tabs/notifications permissions. Webpack has background/popup/info/videoCheck entries; Vitest uses Node, jsdom for DOM tests, and two workers.

## 2. Authority and integration boundary

```text
trackingTab(state, media) → recalculate() → effective hostname / STOP
                                          ├→ session observer → IndexedDB
                                          └→ existing daily counter (unchanged)
```

Publish a synchronous immutable observation **after assigning effectiveTab and before the icon early return**, including the complete capture-local calendar snapshot defined in section 4. Normalize only through `new URL(effectiveTab.url).hostname`, exactly as accounting does; no registrable-domain grouping, scheme grouping, or media-based attribution. Do not modify `trackingTab`, its inputs, existing generation checks, icon behavior, or content scripts.

The observer receives every recalculation but emits lifecycle work only for changed effective hostname/STOP, plus explicitly labeled maintenance samples. It never queries focus/tabs/media to independently decide eligibility. Tab ID, path, query, protocol, and window changes without a hostname change or observed STOP do not independently split a session.

Accounting's tab validation can itself recalculate the decision; that publication is valid. The +1 increment is not the session source. Sessions can start before counter initialization completes, if the existing effective decision is already TRACK. Session errors must be caught at the observer boundary and never escape into `recalculate()`.

On attaching/recovering storage, explicitly obtain the latest effective snapshot from this same publisher; do not wait for a changed event that may never arrive. Unknown startup focus/idle/tab state remains STOP as it does today.

## 3. Session state machine and exact transitions

Logical states: STOP or TRACK(hostname). Storage additionally has unavailable/recovering/recording/fenced states; storage availability is not a second tracking decision.

Normal transitions at captured timestamp `t`:

| Previous | Observation | Stored action | New state |
|---|---|---|---|
| STOP | STOP | None | STOP |
| STOP | TRACK(A) | Open A at t, initial safe end=t | TRACK(A) |
| TRACK(A) | STOP | Close A at t; remove open pointer | STOP |
| TRACK(A) | TRACK(B), A≠B | Close A at t and open B at t in one transaction | TRACK(B) |
| TRACK(A) | TRACK(A) | Keep same session; no transition write | TRACK(A) |
| STOP after A | later TRACK(A) | Open a new A record; never join across STOP | TRACK(A) |

All stored intervals are half-open `[start,end)`. Equal timestamps are possible due to clock precision; process observations in sequence order. Drop a zero-duration record when finalized, but an open provisional `start=end` is permitted and excluded from positive-interval queries. No minimum duration filter, short-gap filling, or same-domain rejoining.

Example: A 10:00:00–10:08:31; B 10:08:31–10:15:04; gap to 10:18:20; new B from 10:18:20. Direct A→B shares the exact boundary. Existing browser integration may instead produce A→STOP→B with async lookup latency between the boundaries. Store that gap. Midnight, clock discontinuity, observation loss, reset/import and storage recovery are explicit segment/coverage boundaries, even if the effective domain stays A.

## 4. Timestamp and continuity semantics

Use integer Unix milliseconds from `Date.now()` captured synchronously at publication/maintenance callback entry, before queueing or awaiting storage. Never timestamp with transaction completion time or content-script clocks. Millisecond representation does not imply millisecond physical precision: browser events and timers can be delayed, and Date.now precision can be reduced. History describes observed decisions, not unknowable OS event instants.

Every relevant publication, maintenance sample, checkpoint/export barrier and fresh recovery snapshot captures the following **synchronously before queueing**:

```ts
interface CalendarIdentity {
  readonly timeZone: string;
  readonly dayKey: string;
  readonly dayStart: number;
  readonly dayEnd: number;
}
interface SessionObservation extends CalendarIdentity {
  readonly wallTimestamp: number;
  readonly monotonicTimestamp: number;
  readonly sequence: number;
  readonly historyGeneration: number;
  readonly decision: { kind: 'stop' } | { kind: 'track'; domain: string };
}
```

Calendar construction and validation happen in that same synchronous capture. Retain the previous reliable snapshot and construct any crossed-midnight segment plan synchronously from the two snapshots. Queue immutable identities/boundaries with the operation. The queue must not call local Date getters/constructors or consult the current system timezone to reinterpret an old observation. A captured A-zone operation delayed behind IDB retains A's dayKey/day bounds even if execution happens in zone B. If zone identity changes during capture (read it before and after the calendar calculation), reject that sample and take at most one fresh synchronous sample; if still unstable drop it and mark observation loss, never enqueue a mixed-zone snapshot.

Use paired `performance.now()` samples only in memory to detect discontinuities; do not persist it as historical time or replace Date.now with `timeOrigin + now`. Wall clock can change; monotonic elapsed time and wall time serve different purposes. Firefox/platform sleep behavior also prevents using performance.now alone as proof of continuous observation. See [MDN performance.now](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now).

Proposed conservative policy:

- Independent memory-only maintenance observation every 1 second while background is alive. Read the cached authoritative effective decision, wall/monotonic timestamps and complete immutable calendar snapshot. No per-second database record/write.
- Continuity is accepted only when consecutive wall and monotonic deltas are nonnegative, neither exceeds **5,000ms**, their difference is at most **2,000ms**, and the timezone identity is unchanged. These thresholds detect suspension/large delays, not perfect clock accuracy; smaller changes are indistinguishable from noise.
- On a discontinuity, do not extend through the unobserved interval. Close to the last reliable in-memory observation if it belongs to the persisted open segment and its queued prefix is valid; after a crash use only the persisted safe end. Reopen at the current observation only if TRACK and timestamps satisfy the ordering floor. Record a coverage gap/reason, never interpolate through sleep or a clock jump.
- Maintain a persisted `lastEnd` high-water mark. The recording floor for both sessions and STOP coverage is `max(lastEnd, lastObservedAt)`, so a STOP-only rollback cannot overlap prior observed windows. If wall clock moves backward below it, close at the previous safe observation and suspend session recording until Date.now ≥ lastEnd; then open a new session from a fresh effective snapshot. Daily accounting continues. This deliberately loses some history rather than storing negative or overlapping intervals with falsified wall timestamps.
- Apply this floor after restart and import too. A forward jump creates a gap; a multi-hour delayed STOP does not close a session at the delayed callback time. First run continuity validation, then apply STOP.

The high-water mark includes imported session ends, but not daily aggregate dates. A far-future imported end can therefore suppress new history; validation must reject ends later than import snapshot time (allow 2 seconds of precision tolerance), with no silent timestamp edits. Significant wrong-clock history remains a diagnostic/recovery issue, not fabricated activity.

Ordinary callbacks observed within the continuity window use their captured boundary, even if disk work is delayed. No detector can discover every small clock correction or precise sleep onset. The 5s/2s policy is an explicit conservative design default requiring acceptance measurement, not a new tracking policy.

## 5. Local calendar days, midnight, timezone and DST

Store capture-local day identity and its actual epoch bounds with every segment. `dayKey` is `YYYY-MM-DD`, distinct from legacy aggregate keys. Capture `Intl.DateTimeFormat().resolvedOptions().timeZone` at observation time. Freeze historical grouping; changing the user's timezone later never rewrites earlier sessions.

Synchronously at capture, for the current device zone, construct local start of date and start of next date with calendar operations (`new Date(y,m,d)` and `new Date(y,m,d+1)`), never add 86,400,000ms. Verify `dayStart <= t < dayEnd` and strict increasing bounds; reject/log unsupported calendar results. Nonexistent midnight uses the platform Date-compatible first valid local instant; skipped calendar dates have no bucket. Store bounds so future queries do not have to reconstruct old timezone rules. DST may produce 23/25-hour days and repeated wall labels; UTC timestamps preserve order. An offset change due to DST alone is not a timezone-identity change. See [MDN Date local timezone semantics](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date) and [local calendar/DST behavior](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/setHours).

When a reliable extension from last observation to `t` crosses the recorded dayEnd, split exactly there, closing the previous record and opening the next at the same timestamp, atomically. Use the immutable split plan captured before queueing: the old snapshot supplies the prior dayEnd and the new snapshot supplies the new calendar identity. If a continuous observation pair needs intermediate calendar identities, resolve them synchronously at capture, not in the IDB queue. If a trustworthy plan cannot be produced, mark observation loss rather than guessing. Never use the queue-time system zone for a split. Both session segments and observed coverage windows satisfy `dayStart <= start <= end <= dayEnd`. A STOP exactly at dayEnd closes the old day and opens nothing; TRACK from STOP exactly at dayEnd opens only in the new day. No zero-length finalized midnight artifact.

Schedule a best-effort timeout for next local midnight, but **every** transition/checkpoint/maintenance path runs the split check. If callback arrives 2s late with maintained continuity, its transaction can materialize the exact midnight boundary. If it arrives hours late after sleep/unload, truncate at the safe observation and restart now; do not fill nights by retrospective splitting. Crash recovery never extends a checkpoint to midnight.

Firefox provides no general WebExtension timezone-change event. Detect zone changes at each observation. Close the session and coverage window at the last reliable captured observation in the old zone, leave the uncertain interval as a gap, and open new coverage plus an eligible session under the new snapshot at detection time. A timezone change therefore creates a coverage calendar boundary even while STOP. Already queued old-zone operations retain their old identities and execute in order before this boundary. Do not assume when within the gap the zone changed. Date keys may repeat or go backward on travel; physical UTC intervals must still not overlap. Day queries return capture-local buckets, potentially with multiple zone/bounds groups; future UI must label those groups rather than pretend all share one 24h axis. Same-zone DST groups normally share one day's captured bounds.

## 6. IndexedDB schema and versioning

Database: `browser-screen-time-sessions`, initial version **1**, extension background origin only. No new permission or webpack entry expected. Keep all mutations background-owned; future UI reads request background snapshots so fencing and health status are consistently enforced.

```ts
interface DomainRecord { id: number; domain: string }
interface SessionRecord {
  id: number; domainId: number;
  start: number; end: number; // finite Unix ms; end is committed safe endpoint
  dayKey: string; timeZone: string;
  dayStart: number; dayEnd: number;
}
interface OpenState {
  key: 'open'; sessionId: number;
  ownerRunId: string; generation: number;
  lastSequence: number;
}
interface ControlState {
  key: 'control'; ownerRunId: string; generation: number; lastEnd: number;
  lastObservedAt: number; // committed coverage watermark, including STOP
  recordingSince: number;
}
interface CoverageRecord {
  id: number; start: number; end: number;
  reason: 'storage-unavailable' | 'observation-gap' | 'clock-change'
        | 'timezone-change' | 'restart' | 'legacy-merge';
}
interface ObservedWindow extends CalendarIdentity {
  key: string; // observed:<unique ID>
  start: number; end: number; // finite reliable observation coverage, STOP included
}
// CoverageRecord export IDs map to metadata wrappers { key: 'gap:<id>', ...record }.
// Day invalidation uses { key: 'invalid-day:<YYYY-MM-DD>', dayKey, reason }.
// metadata also holds ObservedWindow records and feature availability origin.
// Do not confuse observation coverage or unknown gaps with tracked sessions.
```

Coverage records describe known unavailable/uncertain ranges, not eligibility. ObservedWindow records prove a finite continuous reliable observation window even while STOP; they are updated on the same 30s coverage checkpoint cadence, including while STOP, and atomically with lifecycle writes where applicable. Control.lastObservedAt is the latest committed observation watermark. No per-second coverage rows. Start a new window after each restart/discontinuity/failure/replacement; recovery never extends its finite end. Unknown startup/restart tails begin at the watermark even when there is no open session. Aggregate-only dates before recordingSince mean detail unavailable. A query can report partial/unavailable; an empty sessions array alone must never imply verified zero usage. A complete day requires proven observed-window coverage of its entire captured day bounds, with no unknown gap or day invalidation; otherwise return partial/unavailable. A current day is at most covered through its safe watermark. Import/export observed windows and invalid-day markers along with gaps; recordingSince alone never proves completeness. Coverage is split at captured midnight and every detected timezone boundary, with the same immutable calendar plans as sessions, even while STOP. A verified zero-activity day is an exact `(dayKey,timeZone,dayStart,dayEnd)` group fully covered by observed windows and containing no positive session. A later timezone change does not move this evidence into a different day. Day queries enumerate coverage groups even if the session query returns no rows; inspect the existing metadata store, with no new store/index needed. Export/import must preserve all four calendar fields and each observed start/end, and validate bounds without reinterpreting them in the import device zone. For pre-feature imports and legacy merge, record coverage invalidation per affected day. Ordinary STOP gaps are inferred between sessions; they need no one-per-gap database row.

```ts
// onupgradeneeded, v0 → v1:
const domains = db.createObjectStore('domains', { keyPath: 'id', autoIncrement: true });
domains.createIndex('byDomain', 'domain', { unique: true });
const sessions = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
sessions.createIndex('byDayStart', ['dayKey', 'start']);
sessions.createIndex('byStart', 'start');
sessions.createIndex('byEnd', 'end');
sessions.createIndex('byDomainStart', ['domainId', 'start']);
db.createObjectStore('metadata', { keyPath: 'key' });
```

No redundant duration column, null end, per-second samples, full hostname in session rows, or stored smoothing. Extra calendar fields solve real timezone/day-query ambiguity.

Upgrade by ordered `oldVersion < N` schema steps exclusively inside the versionchange transaction. A rejected migration aborts atomically; never delete/recreate automatically. Close connections on `versionchange`; handle blocked upgrades with logged unavailable status and bounded retry. Reject a newer unsupported DB version. Migration validation must not perform unrelated asynchronous awaits inside the upgrade transaction. Any future large data transformation needs an explicit resumable migration plan, not silent partial use of incompatible schema.

Initialization/recovery runs independently of tracking/counter startup. If unavailable, daily tracking continues; history stays unavailable, with capped retries at 1/5/30/60s while alive and fresh initialization on restart. No infinite queue of past events: initialization has no backfill. Once ready, capture a fresh effective observation and open now. Record the missed coverage interval where possible. Do not upgrade the database in content scripts or the popup.

## 7. Domain dictionary and transaction rules

`id` is an auto-increment numeric primary key; `byDomain` is a unique string index. Lookup then add in a single readwrite transaction whose scope includes domains. All lifecycle transitions scope domains/sessions/metadata together; overlapping readwrite transactions serialize. A second request for the same hostname sees the first committed row. An unexpected ConstraintError aborts the full transition, then retry a fresh transaction after lookup, at most once before treating history as failed.

Use Map for in-memory caches and ID remapping; never `{}` as a hostname dictionary. `constructor`, `__proto__`, `toString`, IP addresses and other strings accepted by the tracker remain normal string index keys. Cache only committed domain IDs; clear caches on generation replacement/reopen. Imports validate nonempty normalized hostname strings against the same URL hostname representation, numeric IDs, no duplicate hostname or dangling reference; do not silently merge semantically different hostname spellings. Remap imported domain and session IDs to fresh local IDs. Foreign keys are application-validated because IndexedDB does not enforce them.

Create transactions only when their queued operation is ready. Queue requests through request callbacks/IDB-specific promise handling while the transaction is active; never await tabs/storage.local/timers/network in it. Request success is not commit: advance committed state only on transaction `complete`; on abort discard all tentative IDs/state. [IndexedDB transaction lifetime](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction) and [transaction scheduling](https://www.w3.org/TR/IndexedDB-3/#transaction-scheduling) are the governing semantics.

## 8. Open session representation, checkpoint and crash recovery

Choose **A: finite mutable end in sessions plus an open pointer in metadata**. Initial open row has end=start. Every successful checkpoint advances that same row's safe end; transitions finalize it and update/remove the pointer atomically. Final and open rows use identical safe range queries. An open row is explicitly identified by the pointer, never guessed from the greatest ID or a null end.

Compared with a separate full open-session record (B), this avoids unioning different stores for timeline/export and transactional final-row creation at every close. End-index updates add write cost but are modest. Pure metadata/WAL lifecycle logging (C) adds replay/compaction complexity without a need here. OpenState remains small coordination metadata, not a duplicate interval.

Default session checkpoint: **30 seconds** of observed continuous TRACK, independent from daily +1/persistence, plus immediate writes at opening, effective transitions, midnight, and intentional replacement/export snapshot. Checkpoint captures the boundary when requested, never after an IDB await. An unchanged same-domain recalculation does not force a checkpoint. Coverage checkpoints also run every 30s while reliably observing STOP, without creating session rows. At most one pending checkpoint; coalesce a newer checkpoint only if no transition/generation barrier is crossed.

In normal timely operation a process crash loses up to roughly 30s since the last successful checkpoint, plus queue/commit latency. This is **not a hard bound**: failed writes, event-loop delay, suspension and power-loss durability can lose more. Never claim reliable per-30s writes while the background is unloaded. Firefox MV3 backgrounds are non-persistent; timer callbacks cannot wake an unloaded page. Alarms would only provide best-effort wakeups, not observation during absence, and are unnecessary for correctness in this design. See [Firefox background lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts).

On every new background run, before accepting history writes:

1. Reconcile any replacement intent (section 10).
2. In one transaction read open/control, validate pointer/domain/bounds, and remove the open pointer. The row keeps its last **committed** finite end. Delete it if zero duration. Never set end to restart time.
3. Persist current writer ownership/run ID and generation. Keep the lastEnd floor. Corrupt metadata disables history rather than guessing a recovery endpoint.
4. After recovery completes obtain a fresh authoritative effective snapshot; start a new session now if TRACK and continuity/time floor permit. No inference from old host or old focus. Mark the intervening detail gap as restart/unknown.

Firefox crash, process kill, shutdown, extension reload, machine shutdown and background suspension/recreation use this same path. A shutdown callback is an optional optimization, never a correctness prerequisite. Request standard `durability: 'strict'` for history writes where supported, verify Firefox behavior, and fall back explicitly with logged weaker durability if unsupported; avoid experimental `readwriteflush`. Standard transaction completion is not an absolute power-loss guarantee. Recover whatever consistent committed checkpoint survives, not an assumed checkpoint. See [durability options](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction).

## 9. Async ordering and race strategy

Synchronously number observations; copy domain/STOP, wall/mono samples and complete CalendarIdentity/split plan and current history generation before any await. Maintain an ordered single-writer queue and a synchronous desired state separately from last committed state. Never drop meaningful intermediate transitions just because a newer decision exists. A→B→C is three ordered operations even if B lasts 1ms. Start/end timestamps are observation-time values, not commit times.

Each transaction verifies persisted ownerRunId/generation against its operation. This prevents an older background writer from mutating a new run/replacement generation; startup itself claims ownership in a metadata-scoped serialized transaction. Monotone queue sequence and lastEnd checks reject stale operations. Session events do not await storage from Firefox callbacks.

| Race | Required handling |
|---|---|
| A→STOP→A while first write delayed | Persist close and new open in sequence; never join |
| Same-host URL/tab change | Same domain with no STOP keeps open; actual invalidation STOP splits |
| Focus/idle STOP during write | STOP enqueued synchronously; queued open cannot extend past its boundary |
| Checkpoint vs transition | Queue order governs; stale checkpoint cannot update successor session ID |
| Midnight vs transition | One shared splitting helper inside lifecycle transaction; STOP at midnight creates no new row |
| Delayed initialization | Continue daily tracking, discard pre-ready history; fresh snapshot after recovery |
| Old tab/focus lookup result | Existing tracker generations reject it; observer adds no alternative lookup |
| Restart during transaction | Atomic committed prefix or aborted transaction; recover finite end only |
| Reset vs pending work | Synchronous fence/generation invalidation; bounded history drain before intent/clear; timeout rejects replacement and releases daily gate, history remains quarantined |
| Multiple replacements | Existing serialized background queue; do not resume sessions between queued replacements |

Bound queue to **1,000 pending meaningful operations or 60s age**, whichever comes first. If exceeded, or an IDB operation has not settled within 10s, enter history-unavailable mode, stop queueing, invalidate generation, abort the active transaction where possible, and recover after it actually settles. Timeout alone must not launch another writer against an unknown commit. A committed prefix may survive; recovery keeps its safe checkpoint. Resume fresh after drain/recovery, with a gap. Daily tracking is never blocked by ordinary history I/O. No unbounded in-memory replay/WAL.

## 10. Reset, overwrite, merge, export and cross-storage recovery

All operations use the existing background `counter:replace` coordination, extended to history. UI sends validated requests and awaits acknowledgment. Settings remain unchanged by a data reset. Full reset removes all daily date keys, sessions, domains, open state and old coverage/control; initialize fresh empty control afterward. Resetting IDB auto-increment counters is unnecessary. Legacy in-memory `counter` notifications must not clear history; direct destructive writes outside the coordinator are forbidden.

### Bounded preparation and backend-independent replacement intent

IndexedDB and storage.local have **no shared atomic transaction**. The corrected design uses a pending intent in the existing IDB metadata store and explicit partial-result recovery. It does **not** use a local prepared/dailyCommitted marker, stage a replayable daily target, require runtime backend detection, or replay destructive daily writes after interruption.

```ts
interface ReplacementIntent {
  key: 'replacement'; operationId: string;
  kind: 'reset' | 'overwrite' | 'legacy-merge';
  affectedDayKeys: string[]; // capture-local YYYY-MM-DD for merge
  beganAt: number;
  recovery: 'discard-affected-detail';
}
```

Full reset/overwrite invalidates all history, domains, open state and prior coverage; legacy merge invalidates only affected day buckets/coverage and retains the dictionary and unaffected sessions. No imported open state survives. Import payload/complete daily target belongs to the live request, not a recovery WAL. A failure after preparation may discard detailed history even if daily replacement fails: this is explicit partial failure, not rollback or success.

1. Validate the request statically. Enter the existing daily replacement gate and a separate history fence synchronously. Retire the history observer generation and discard unstarted old operations. Drain relevant **daily** saves using the existing coordinator before inspecting/mutating daily data. Then allow **at most 10 seconds total** for history preflight/drain/open checks, including an existing history operation's remaining wait. No intent, IDB clear/delete/install or daily replacement write is started yet. Abort an old history transaction where possible, but an abort request is not settlement.
2. If history settles safely, read committed daily data and materialize/validate the complete live target (merge uses this post-drain snapshot). If history remains hung/unknown or checks fail, **reject explicitly**, leave daily date keys unchanged, prepare no intent, and release this request's daily gate in `finally`. Preserve the existing live counter and unsaved seconds on this pre-mutation failure; the generic replacement-error reload must not discard it. No backfill. Independently queued requests retain their own gates, but each fails history preflight within its own bound rather than waiting forever.
3. On timeout keep history fenced/unavailable and retain outstanding transaction/request outcome. Do not start a second history writer, ownership claim, recovery transaction or deleteDatabase while that outcome is unknown. Late callbacks cannot release the fence, publish open state, revive the old generation/cache, queue writes or re-enable the observer. A submitted old transaction may commit its reliable prefix, but it remains hidden until confirmed settlement and safe new-generation recovery. A late IDB connection is closed, not adopted. This is not successful reset or resurrected live history.
4. After safe preflight, in **one IDB transaction** persist ReplacementIntent, invalidate/clear the affected history and coverage, clear open ownership and retire the persisted generation. The intent and invalidation are atomic. Wait at most 10s for confirmed completion **before any local daily mutation**. If this transaction hangs/aborts, reject, release the daily gate unchanged and keep unknown history quarantined; if a late commit survives it is handled as pending intent, not permission to run the canceled request. IDB metadata preparation capacity/quota failures reject safely.
5. Only after intent preparation is confirmed, run the existing daily remove/set operation using the live materialized target. Release the daily gate after the local phase settles and reload actual stored data after partial local failure. The daily phase never awaits subsequent IDB finalization. On local success, a single IDB transaction installs validated imported detail (or fresh control/coverage for reset/legacy overwrite/merge), removes the intent and commits the new generation. No imported detail is published before both local acknowledgment and this final transaction's completion. Its history wait is also bounded by 10s: timeout reports partial/recovery-pending failure, keeps history fenced and never starts a competing writer. Subsequent daily +1 ticks/saves continue.
6. On any restart or failure with a pending intent, **never replay remove/set, overwrite or additive merge against daily storage**. Reload/use the actual saved daily state, even if it is the old target, a partial overwrite, or a fully installed target with newly accrued seconds. Ordinary daily initialization is independent from intent discovery/IDB recovery. After the previous history outcome is settled, transactionally clear/invalidate the intent's affected detail again, mark it unavailable, clear open ownership and remove the intent. For interrupted full imports this deliberately discards staged/imported detail rather than asserting consistency with unknown daily results; the user may retry the import. Resume history only from a fresh current observation. A pending intent rejects further destructive replacement/full export; explicit daily-only saved-data export remains available.

Full success is acknowledged only after local completion and final IDB completion. Preflight timeout is an explicit abort with unchanged daily storage and live counter. Post-preparation failure is an explicit partial result: daily tracking uses actual saved data, history is fenced until cleanup, and no dataset target is replayed. Once both phases completed, reset removes both datasets and starts fresh if eligible. History recovery itself cannot require a local destructive phase or hold the daily gate. Hung storage.local is a basic-storage failure outside this IDB-isolation promise.

### Firefox persistence investigation and protocol decision

Research on 2026-10-07 inspected Gecko source revision `9de2c06f` (2026-10-05). The IDB storage.local implementation puts all keys of one set call in one readwrite transaction, aborts on failure and awaits completion. Remove uses a separate transaction. This supports atomic target-plus-marker **on that backend**, not atomic remove+set or flush-to-disk. [Gecko ExtensionStorageIDB source](https://searchfox.org/firefox-main/source/toolkit/components/extensions/ExtensionStorageIDB.sys.mjs).

Backend selection may instead use legacy JSON storage and is private Gecko plumbing, inaccessible to ordinary WebExtensions. Version checks and fixture experiments cannot identify every user's backend. Ordered surviving transaction-prefix behavior under power loss was not established. Therefore the original local-marker replay protocol is **superseded**, not enabled behind an unimplementable runtime check. [Gecko storage routing](https://searchfox.org/firefox-main/source/toolkit/components/extensions/parent/ext-storage.js).

The revised intent protocol does not inspect a local marker or assume multi-key atomicity: any surviving pending intent conservatively invalidates affected detail, preserves actual daily data and never replays a daily target. It tolerates partially surviving local remove/set operations as an acknowledged partial-result model. No native interruption experiments were performed in this docs-only task. The [Firefox Rust storage overview](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/webext-storage.html) describes storage.sync, not evidence for storage.local.

The remaining limit is **cross-database power-loss durability**, not local backend identification. A power failure could lose an acknowledged IDB intent/finalization independently of local data; no software journal makes two databases atomic under arbitrary disk failure. For destructive intent preparation require verified standard `durability: 'strict'` and supported Firefox interruption behavior before enabling destructive integration under supported reload/browser/process interruption recovery; ordinary session checkpoints may retain the separately documented fallback. If strict intent durability/support cannot be established, destructive history integration stays disabled pending a reviewed stronger protocol or the narrower supported reload/browser/process interruption guarantee specified here. Process/reload recovery reasoning assumes surviving committed IDB intent, never infers missing intent/history from daily totals. [IndexedDB durability semantics](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction).

### Explicit corrupt-database reset

The intent must be committed in metadata before daily mutation; a corrupt DB that cannot even persist intent therefore makes the coordinated reset fail explicitly before changing daily data. Do not advertise an automatic delete/recreate bypass that would lose the only recovery intent. A future explicit history-only delete/recreate repair is a separate user-authorized maintenance action after safe writer settlement, with no daily target replay. Routine startup, nonempty overwrite/merge and reset must never launch another deletion/open writer while a previous outcome is unknown.

### Import and merge policy

- Accept legacy daily-only JSON unchanged. Overwrite clears **all** session/domain/open/coverage history, including dates missing from the incoming map. Never synthesize intervals from totals.
- Versioned full overwrite validates sessions, referenced domains, finite integer times with **start < end** for every imported finalized session, calendar bounds, nonoverlap, and snapshot horizon before any writes. Validate exportedAt as finite integer and no later than locally captured import time plus 2s; every session/coverage/window end must be at most min(exportedAt, local import time)+2s. Reject malformed/future horizons rather than trusting a file timestamp. For available history require recordingSince to be a finite integer no later than the validated horizon; for partial/unavailable history allow null, meaning origin unknown, and never convert it to a complete-coverage claim. Missing/invalid non-null origins reject the envelope. Local recording resumes with a fresh local origin/window independent from unknown imported coverage. Remap IDs and import finite finalized intervals only; no imported live/open ownership.
- Preserve legacy additive daily merge semantics. For each incoming date, remove existing sessions in that capture-local day bucket, invalidate detailed coverage for that date, and close the current open session at the replacement barrier if affected. Resume only a new post-merge segment. Keep untouched dates' sessions; dictionary rows may remain unused until a later full reset. Exact history cannot explain imported additive totals for affected dates, so timeline is explicitly partial/unavailable there. Use the same IDB intent with affected-day invalidation; materialize the daily target only for the live request and never replay it after interruption.
- **Reject session-bearing merge for MVP before mutation.** General merge needs domain-ID remapping, stable export identities, exact duplicate detection, and a product rule for overlapping/conflicting device histories. Equal domain/start/end alone does not prove identity. Union, duration sum, and splitting overlaps can all falsify history; do not silently discard session payload while adding its daily totals. Offer full overwrite as the supported detailed-import path.

### Export format and snapshot

```ts
interface SessionExportV1 {
  format: 'browser-screen-time'; formatVersion: 1;
  exportedAt: number;
  dailyAggregates: CounterData; // exact existing daily structure and keys
  history: {
    schemaVersion: 1;
    status: 'available' | 'partial' | 'unavailable';
    recordingSince: number | null;
    domains: DomainRecord[];
    sessions: SessionRecord[]; // committed positive intervals only; start < end
    coverage: CoverageRecord[];
    observedWindows: Array<CalendarIdentity & { start: number; end: number }>;
    invalidDays: Array<{ dayKey: string; reason: 'legacy-merge' | 'legacy-import' }>;
  };
}
```

New importer accepts both this envelope and legacy maps. New full envelopes cannot be read by the old strict daily importer: backward compatibility means preserving legacy import and a daily-only export option/API, not disguising extra fields as daily date keys. Exact UI affordance for choosing export mode is a future product decision; design only here.

Export is background-owned and serialized against replacements. Snapshot daily **saved** data (preserve existing export meaning) plus a transactionally consistent history dictionary/sessions/coverage snapshot. Checkpoint an active session through a captured observation using the queue, but do not close/reopen it solely to export. Later observations remain ordered behind that barrier. Only a committed positive open interval becomes a finite finalized export interval. A provisional/open row with start===end is **omitted**, even in an immediate export before its first positive checkpoint. Preserve its calendar observation coverage separately; do not invent duration or export ownership. Export checkpoint attempts are bounded by the history timeout and a failed snapshot is reported unavailable, not awaited indefinitely; include neither live ownership nor replacement intent. Two stores need not represent the same millisecond, and timestamps/documentation must say so. If history fails, allow explicit daily-only export; full export must report unavailable history rather than claim an empty complete dataset. Do not write settings into the export.

## 11. Queries for Day Timeline and zoom

Daily query: `byDayStart` cursor over `[dayKey, 0]` through `[dayKey, Number.MAX_SAFE_INTEGER]`, inclusive, then positive-duration filter, join domains via cached Map/read transaction, sort by `(start,id)`. Stored day splitting guarantees no positive segment starts before its own captured dayStart. Returns safe persisted open end, current open marker, calendar groups and coverage/health status. Never extend a read to Date.now from the UI. This milestone does not add live popup behavior.

Arbitrary epoch overlap query `[a,b)`, a<b, in one consistent readonly transaction: scan `byStart` with `IDBKeyRange.bound(a,b,false,true)` (starts in [a,b)), plus a reverse cursor with `upperBound(a,true)` to find **at most one positive-duration predecessor** starting before a. Skip zero-duration provisional rows when seeking that predecessor. Apply `start < b && end > a` to every candidate and sort by `(start,id)`. Global nonoverlap proves no older positive interval can overlap if that predecessor cannot. Range work scales with matching starts plus a cursor seek, without scanning the entire later history. This relies on imported/finalized nonoverlap validation; never use it for arbitrary overlapping external data before validation. A provisional positive open row also respects nonoverlap. No 24h lookback is needed.

Domain filter: apply the analogous forward `[domainId,a]` through exclusive `[domainId,b]` scan and reverse predecessor seek restricted to the domain prefix on `byDomainStart`; skip zero-length rows and apply the same overlap predicate. Nonoverlap holds for each domain subset. Retain existing `byEnd` for prospective user-approved cutoff cleanup and diagnostic fallback; no new index or automatic retention. Day queries also fetch ObservedWindow calendar groups from metadata, including STOP-only groups with no sessions, and judge completeness per exact captured identity.

Timeline Top 4 comes from summing raw session `end-start` per domain within the selected day, clipping to the requested group/range if necessary. Stable tie-break by hostname. Other contains all remaining factual intervals, preserving underlying domain identity for future zoom. Coverage warning applies to incomplete days; never rank factual session rows using smoothed spans or infer missing domain rows from aggregates. Dashboard KPI/chart/donut/heatmap/comparisons continue using aggregates. Repeated DST hours need offset labels; future axis uses true day bounds, not a forced 24h duration. Travel-day multiple groups need explicit UI design before rendering.

## 12. Consistency, failure isolation, and invariants

Aggregate seconds approximate usage by fixed ticks; sessions reflect wall-clock observed decision intervals with explicit conservative gaps. Small differences arise from subsecond transitions, async lookup gaps, +1 quantization, save/checkpoint windows and event scheduling. Repeated fast switches can accumulate larger differences; crashes/sleep/clock changes/legacy imports produce partial history. There is no universal ±1-second tolerance or reconciliation requirement. Never recalculate either dataset from the other; no assertion that totals match exactly.

Failure handling:

| Failure | History behavior | Daily behavior |
|---|---|---|
| IDB absent/open/upgrade/blocked failure | Unavailable; capped retry; no backfill | Normal |
| Transaction abort/domain insertion failure | Roll back entire transition, invalidate queue, recover committed prefix | Normal |
| Checkpoint failure | Preserve last committed safe end; stop recording until recovery, leave gap | Normal |
| Quota failure | No automatic deletion; stop history, rate-limit logging, retry/manual export/reset | Normal |
| Invalid pointers/schema/corruption | Disable history, preserve evidence; no guessed endpoints/automatic recreation | Normal |
| Pre-intent history hang during replacement | Explicit rejection within 10s history budget; history quarantine, no second writer | Date keys unchanged; live counter preserved; counting/periodic saves resume |
| Post-intent history hang/partial failure | Intent/fence recovery above; bounded wait, no competing writer, failure acknowledgment | Local daily phase completes/reloads independently of IDB finalization; restart never replays targets |

Persist health/coverage when possible, keep structured in-memory diagnostic code/message/last successful checkpoint without URLs or page titles, rate-limit logs, and return health with future query/export APIs. Logging alone is insufficient to represent complete-looking missing detail. History availability is not a condition in trackingTab or the daily tick.

Required invariants:

1. Exactly one TRACK/STOP interpreter. History consumes only effective decisions.
2. At most one open pointer; every session domain reference exists.
3. Finite integer endpoints, start≤end; finalized records have start<end; no stored duration.
4. Positive intervals never overlap globally in epoch time within one local dataset, including imports. End may equal next start. Clock rollback is suppressed until the ordering floor is reached.
5. Every record belongs entirely inside its stored capture-local day bounds. Final midnight boundary is shared exactly.
6. Same-domain observations keep open; actual STOP always terminates continuity.
7. Open end never exceeds a reliable captured observation; recovery never extends it beyond committed checkpoint.
8. Committed prefix and open pointer update atomically; request success alone never advances committed memory.
9. Sequence/generation/ownership prevent stale checkpoints, old initialization and pre-reset writes from restoring history.
10. History storage failure cannot break ordinary tracking or daily accounting. User replacement is fenced but IDB failure cannot indefinitely gate recovered daily data.
11. Export/import finalized intervals have start<end; zero-duration open rows are omitted, with coverage retained separately. Raw sessions never contain smoothing, reconstructed daily totals, imported live state or inferred restart/sleep activity.
12. Legacy/partial/unavailable history is distinct from a complete observed STOP-only day; coverage retains immutable captured dayKey/timeZone/day bounds through queueing and export/import.
13. History preflight cannot indefinitely hold the daily replacement gate: before intent prepare, timeout rejects without daily mutation; unknown history outcomes stay quarantined without another writer. Daily phase is independent of history finalization; interrupted recovery never replays daily targets.

## 13. Storage activity and retention

Estimates for **8 hours of continuous recorded eligibility/day**; checkpoint 30s ≈960 checkpoints maximum. Events may include extra conservative STOPs from actual tracker resolution. Transactions, logical rows and physical SQLite writes are different quantities.

| Pattern | Approximate session rows/day | Approximate history transactions/day |
|---|---:|---:|
| Hours on video / few switches | 1–30 plus midnight segments | ~960 checkpoints + transitions |
| Switch every 5 minutes | ~96; up to ~192 with STOP gaps | ~960 plus ~100–400 transition operations |
| Switch every 5 seconds | ~5,760 sessions; transient gaps separate periods | ~5,760–11,520, checkpoint usually unnecessary before short closes |
| Switch every 2 seconds | ~14,400 sessions | ~14,400–28,800 |

Transition writes scale with effective changes, not seconds. Long video has one row per calendar segment, updated about 120 times/hour. Idle/focus STOP closes immediately and removes session checkpoint scheduling while stopped; coverage-only checkpoints continue at 30s while the background is alive (up to 120 transactions/hour), without claiming that an unloaded background was observed. Dictionary adds one row per previously unseen hostname, never per session. Midnight is two session mutations and pointer update in one transaction.

For additional reliably observed STOP hours, budget up to 120 coverage-only transactions/hour (e.g. 16 additional hours adds up to 1,920 transactions). They mutate a finite coverage window/watermark, not new sessions per checkpoint. Unloaded intervals generate no checkpoints and cannot be claimed complete.

Budget estimate **0.3–1KB per session including indexes/engine overhead**, to be measured in Firefox, not a storage guarantee: 100 rows/day ≈30–100KB/day (11–37MB/year); 5,760 ≈1.7–5.8MB/day (0.6–2.1GB/year); 14,400 ≈4.3–14.4MB/day. Mutable checkpoints change existing row/indexes, so they amplify disk/WAL writes without accumulating 960 rows/day. Domain/metadata overhead and database free space are additional. Ordinary workloads and rapid-switch extremes differ greatly.

No automatic deletion in MVP: no retention period was approved. Quota/long-term size needs measurement and future explicit policy. Do not request unlimitedStorage or promise years of extreme activity fit existing quota. Reset/export remain recovery tools; session quota failure leaves aggregate tracking functional.

## 14. Automated test plan before production implementation

Use the existing Vitest browser mock/deferred/fake-timer patterns. Add a clock/calendar adapter for deterministic wall/mono/timezone tests and an IndexedDB test adapter (e.g. pinned fake-indexeddb dev dependency, evaluated at implementation). Native Firefox tests are required for durability, origin, upgrade blocking and event-page lifecycle; fake IDB cannot establish those guarantees.

| Suite | Required cases/assertions |
|---|---|
| Pure lifecycle | STOP→A, A→STOP, A→B same boundary, A→A no reopen/write, STOP gap→new A, STOP→STOP, zero duration, stable sequence at equal timestamps |
| Clock/continuity | Boundary captured before delayed write; +/− wall jumps, negative mono, 5s threshold, 2s skew threshold; hours asleep with mono advancing AND not advancing; delayed STOP truncates safe end; rollback highwater/restart/import suppresses overlap |
| Calendar | Continuous midnight split, repeated checkpoint crossing, STOP/start exactly 00:00; month/year/leap-day rollover; 23/25h DST/repeated labels; DST offset alone not zone change; zone change, repeated capture date, midnight anomaly/skipped date; A-zone observation delayed behind IDB then device becomes B still stores A bounds; delayed midnight while continuous vs unobserved sleep |
| Recovery | Open + checkpoint at c, restart 8h later keeps end=c; no new state until fresh engine decision; uncommitted checkpoint aborted; finalized zero row cleanup; missing/dangling pointer disables history; lastEnd floor persists |
| Queue/races | rapid A→B→C; A→STOP→A; delayed/aborted IDB transaction; checkpoint vs transition; reset vs delayed save; midnight vs transition; startup observer/DB readiness; old owner after new run; overload/timeout with unknown commit; rejected queue does not poison next recovery; STOP-only crash coverage watermark |
| Dictionary/storage | Single domain for concurrent creations, unexpected unique abort/retry, prototype-like names and IPs; dangling references rejected; transaction complete vs request success; schema v0→1, aborted upgrade, blocked/versionchange, unsupported newer version |
| Coverage | Full STOP-only day with complete bounds coverage produces verified zero, later zone change retains original identity; midnight/zone split without sessions; export/import roundtrip preserves all calendar fields and zero evidence |
| Queries | In-range starts plus predecessor, a inside long interval; no overlap returns empty; domain subset predecessor; skip provisional zero row; end=a/start=b excluded; no full-future scan; Day bucket with end=dayEnd, open end=start excluded; overlap predecessor beginning before a; end=a/start=b excluded; DST/travel groups; domain/range filtering; exact totals/Other/ties from raw data; query status distinguishes empty from unavailable |
| Hung replacement | Never-settling history transaction during reset: explicit timeout rejection, unchanged daily keys and live counter, counting and periodic persistence resume; late old completion cannot reacquire/publish ownership or enqueue work; no new writer while outcome unknown; intent-prepare hang rejects unchanged; finalization hang allows daily continuation |
| Replacement | Legacy overwrite clears all sessions/domains/open state; reset {} cannot resurrect pending work; queued replacement fences; imports remap IDs; malformed/overlapping/future sessions reject before mutation; daily-only merge clears affected detail, preserves untouched days; detailed merge rejects |
| Durable replacement | Crash before intent, during intent/invalidation tx, after intent before daily remove, after remove before set, after local success before finalization; restart always preserves actual daily values/no target replay even after new ticks; pending intent invalidates affected detail; merge never reapplied; IDB unavailable/unknown outcome never blocks daily startup or starts competing recovery; intent capacity/strict-durability acceptance; corrupt DB reset fails without local mutation |
| Export | Legacy daily-only unchanged; versioned roundtrip; immediate export after provisional open without positive checkpoint omits zero-duration row but preserves coverage; imported finalized start=end rejects; snapshot contains positive finite open safe endpoint, no owner/intent/settings; partial status, IDB failure fallback, no replacement mixture or exported intent |
| Failure isolation | Reject open/domain/checkpoint/upgrade/quota; all existing tracking decisions/+1 seconds/15s saves/notifications still work; recovery starts now, no failed-interval backfill |
| Tracking integration | Recalculate publications before unchanged-icon early return; effective TRACK opens/closes; idle STOP/focus loss closes; background media never opens; active qualifying media continues idle; muted/zero volume stops; same-host change without STOP keeps session, actual navigation invalidation STOP splits; stale lookups/media owners never publish wrong session |

Run the unchanged full regression suite, `npm run typecheck`, `npm run prod`, and diff-check after future implementation. Keep new session assertions separate from stable aggregate contracts; do not change existing expected behavior to make session tests pass.

## 15. Manual acceptance plan

Use only the runner's disposable development Firefox profile and backed-up fixture data. No production hooks/endpoints or normal-profile manipulation. Before each scenario capture IDB rows/control and daily saved values; report exact observed boundaries, health and coverage, not visual approximations. Timeline UI is not required: developer tools/read-only query output is enough.

1. Ordinary A usage → B → idle STOP → resume B: verify ordered positive intervals and real gap, same-domain recalculation does not reopen; navigation/tab invalidation gaps remain visible.
2. Foreground qualifying video/audio stays one segment through idle/checkpoints; background media cannot create one. Mute/pause/focus loss/workspace-away closes; multiple Firefox windows remain attributed only to effective domain.
3. Leave one domain tracked across real local midnight in disposable test environment: shared exact boundary, two rows/day bounds, unchanged daily behavior. Exercise controlled DST/zone settings only in disposable environment; verify historical labels do not move.
4. Kill/reload background shortly after a checkpoint; restart much later: old end equals surviving checkpoint, no gap-filled hours, fresh focus/idle decision required. Repeat Firefox process kill, normal shutdown and simulated machine-power-loss where feasible; record limitations rather than equating process kill with disk failure.
5. Observe native MV3 unload/restart with and without media ports/restricted pages; suspend/resume machine, delayed callback: conservative safe end/gap, no timer-based fabricated activity. Measure whether 1s/5s continuity defaults create unreasonable false gaps under ordinary load.
6. Delay/fail IDB and force quota/upgrade blocking in dev fixtures: daily counting/save and popup snapshot/notification behavior continue. Repair storage: new sessions start now, unavailable interval remains marked.
7. Reset while eligible and while old write is delayed: no old rows/domain/open state reappear; new eligible session starts after completion. Interrupt intent/local/finalization phases; restart preserves actual daily data, permits new daily ticks and never replays import/reset/merge; affected detail is conservatively cleared when the single history writer safely recovers.
8. Legacy overwrite/export/merge and new envelope roundtrip: settings preserved, legacy dates show detail unavailable, merge invalidates affected timeline detail, full import rejects overlaps/remaps IDs. Verify strict intent durability and process/reload/kill recovery; do not claim a power-loss guarantee from local backend/version inference. Force a never-settling preflight: reset rejects within its history budget, daily data/live counter remain intact, subsequent +1 ticks and scheduled saves resume; no second history writer starts on timeout.
9. Measure row/index footprint and checkpoint latency over sparse/rapid-switch fixtures; full day and arbitrary predecessor-overlap queries return correct ranges. No smoothing writes occur.

Record PASS/FAIL/NOT OBSERVED independently for native scenarios. The existing acceptance evidence validates unchanged tracking, not an implemented session feature.

## 16. Future implementation file plan

Exact proposed production files to **add**:

- `src/scripts/sessionTypes.ts`: persisted types, observations, query/export health.
- `src/scripts/sessionClock.ts`: injectable wall/mono clock, local calendar bounds, continuity rules.
- `src/scripts/sessionLifecycle.ts`: pure ordered transition/segment planning; no Browser APIs.
- `src/scripts/sessionStorage.ts`: IndexedDB open/versioning/transactions/dictionary/queries/recovery.
- `src/scripts/sessionHistory.ts`: observer queue, ownership/generation, checkpoints, availability.
- `src/scripts/dataTransfer.ts`: envelope validation, legacy adapters, replacement intent/replay, export snapshot coordinator.

Exact existing production files to **modify**:

- `src/scripts/background.ts`: observer publication before icon return, independent initialization/maintenance, fresh snapshots, extend existing replacement ownership; existing tracking policy and daily accounting stay intact.
- `src/scripts/counterStorage.ts`: valid daily-key filtering, legacy/full transfer request routing and background coordination; retain daily format/read arithmetic.
- `src/scripts/types.ts`: typed full-data export/replacement/query requests/responses without changing media protocols.
- `src/scripts/components/settings.tsx`: future existing import/export handlers delegate to the transfer API and report failures; no Timeline or layout work. Export-mode affordance needs separate approval.

Expected test additions: `tests/sessionLifecycle.test.ts`, `tests/sessionClock.test.ts`, `tests/sessionStorage.test.ts`, `tests/sessionHistory.test.ts`, `tests/dataTransfer.test.ts`; extend `tests/background.test.ts`, `tests/replacementPersistence.test.ts`, `tests/counterStorage.test.ts`, `tests/helpers/browserMock.ts`. `package.json`/`package-lock.json` may add a test-only IDB dependency. No expected changes to trackingState.ts, awake.ts, videoCheck.ts, counter.ts, domainTime.ts, dashboard/components, manifest, webpack entries or accounting/utils date rollover. Update docs/SESSIONS.md acceptance evidence after implementation; do not treat that as current production validation.

## 17. Unresolved decisions and implementation gates

Recommended defaults in this specification are implementable design choices, not requests to expand scope:

- 30s checkpoint; 1s observation, 5s continuity limit, 2s clock skew tolerance. Tune only on measured native scheduling behavior. Hard crash-loss bounds are impossible under suspension/write/power failures.
- Capture-local history grouping; travel days expose zone groups. Future Timeline rendering of 23/25h/repeated/travel hours needs product design, but storing exact UTC bounds is not blocked by that UI decision.
- Legacy merge invalidates detailed history only for imported day keys; detailed merge is unsupported. Confirm this restriction and daily-only export affordance before user-facing integration.
- No automatic retention. Extreme usage/quota measurement may justify a future user-approved retention/storage option.
- Conservative backward-clock suppression sacrifices history to preserve global wall ordering. Perfect history under arbitrary clock changes cannot be represented with the preferred single epoch interval model.

True implementation gates: verify Firefox event-page observation/restart behavior and IndexedDB strict-durability option/fallback. Destructive integration separately requires verified strict IDB intent durability and supported interruption guarantees as specified in section 10. The local-marker replay proposal is superseded by backend-independent preserve-actual-data recovery; no storage.local backend detection or multi-key durability prerequisite remains. Arbitrary machine-power-loss/disk-failure atomicity is not a supported guarantee: recover the consistent committed state that survives, without replaying daily writes. Supported interruption acceptance covers extension reload and browser/process restart. Ordinary session recording can proceed independently of that destructive-integration gate once approved. No new Hyprland/native helper, persistent background conversion or aggregate accounting redesign is authorized.

## 18. Independent design review

The initial-draft review below is historical. Its local-journal and corrupt-reset exception details are superseded by section 10 and the cold-review correction; current protocol is IDB intent with no daily-target replay.

Exactly two parallel read-only research/planning agents informed this draft, followed by exactly one independent read-only reviewer inspecting project instructions, MVP/tracking/session docs and relevant production code. No agent edited files.

Confirmed findings and resolutions:

1. Complete zero-usage coverage was not provable while STOP: added finite observed windows, committed STOP watermark, 30s coverage-only checkpoints, export/import coverage types and write-volume allowance. Completeness now requires full proven coverage.
2. Writer ownership existed only in the open pointer: added ControlState.ownerRunId so ownership checks also work while STOP.
3. Import horizon trusted the export clock: added both local/export horizon checks and explicit nullable recordingSince semantics.
4. Journal target comparison was not a safe fallback for a torn marker: removed it; atomic surviving target/marker persistence is a named implementation gate.
5. Corrupt-DB reset exception was unreachable under the availability preflight: specified explicit empty-reset delete/recreate recovery with durable intent, fencing and deferred success.
6. Coverage metadata lacked its keyPath wrapper: specified keyed metadata wrappers separately from export IDs.
7. Additive merge target preparation preceded pending-save drain: clarified static validation → fence → drain → committed daily snapshot/target materialization → durable journal, preserving the existing coordinator's ordering.

The same reviewer verified the first six resolutions and separately confirmed the merge-order correction; no additional reviewer was spawned. Reviewer found no confirmed contradiction in authoritative tracking integration, transition behavior, overlap indexes, midnight splitting, domain dictionary or finite checkpoint recovery. These are design-review findings, not validation of production session code. Native gates and the product decisions in section 17 remain open for future implementation; no production code or commit was created.


### Cold-review design correction (2026-10-07)

Resolved the supplied HIGH, three MEDIUM and two LOW findings: bounded pre-intent history preflight with daily-gate release on failure; synchronous immutable calendar capture; calendar-aware STOP coverage; source investigation followed by backend-independent IDB intent and preserve-actual-data recovery, with strict intent/power-loss validation gate; omission of zero-duration provisional exports; bounded predecessor overlap queries using existing indexes. The accepted tracking interpreter, FIFO, finite endpoints, dictionary and checkpoint recovery remain unchanged. No production code or tracking behavior changed.

Exactly one new independent read-only reviewer inspected these corrections. It confirmed the bounded preflight/calendar/coverage/export/query changes and found one remaining MEDIUM: private storage.local backend selection made the proposed runtime backend gate unimplementable, and power-loss ordered-prefix assumptions were unproved. The local-marker protocol was replaced with IDB intent plus conservative affected-detail invalidation; interrupted daily writes are never replayed. The same reviewer confirmed this alternative's process/reload recovery and requested the explicit strict-intent/power-loss limitation above. The same reviewer read the final revised document and passed targeted verification with no further confirmed contradiction in the corrected scope. Strict-intent and machine-power-loss verification remain explicit unresolved gates; ordinary recording is independent. No additional reviewer was spawned.

### Autonomous MVP implementation decisions

The current user authorizes implementation, session-bearing overwrite, rejection of detailed merge, daily-only export alongside full export, and dashboard integration without further approval. Earlier design-only/non-goal/approval wording describes the previous docs task rather than constraining this MVP.

Destructive preparation requires a native transaction reporting `durability === 'strict'`; unsupported strict intent preparation rejects before daily mutation. Firefox 126+ implements the standard option (minimum supported version is 153). Gecko routes Strict to SQLite synchronous EXTRA; this is evidence of requested flush semantics, not an absolute disk/power guarantee. [Gecko IndexedDB database](https://raw.githubusercontent.com/mozilla/gecko-dev/master/dom/indexedDB/IDBDatabase.cpp), [Gecko IndexedDB storage](https://raw.githubusercontent.com/mozilla/gecko-dev/master/dom/indexedDB/ActorsParent.cpp).

Supported recovery is extension reload/background recreation/browser or process interruption with surviving committed database state. Actual daily values are always preserved on restart and never replayed. Arbitrary disk/power failure across independent stores is a residual platform limitation, not a claim of cross-database atomicity. Native strict support and reload/restart recovery must be tested; machine power loss is recorded NOT OBSERVED.

Dashboard calendar interpretation: ordinary days retain 00:00–24:00; DST uses true captured day bounds and offset-labelled times; travel days expose labelled capture-calendar groups. All aggregate metrics remain aggregate-powered; timeline ranks raw session duration and smoothing is presentation-only.

Native Firefox 157 testing found that API-return object normalization removes dynamic property names owned by `Object.prototype`, including `constructor` and `__proto__`, from both storage reads and runtime replies. Requests, strings and entry arrays retain them. The daily storage boundary therefore adds optional `websiteTimeReserved: Array<[hostname, seconds]>` for these names only. Ordinary daily records retain their existing shape; canonical in-memory data and both export formats retain the existing `websiteTime` map without codec fields. All daily readers and writers share one codec. Decoding rejects malformed, duplicate, nonreserved or conflicting entries; identical map/entry values count once. Encoding regenerates the transport field from canonical values. Never reconstruct previously missing hostname amounts from `netTime`. Export RPC returns canonical JSON as a string to avoid reply normalization. Independent read-only design review found no correctness blocker in this compatibility amendment.

Replacement preflight validates persisted control/open ownership, references and bounds without changing them, using the same invariants as startup recovery. Corruption or an existing replacement intent rejects before intent preparation or daily mutation; saved daily values and unsaved live counter seconds remain intact.

Legacy daily imports accept finite nonnegative fractional seconds. Independent `netTime` and domain additions can differ by IEEE754 rounding after an ordinary +1 tick. A shared numeric consistency predicate permits only a documented relative forward-error bound from nonnegative summation and independent total rounding, with no absolute epsilon floor. Nonfinite values, overflow, zero-versus-positive values and material mismatches reject. Stored/exported numbers and fixed +1 accounting remain unchanged; this rule never reconstructs missing domain amounts. Independent design review approved this compatibility rule after reproducing the fractional import-to-save regression.
