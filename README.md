<div align='center'>
    <img width="128" src="./public/assets/icons/128px.png"/>
    <h1>Browser screen time</h1>
</div>

[![License: LGPL v3](https://img.shields.io/badge/License-LGPL%20v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0.en.html)

Browser screen time is an extension which helps you track of the amount of time you spend online

## Local-first MVP

The large extension window is a single dashboard: total screen time, most used
site, daily average, daily stacked usage, time distribution, Day Timeline,
previous-period changes, and a year heatmap. Select 1, 7, 30, or custom calendar
days; site selection filters the daily chart. The popup remains a saved snapshot.

Daily statistics retain the existing date keys and canonical import/export format.
An additive storage codec preserves hostname keys affected by Firefox API transport.
Detailed sessions use a separate local IndexedDB database and the same authoritative
tracking decision. No account, backend, remote favicon service, visit counter,
or Pomodoro is used. Neither dataset is sent to a server.

The timeline uses real session intervals, not reconstructed daily totals. Legacy
data remains useful for aggregate metrics and is labelled as lacking detailed
history. Timeline smoothing only changes displayed intervals; detailed zoom shows
raw intervals. Historical day/time-zone identities remain fixed, including DST
and travel groups. Aggregate seconds and session durations can differ because
they measure fixed accounting ticks and observed decision intervals separately.

Settings offers a full backup and a compatible daily-totals-only export. Legacy
imports remain supported. Full backups support overwrite; detailed additive merge
is rejected because overlapping histories cannot safely be combined. Daily-only
merge preserves totals while invalidating detailed history for affected dates.
Reset preserves settings. Back up important history before replacement.

Session checkpoints have finite safe endpoints. Restart never fills unobserved
time, and a detailed-storage failure leaves daily tracking operational. Replacement
uses strict IndexedDB intents and preserves actual saved daily values after an
interruption; it never replays a destructive target. Independent storage APIs
cannot promise shared atomicity under arbitrary disk or power failure. No automatic
history retention/deletion is configured. See [the session contract](docs/SESSIONS.md)
and [MVP requirements](docs/MVP.md).
Release validation and platform boundaries are recorded in
[MVP acceptance](docs/MVP_ACCEPTANCE.md).

## Downloading the extension

### Chrome
[Chrome extension link](https://chrome.google.com/webstore/detail/browser-screen-time/nlkcecddkejakmaipagbcemeohfomedn)

### Firefox
[Firefox addon link](https://addons.mozilla.org/en-US/firefox/addon/browser-screen-time)

## Building the extension
Run ```npm install``` to install dependencies, then ```npm run dev``` to build, or ```npm run watch``` to build and then watch for changes.

Tracking requires **Firefox 153 or later**: current-document media ownership uses
Firefox's `runtime.MessageSender.documentId`. The full API audit and open/closed
shadow DOM support boundary are documented in [docs/TRACKING.md](docs/TRACKING.md).

### Local Firefox development

On Linux, install dependencies with `npm ci` (Node.js 22.13+ or 24+), then run:

```bash
npm run firefox:dev
npm run firefox:status
npm run firefox:logs       # follows logs; Ctrl+C only stops the log viewer
npm run firefox:restart
npm run firefox:stop
```

The equivalent entry point is `bash scripts/firefox-dev.sh start|stop|restart|status|logs`.
The runner uses the existing Webpack watch command, waits for the first successful
build, and launches the project-local Mozilla `web-ext` against `dist/`. Source
edits rebuild automatically; changes in `dist/` automatically reload the temporary
extension. No `about:debugging` installation or Reload click is needed.

Firefox runs as a separate instance using only `.dev/firefox-profile`. This profile
persists between runs to retain test-site state. **It is an insecure development-only
profile:** web-ext changes security/debugging preferences. Never use it for normal
browsing, personal accounts, or Firefox Sync. The normal Firefox profile and its AMO
extension are not used. See [Mozilla's profile warning](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#--keep-profile-changes).

All profile, temporary, artifact, PID, and log files are ignored under `.dev/`.
`start` is idempotent; `stop` signals only process groups verified as belonging to
this runner. Closing the development Firefox shuts down its watcher too. Runtime
logs are `.dev/supervisor.log`, `.dev/webpack.log`, and `.dev/web-ext.log`; `status`
returns nonzero when the environment is not ready. Startup failures report logs
and clean up owned children. Install Firefox, Bash, `setsid`, and `flock`; a graphical
desktop session must be available. Set `FIREFOX_DEV_BINARY=/absolute/path/to/firefox`
before starting to select another Firefox binary, without changing the profile.

After `stop`, deleting `.dev/` resets development state. Do not delete it while the
runner is active. Production builds remain `npm run prod`.

### Building for chrome
Chrome manifest v3 no longer supports background scripts, instead moving to service_workers. Replace the line `"scripts": [ "background.js" ]` 
with `"service_worker": "background.js"` and the extension should work with chrome. In the future this process could be automated.

### Test dependencies

The test stack supports the Node.js 22.0+ at the test-stack level: Vitest 3,
jsdom 26, and Vite 6. Vite is overridden consistently throughout the test tree;
Rollup 4.59.0 avoids newer native dependencies requiring Node 22.20+. Node typings
are pinned to the original 20.5.6 resolution for TypeScript 5.2 compatibility.
TypeScript 5.2.2 and Sass 1.66.1 are intentionally pinned to the original project
versions; tracking does not require compiler or Sass upgrades.

The complete toolchain requires Node.js `^22.13.0 || >=24.0.0`, declared in
package.json: the existing web-ext → addons-linter → espree/eslint-visitor-keys
chain already requires that range. Test dependencies do not raise this floor.
Node 23 is outside that existing dependency range.
