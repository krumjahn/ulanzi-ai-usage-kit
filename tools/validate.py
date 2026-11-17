#!/usr/bin/env python3
"""Offline release checks: syntax, references, secrets, and asset provenance."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = next((ROOT / 'plugin').iterdir())

def main():
    spec = importlib.util.spec_from_file_location('icons', ROOT / 'tools/generate-icons.py')
    icons = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(icons)
    expected_icons = {PLUGIN / 'assets/icons' / (name + '.png'): icons.icon(i) for i, name in enumerate(icons.ICONS)}
    expected_icons[ROOT / 'profile/ai-usage-kit.ulanziProfile/AI Usage Kit.png'] = icons.icon(0)
    documentation_images = json.loads((ROOT / 'tests/documentation-images.json').read_text())
    vendor_hashes = json.loads((ROOT / 'tests/ws-sha256.json').read_text())
    secret_patterns = [
        r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
        r'(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}',
        r'AIza[0-9A-Za-z_-]{30,}',
        r'gh[pousr]_[0-9A-Za-z]{25,}',
        r'github_pat_[0-9A-Za-z_]{30,}',
        r'AKIA[0-9A-Z]{16}',
        r'UC[A-Za-z0-9_-]{22}',
    ]
    count = 0
    for file in sorted(ROOT.rglob('*')):
        if any(part in ('.git', '__pycache__') for part in file.relative_to(ROOT).parts): continue
        assert not file.is_symlink(), f'Symlink: {file.relative_to(ROOT)}'
        if not file.is_file(): continue
        count += 1
        relative = file.relative_to(ROOT).as_posix()
        if relative in documentation_images:
            assert hashlib.sha256(file.read_bytes()).hexdigest() == documentation_images[relative], f'Unreviewed documentation image: {file}'
            continue
        if file.suffix == '.png':
            assert file in expected_icons and file.read_bytes() == expected_icons[file], f'Unreviewed image: {file}'
            continue
        text = file.read_text(encoding='utf-8')
        for pattern in secret_patterns:
            assert not re.search(pattern, text), f'Potential secret/account ID: {file.relative_to(ROOT)}'
        assert not re.search(r'/' + r'Users/(?!USERNAME(?:/|\b))[^/\s]+', text), f'Personal path: {file}'
        assert file.suffix not in ('.db', '.sqlite', '.log', '.zip', '.key', '.pem'), f'Private/build file: {file}'
        if file.suffix == '.json': json.loads(text)
        if file.suffix == '.py': ast.parse(text, filename=str(file))
        if file.suffix == '.sh': subprocess.run(['bash', '-n', str(file)], check=True)
        if file.suffix in ('.js', '.mjs'): subprocess.run(['node', '--check', str(file)], check=True, capture_output=True)
        if file.suffix == '.html':
            for ref in re.findall(r'(?:src|href)="([^"]+)"', text):
                assert '://' not in ref and (file.parent / ref).is_file(), f'Bad inspector reference: {ref}'
    assert {f.relative_to(ROOT).as_posix() for f in (ROOT / 'docs/images').rglob('*') if f.is_file()} == set(documentation_images)
    ws = PLUGIN / 'node_modules/ws'
    assert {str(f.relative_to(ws)) for f in ws.rglob('*') if f.is_file()} == set(vendor_hashes)
    for name, digest in vendor_hashes.items():
        assert hashlib.sha256((ws / name).read_bytes()).hexdigest() == digest, f'Unreviewed ws file: {name}'
    manifest = json.loads((PLUGIN / 'manifest.json').read_text())
    refs = [manifest['Icon'], manifest['CategoryIcon'], manifest['CodePath']]
    for action in manifest['Actions']:
        refs += [action['Icon']] + [s['Image'] for s in action['States']]
        if 'PropertyInspectorPath' in action: refs.append(action['PropertyInspectorPath'])
    for ref in refs: assert (PLUGIN / ref).is_file(), f'Missing manifest reference: {ref}'
    allowed = {a['UUID'] for a in manifest['Actions']}
    profile = ROOT / 'profile/ai-usage-kit.ulanziProfile'
    meta = json.loads((profile / 'manifest.json').read_text())
    assert meta['Device'] == {'Model': 'D200', 'UUID': ''}
    assert (profile / meta['Icon']).is_file()
    assert meta['Pages']['Current'] in meta['Pages']['Pages']
    for page in meta['Pages']['Pages']:
        data = json.loads((profile / 'Profiles' / page / 'manifest.json').read_text())
        for controller in data['Controllers']:
            for action in controller['Actions'].values():
                assert action['Action'] in allowed
                for view in action['ViewParam']:
                    suffix = view['Icon'].split('/Plugins/' + PLUGIN.name + '/', 1)[1]
                    assert (PLUGIN / suffix).is_file()
    print(f'Validated {count} release files: syntax, JSON, references, secret patterns, original icons, and ws hashes.')

if __name__ == '__main__': main()
