# Tracking Browser Screen Time

## 1. Goal

The tracking module must determine:

- whether Firefox can currently be tracked;
- which tab should receive tracked time;
- whether tracking should continue while the system is `idle`;
- how `<video>` and `<audio>` affect `idle`;
- when tracking must stop immediately;
- which states will later open and close session intervals.

The main product principle:

> Browser Screen Time tracks the website the user is actually using. Only the active Firefox tab receives time.

Background tabs do not receive time on their own. Background media must also never affect tracking of the active tab.

---

## 2. Approved Business Logic

The decision must always be made in the following order:

```text
Firefox focused?
│
├─ NO
│  └─ STOP
│
└─ YES
   │
   ├─ idle = false
   │  └─ TRACK active tab
   │
   └─ idle = true
      │
      ├─ active tab has playing media
      │  └─ TRACK active tab
      │
      └─ no playing media in active tab
         └─ STOP
```

Key rules:

- Losing Firefox focus always means `STOP`.
- When `idle = false`, media is completely ignored.
- When `idle = true`, only media in the active tab is considered.
- Media in background tabs must never enable tracking.
- Media is defined as HTML `<video>` + HTML `<audio>`.
- Web Audio API is not supported in the MVP.

Final truth table:

| Firefox focused | idle | Media in active tab | Result |
|---|---|---|---|
| No | any | any | STOP |
| Yes | false | no | TRACK active tab |
| Yes | false | yes | TRACK active tab |
| Yes | true | no | STOP |
| Yes | true | yes | TRACK active tab |

Background media does not change the result.

---

## 3. How the Original Tracker Works

Main files:

```text
src/scripts/background.ts
src/scripts/awake.ts
src/scripts/videoCheck.ts
src/scripts/types.ts
```

`background.ts` works using one-second polling:

```text
setInterval(..., 1000)
→ awake.available()
→ active tab
→ hostname
→ websiteTime[hostname] += 1
→ netTime += 1
```

`Awake` stores:

```text
idle
mediaPlaying
windowUnfocused
```

Current decision:

```text
mediaPlaying || !(idle || windowUnfocused)
```

The problem is that `mediaPlaying` is a global boolean. The tracker only knows that media is playing somewhere, but it does not know in which tab.

Because of this, the following architectural error is possible:

```text
YouTube background + playing
GitHub active
idle = true

mediaPlaying = true
→ tracking allowed
→ active tab = GitHub
→ GitHub incorrectly receives time
```

In addition, the existing media detector:

- works only with `<video>`;
- does not associate media with `tabId`;
- loses the tab/frame/document/media-element structure;
- uses unreliable media identification;
- failed to register actual YouTube playback during the experiment.

The `browser.idle` mechanism itself is suitable. What needs to change is its interaction with media.

---

## 4. What the Firefox + Hyprland Experiments Confirmed

A separate Hyprland integration is not required to determine Firefox eligibility.

When switching from the Firefox workspace to another workspace, Firefox emitted:

```text
browser.windows.onFocusChanged
windowId = WINDOW_ID_NONE
```

with a 22 ms delay after the workspace transition.

The same event occurs when focus is moved to another application.

Therefore, the primary source of truth is:

```text
browser.windows.onFocusChanged
```

Rule:

```text
WINDOW_ID_NONE
→ focusedWindowId = null
→ STOP
```

`document.visibilityState` is not suitable for this purpose. During testing, Firefox could remain `visible` while the user was already working in Ghostty. When changing workspaces, `hidden` also arrived later than the focus event.

`getCurrent()` and `getLastFocused()` also cannot be used as proof of focus: the Firefox window continued to be returned by these APIs after losing actual focus.

The media experiment confirmed the required model:

```text
non-media active + idle
→ STOP

YouTube active + playing + idle
→ TRACK YouTube

YouTube background + non-media active + idle
→ STOP

YouTube active + playing + Firefox loses focus
→ STOP
```

The diagnostic per-tab model provided the correct data. During the YouTube test, the old tracker left:

```text
mediaPlaying = false
```

