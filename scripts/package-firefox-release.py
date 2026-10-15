#!/usr/bin/env python3
"""Build an isolated Firefox self-distribution package and reproducible source archive."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / 'config/firefox-release.json').read_text())
subprocess.run(['npm', 'run', 'prod'], cwd=ROOT, check=True)
manifest = json.loads((ROOT / 'dist/manifest.json').read_text())
manifest['name'] = config['name']
gecko = manifest['browser_specific_settings']['gecko']
gecko['id'] = config['id']
gecko['data_collection_permissions'] = config['data_collection_permissions']
version = manifest['version']
out = ROOT / '.dev/releases' / version
stage = out / 'extension'
if stage.exists():
    shutil.rmtree(stage)
stage.mkdir(parents=True, exist_ok=True)
for path in sorted((ROOT / 'dist').rglob('*')):
    if not path.is_file() or path.suffix == '.map':
        continue
    target = stage / path.relative_to(ROOT / 'dist')
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, target)
(stage / 'manifest.json').write_text(json.dumps(manifest, indent=4) + '\n')
shutil.copy2(ROOT / 'docs/PRIVACY.md', stage / 'PRIVACY.md')
# Fail on validator errors before producing a submission artifact.
subprocess.run([str(ROOT / 'node_modules/.bin/web-ext'), 'lint', '--source-dir', str(stage)], cwd=ROOT, check=True)
package = out / f'browser-screen-time-personal-{version}.zip'
with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(stage.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(stage))
source = out / f'browser-screen-time-personal-{version}-source.zip'
source_paths = ['src', 'public', 'tests', 'config/firefox-release.json', 'scripts/package-firefox-release.py',
                'package.json', 'package-lock.json', 'webpack.config.js', 'tsconfig.json', 'tsconfig.test.json',
                'vitest.config.mts', 'README.md', 'LICENSE', 'docs/RELEASE.md', 'docs/PRIVACY.md',
                'docs/MVP.md', 'docs/TRACKING.md', 'scripts/firefox-dev.sh']
with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in source_paths:
        path = ROOT / name
        if not path.exists():
            raise FileNotFoundError(f'Missing reviewer source: {name}')
        if path.is_file():
            archive.write(path, path.relative_to(ROOT))
        elif path.is_dir():
            for child in sorted(path.rglob('*')):
                if child.is_file():
                    archive.write(child, child.relative_to(ROOT))
metadata = {'version': version, 'id': config['id'], 'name': config['name'], 'minimumFirefox': gecko['strict_min_version'],
            'signed': False, 'artifacts': {p.name: {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in [package, source]}}
(out / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(f'Unsigned extension: {package}\nReviewer source: {source}\nMetadata: {out / "release.json"}')
