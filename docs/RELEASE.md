# Personal Firefox release and reviewer build instructions

The personal self-distributed build has a separate, stable add-on identity in
`config/firefox-release.json`. Keep this ID for all future updates. The normal
`public/manifest.json` remains the development identity, preserving the existing
development profile's storage. Both builds use the same application code.

## Build environment

Initial release verified on Linux with Node.js 26.11.1, npm 12.2.0, Python 3,
Webpack 5.88.2, and web-ext 10.7.0. Dependency versions are pinned by
`package-lock.json`. The extension requires Firefox 153 or later.

## Reproduce the submitted extension

Extract the source archive and run from its root:

```sh
npm ci
python3 scripts/package-firefox-release.py
```

`npm run prod` generates the minified Webpack bundles from `src/`, copying static
assets from `public/`. The packaging script copies the production output, excludes
source maps, replaces only the add-on name, ID, and data-consent declaration from
`config/firefox-release.json`, includes the privacy document, and validates the
staged extension. It produces:

- `.dev/releases/1.3.0/browser-screen-time-personal-1.3.0.zip`
- `.dev/releases/1.3.0/browser-screen-time-personal-1.3.0-source.zip`
- `.dev/releases/1.3.0/release.json` (artifact SHA-256 hashes)

The versioned directory and filenames follow the manifest version. The source
archive intentionally excludes Git metadata, node_modules, compiled output,
development profiles, private exports, credentials, and runtime logs. The
`.dev/releases` output is local and is not committed.

## Reviewer notes

React and its dependencies are bundled by Webpack. Source-map inspection traces
the validator's innerHTML warnings to React DOM and the Function-constructor
warnings to Webpack's generated global-object fallback (modern Firefox uses its
first `globalThis` branch). Readable project and dependency sources are available
through this source archive and `npm ci`. Project code does not load remote executable code. Inter Bold is a local
font, with its license bundled in `assets/fonts/Inter-LICENSE.txt`.

The `browsingActivity` declaration concerns direct website favicon requests;
see `docs/PRIVACY.md`. Statistics and raw session history stay local.

## Sign and install

Submit the extension ZIP through Mozilla Developer Hub with distribution set to
**On your own** (unlisted), and attach the source ZIP. Complete any required account
or developer-agreement steps, then download the signed XPI. The ZIP produced here
is unsigned and cannot be installed permanently in regular Firefox as-is.

Install the signed XPI in normal Firefox through `about:addons` → gear menu →
**Install Add-on From File…**. Export a full backup from any existing installation
and import it into the personal installation if its statistics should be retained.
Settings and custom site colors are separate local preferences; the time-data
backup is not a full Firefox-profile backup.

For updates, keep the personal ID, increase the manifest version, rebuild, sign,
and install the newly signed XPI. No automatic update server is configured.