and incorrectly stopped tracking after entering idle.

Firefox also provides the following through the message sender:

```text
sender.tab.id
sender.frameId
sender.documentId
```

This is sufficient to build a correct per-tab media registry.

---

## 5. Target State Model

The background should store:

```text
focusedWindowId
idle
activeTab
mediaByTab
```

Media registry:

```text
tabId
  → frameId
      → documentId
          → playingElementIds
```

Example:

```text
tab 44
├─ frame 0
│  └─ document A
│     ├─ video 1
│     └─ audio 2
│
└─ frame 7
   └─ document B
      └─ video 3
```

A tab is considered media-playing if at least one current document in any of its frames contains a playing media element:

```text
tabHasPlayingMedia(tabId)
=
playingElementIds.size > 0
```

`tabId`, `frameId`, and `documentId` must be obtained from Firefox through `sender`, rather than trusted from content-script data.

`src` must not be used as a media-element ID. Each `<video>` or `<audio>` element inside a document needs its own local `elementId`.

---

## 6. Decision Engine

The business logic should be separated from Browser APIs and kept as simple as possible:

```text
if focusedWindowId == null
    STOP

if activeTab == null
    STOP

if idle == false
    TRACK activeTab

if tabHasPlayingMedia(activeTab.id)
    TRACK activeTab

STOP
```

The active tab must be determined inside the specific:

```text
focusedWindowId
```

rather than only through:

```text
currentWindow: true
```

This is required for correct behavior with multiple Firefox windows.

Background media must not be passed into the decision function at all.

---

## 7. Events That Must Recalculate the Decision

`shouldTrack` must be recalculated when:

```text
Firefox focus changed
active tab changed
idle state changed
media state changed
document replaced
tab closed
```

When:

```text
windows.onFocusChanged(WINDOW_ID_NONE)
```

tracking stops immediately.

When a real Firefox `windowId` is received:

```text
focusedWindowId = windowId
→ obtain active tab of this window
→ recalculate shouldTrack
```

When `tabs.onActivated` fires, the decision must also be recalculated immediately.

Example:

```text
YouTube active + playing + idle
→ TRACK

switch to GitHub
YouTube becomes background
idle remains true
→ STOP
```

When:

```text
idle → active
```

media no longer affects the decision:

```text
Firefox focused
→ TRACK active tab
```

When:

```text
active → idle
```

only media in the active tab must be checked.

---

## 8. Focus Initialization and Async Races

The state must not be initialized as:

```text
windowUnfocused = false
```

and then wait for the first event.

When the background starts, it must determine the actual Firefox state and verify the real `window.focused` value.

If there is no focused Firefox window:

```text
focusedWindowId = null
```

Asynchronous requests need protection against stale results.

Scenario:

```text
event A → Firefox focused → async lookup started
event B → Firefox unfocused → STOP
lookup A finishes later
```

The old result from A must not set Firefox back to focused.

Use:

```text
stateVersion
focusGeneration
or event sequence number
```

The latest event must always have priority.

---

## 9. What to Change in `awake.ts`

The current model:

```text
idle
mediaPlaying
windowUnfocused
```

must no longer be built around the global:

```text
mediaPlaying
```

`Awake` should be responsible for base state, primarily `idle`, but the final `TRACK / STOP` decision must be made at the level where all of the following are known simultaneously:

```text
focusedWindowId
idle
activeTab
mediaByTab
```

The current `available()` is not suitable as the final decision function because it does not know the active tab.

---

## 10. What to Change in `background.ts`

`background.ts` should become the central state aggregation point:

```text
focus
+
idle
+
active tab
+
media registry
→ shouldTrack
```

Instead of:

```text
if awake.available()
    query active tab
```

the logic should become:

```text
determine focused Firefox window
→ determine active tab of this window
→ evaluate shouldTrack(activeTab)
→ attribute time only if state is still current
```

The one-second accounting loop can be preserved during the first implementation stage.

The following protections are required:

```text
stale async protection
single-flight protection for overlapping ticks
```

---

## 11. What to Change in `videoCheck.ts`

