---
name: firefox-dev
description: Build and test this repository's Firefox extension using its isolated local Webpack/web-ext runner. Use whenever a task requires an extension build or manual/integration testing in Firefox.
---

Use the repository runner from the project root. Read `AGENTS.md` and the applicable
project requirements before implementation; this skill does not authorize changes
outside the user's task.

If dependencies are missing, run `npm ci`. The runner requires Linux, Node.js 22.13+ or 24+,
Firefox, Bash, `setsid`, `flock`, and a graphical desktop session.

```bash
bash scripts/firefox-dev.sh start
bash scripts/firefox-dev.sh status
bash scripts/firefox-dev.sh logs
bash scripts/firefox-dev.sh restart
bash scripts/firefox-dev.sh stop
```

`start` waits for the initial build and temporary installation. It is safe to call
again: it does not create duplicate watchers/runners. Edit the authorized source
files while it runs; Webpack rebuilds and web-ext reloads `dist/` automatically.
Do not launch a second watcher, install through `about:debugging`, or click Reload.
Use `restart` when runner/build configuration changes require a new process.

For noninteractive log inspection, read `.dev/webpack.log`, `.dev/web-ext.log`, and
`.dev/supervisor.log`; `logs` follows them until interrupted. Confirm successful
compilation and use `Last extension reload:` in the web-ext log as reload evidence.
`status` returns nonzero unless the environment is ready. If startup fails, inspect
these logs and fix the reported cause rather than falling back to the normal profile.

For manual/integration acceptance, exercise the extension only in the Firefox
instance using `.dev/firefox-profile`. This persistent profile is insecure and only
for development: never use normal Firefox profiles, their installed AMO extension,
personal accounts, or Sync. Use the runner's `stop`; do not use broad Firefox kill
commands. Stop an environment you started when testing is complete unless the user
asks to leave it running; preserve an environment already running before your task.

For release-build validation, also run `npm run prod`. Restore temporary verification
edits and inspect `git diff` before reporting. Runtime state stays under ignored
`.dev/`; stop the runner before deleting that directory to reset the test profile.

The runner implementation is [scripts/firefox-dev.sh](../../../scripts/firefox-dev.sh)
relative to the repository root, with usage documented in `README.md`. Call it;
do not recreate its process management or web-ext launch configuration.
