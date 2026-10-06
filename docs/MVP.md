# Browser Screen Time — MVP

## Foundation

The project is based on:
https://github.com/aaaeka/browser-screen-time

The existing time-tracking mechanics must be preserved unless a specific MVP requirement explicitly changes them.

## Tracking

- All visited domains are tracked.
- Existing daily aggregates are preserved:
  day → domain → number of seconds.
- Live popup updates are not required.
- The number of website visits does not need to be tracked.
- Idle detection and the existing video-watching logic must be preserved.

Target tracking logic:
```text
1. Firefox must be in an acceptably active/visible state.
   If not → STOP.

2. idle = false
   → completely ignore media state;
   → track the active tab.

3. idle = true
   → if no media is playing anywhere → STOP;
   → if media is playing only in background tabs → STOP;
   → if the active tab is among the tabs currently playing media
      → track only the active tab.
```

## Hyprland / Firefox Visibility

The issue where time continues to be tracked after switching to another Hyprland workspace where Firefox is no longer visible must be fixed.

The exact technical implementation should be determined separately after investigating Firefox and Hyprland behavior.

## Session History

In addition to daily aggregates, continuous sessions must be stored.

Session:
- id
- domainId
- start timestamp
- end timestamp

Domains must be stored in a separate domain registry.

Daily aggregates remain in `browser.storage.local`.

Session history is planned to be stored locally in IndexedDB.

Smoothed timeline intervals must not be stored in the database.

## Dashboard

The extension's large window becomes a single dashboard page.

- No sidebar navigation for Dashboard / Websites / Calendar.
- No additional analytics pages.
- Main design reference:
  `docs/reference/dashboard.png`

Main sections:

1. Total Screen Time
2. Most Used Site
3. Daily Average
4. Total Screen Time by Day
5. Time Distribution
6. Day Timeline
7. Changes vs Previous Period
8. Year Heatmap

## Total Screen Time by Day

Stacked chart.

Each bar represents one day.

Each bar is divided into colored segments by domain.

Within the same section, the user can select which websites are displayed.

## Day Timeline

Displays the selected day on a shared 00:00–24:00 timeline.

Separate rows:

- Top 1 site
- Top 2 site
- Top 3 site
- Top 4 site
- Other

Each row displays the actual session time ranges for that site.

For the full-day scale, two sessions from the same site may be visually merged when they are separated by a very short period of activity on another site.

Example:

YouTube  10:00–10:20  
ChatGPT  10:20–10:22  
YouTube  10:22–10:50

may be visually displayed as a continuous YouTube line from 10:00–10:50, while the separate ChatGPT line from 10:20–10:22 is displayed at the same time.

This is visual smoothing only.

The original sessions and all numerical metrics must never be modified.

As the user zooms in, the amount of smoothing must decrease.

At a detailed zoom level, the actual raw sessions must be displayed.

## Data / Privacy

- The MVP is local-first.
- There is no backend.
- There is no user account.
- Browser history and session history are never sent to a server.
- The existing import/export functionality must be preserved and later extended to support session history.

## Out of Scope for the Current MVP

- Pomodoro.
- Website visit counts.
- Live timer in the popup.
- Cross-device synchronization.
- Cloud backend.