`videoCheck.ts` should effectively become a media detector.

It must support:

```text
<video>
<audio>
```

During initialization:

```text
document.querySelectorAll("video, audio")
```

For every detected element:

```text
create elementId
attach listeners
send current state
```

After the initial scan, use `MutationObserver` for:

```text
added video/audio
removed video/audio
media inside added subtree
```

Minimum events:

```text
playing
pause
ended
emptied
error
```

Use `playing` rather than only `play` to detect playback start, because `playing` indicates that playback has actually started or resumed.

Short `waiting/stalled` periods must not automatically clear the media state.

Stopping occurs on explicit events:

```text
pause
ended
emptied
error
element/document removal
```

Buffering policy requires a separate acceptance test.

The content script must not decide `TRACK / STOP`. It only reports factual media state.

---

## 12. Media Registry Lifecycle

Media state must be cleaned up using real lifecycle events.

On navigation:

```text
document A
→ document B
```

media belonging to the old document must be removed. `documentId` protects against stale messages from the previous page.

When an iframe is removed, only the corresponding combination must be cleared:

```text
tabId + frameId + documentId
```

When:

```text
browser.tabs.onRemoved(tabId)
```

completely remove:

```text
mediaByTab[tabId]
```

For the document lifecycle, use a persistent connection between the content script and background:

```text
document loads
→ connect
→ background registers document
→ media events
→ document disappears
→ port disconnect
→ document state removed
```

Do not use a timeout such as:

```text
if there are no messages for N seconds
→ media disappeared
```

---

## 13. What to Change in `types.ts`

Add explicit media messages, for example:

```text
MediaElementRegistered
MediaElementPlaying
MediaElementStopped
MediaDocumentSnapshot
MediaDocumentDisconnected
```

Identification:

```text
tabId
frameId
documentId
```

must be obtained by the background from Firefox `sender`.

---

## 14. What Does Not Need to Be Added

The MVP does not require:

```text
Hyprland IPC
hyprctl runtime dependency
Native Messaging
native helper
workspace tracking
document.visibilityState as the primary criterion
global mediaPlaying boolean
background-media override
```

The experiments confirmed that Firefox WebExtension APIs provide the required signals.

The following are also outside the scope of this stage:

```text
IndexedDB
session history
dashboard
timeline
heatmap
Pomodoro
cloud storage
visit counters
live popup
```

The tracking engine itself must be made correct first.

---

## 15. Implementation Order

### Phase 1 – State Model

Create:

```text
focusedWindowId
idle
activeTab
mediaByTab
```

Do not change the UI.

### Phase 2 – Focus

Fix `windows.onFocusChanged`:

```text
use the event windowId
handle WINDOW_ID_NONE
correctly determine initial focus
add stale async protection
```

### Phase 3 – Media Detector

Rework `videoCheck.ts`:

```text
video + audio
initial scan
MutationObserver
media events
element lifecycle
document lifecycle
```

### Phase 4 – Per-Tab Registry

Store:

```text
tab
→ frame
→ document
→ playing elements
```

### Phase 5 – Decision Engine

Implement:

```text
focus
→ idle
→ active-tab media
→ TRACK / STOP
```

### Phase 6 – Tests

Add unit, integration, and manual Firefox/Hyprland tests.

---

## 16. Required Acceptance Tests

Minimum set:

```text
1.
Firefox focused
GitHub active
idle=false
→ TRACK GitHub

2.
Firefox focused
GitHub active
idle=true
no media
→ STOP

3.
Firefox focused
YouTube active
video playing
idle=true
→ TRACK YouTube

4.
Firefox focused
YouTube active
video paused
idle=true
→ STOP

5.
Firefox focused
GitHub active
YouTube background playing
idle=true
→ STOP

6.
Firefox focused
GitHub active
YouTube background playing
idle=false
→ TRACK GitHub

7.
audio active + playing
idle=true
→ TRACK active audio tab

8.
audio background playing
GitHub active
idle=true
→ STOP

9.
active media tab
Firefox loses focus
→ STOP immediately

10.
active media tab
switch Hyprland workspace
→ WINDOW_ID_NONE
→ STOP

11.
iframe media playing
parent tab active
idle=true
→ TRACK parent tab hostname

12.
media playing
navigate same tab to non-media page
idle=true
→ old media state removed
→ STOP

13.
two media elements playing
one stops
→ tab still media-playing

second stops
→ tab no longer media-playing

14.
playing media tab closed
→ mediaByTab[tabId] removed
```

