# Project instructions

Read `docs/MVP.md` before planning or implementing changes.

The project is based on `aaaeka/browser-screen-time`.

## Core rules

- Preserve existing working tracking behavior unless MVP.md explicitly changes it.
- Do not add visit counting.
- Do not add live popup updating.
- Preserve daily aggregate statistics.
- Session history is additional data, not a replacement for daily aggregates.
- Never alter raw session data for timeline smoothing.
- Timeline smoothing belongs only to the presentation layer.
- Keep the MVP local-first. Do not introduce a backend.
- Treat `docs/reference/dashboard.png` as the approved dashboard design reference.
- Do not invent Hyprland integration before the Firefox/Hyprland behavior has been researched and verified.
- For any tracking-related task, read `docs/TRACKING.md` before planning or modifying code.

## Workflow

Before making a significant architectural change:
1. inspect the existing implementation;
2. state which files will be affected;
3. check compatibility with existing stored data;
4. implement;
5. build and test;
6. report regressions or unresolved questions.

When independent research can be parallelized, use separate agents.
Avoid concurrent writes to the same files.