Unit tests must separately cover the entire truth table of the decision function.

Integration tests must cover the media registry, tab changes, documents, frames, and cleanup.

After implementation, repeat the manual regression test:

```text
Firefox focused
workspace away
workspace back

YouTube active + idle
YouTube background + idle

audio active + idle
audio background + idle
```

---

## 17. Relationship with Future Sessions

Session history must be built on `effective tracking`, rather than merely on the existence of a tab.

```text
shouldTrack false → true
→ START SESSION

active hostname changes
→ CLOSE old session
→ START new session

shouldTrack true → false
→ CLOSE SESSION
```

Background media must not create a separate session.

Example:

```text
YouTube active
→ YouTube session

switch to GitHub
→ close YouTube
→ start GitHub

idle=true
YouTube still playing in background
GitHub active without media
→ close GitHub
→ do not open YouTube
```

Future Day Timeline UI smoothing must not modify real tracking intervals.

---

## 18. Additional Problems in the Original Tracker

These are outside the main focus/media fix, but they should be moved to the backlog.

`Day rollover`:

```text
new Date().getDate()
```

should be replaced with comparison of the full local calendar date.

`Fixed +1 second`:

```text
setInterval(..., 1000)
websiteTime += 1
```

does not account for actual elapsed time when JavaScript timers are delayed.

`Async overlapping ticks`:

a single-flight guard is required, or the implementation should move toward event-driven state with a simple accounting loop.

`Save interval`:

data is not persisted after every change, so a crash between saves can cause some in-memory tracked time to be lost.

These issues must not expand the scope of the current tracking fix.

---

## 19. Key Invariants

After implementation, the following rules must always hold:

```text
Firefox unfocused
→ shouldTrack = false

idle=false
→ media does not affect shouldTrack

idle=true
→ only media in the active tab can enable tracking

background media
→ never receives time

background media
→ never allows another tab to receive time

media identity
→ determined through Firefox sender

stale document/frame
→ does not affect the current tab

raw tracking intervals
→ are not modified for UI purposes
```

---

## 20. What Is Confirmed and What Still Requires Verification

Experimentally confirmed:

```text
Hyprland workspace switch → WINDOW_ID_NONE
focus another application → WINDOW_ID_NONE
Firefox focus gain → real windowId
focus event is more suitable than visibilityState
getCurrent/getLastFocused do not prove focus
sender.tab.id is available
sender.frameId is available
sender.documentId is available
per-tab media registry is feasible
Hyprland native integration is not required
```

Still not verified:

```text
production detection of <audio>
Web Audio API – outside MVP scope
multiple Firefox windows
multiple monitors
buffering policy
muted autoplay policy
```

`muted autoplay` requires a separate product decision. Decorative autoplay video must not silently become a reason to continue tracking when `idle=true`.

---

## 21. Final Requirement

Browser Screen Time tracks only the active tab of the focused Firefox window.

```text
Firefox unfocused
→ STOP

Firefox focused + idle=false
→ TRACK active tab

Firefox focused + idle=true
+ active tab playing <video>/<audio>
→ TRACK active tab

Firefox focused + idle=true
+ active tab without playing media
→ STOP
```

Media in background tabs is completely ignored.

Losing Firefox focus, including switching to another Hyprland workspace or focusing another application, must always stop tracking immediately.

The implementation only requires:

```text
Firefox WebExtension APIs
+
correct focus state
+
per-tab HTML media state
```

There is no need to build a new tracker from scratch. The tracking-eligibility layer in the existing Browser Screen Time implementation should be replaced while preserving the rest of the working tracking mechanics.
