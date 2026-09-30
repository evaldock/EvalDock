#!/usr/bin/env python3
"""Import an explicitly reviewed BenchDock pilot profile without evaluator material."""
import argparse
import hashlib
import json
import re
import shutil
import tempfile
from pathlib import Path, PurePosixPath


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_file(root, name):
    parts = PurePosixPath(name)
    if not name or parts.is_absolute() or any(x in {'.', '..'} for x in name.split('/')) or '\\' in name or ':' in name:
        raise ValueError('Unsafe release path')
    current = root
    for part in parts.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Release symlinks are not supported; make a standalone copy')
    if not current.is_file():
        raise ValueError('Missing release file: ' + name)
    return current


def import_release(release, profile_file, destination):
    if destination.exists() or destination.is_symlink():
        raise ValueError('Destination already exists; choose a fresh directory')
    if release.is_symlink():
        raise ValueError('Release root must not be a symlink')
    release = release.resolve(strict=True)
    if destination.resolve().is_relative_to(release):
        raise ValueError('Import outside the immutable release directory')
    profile_bytes = profile_file.read_bytes()
    profile = json.loads(profile_bytes)
    if profile.get('schema') != 'evaldock.benchdock-profile/v1' or profile.get('repo_id') != 'EvalDock/BenchDock':
        raise ValueError('Unsupported profile')
    if not re.fullmatch(r'[0-9a-f]{40}', profile.get('revision', '')):
        raise ValueError('Pin a full public release commit')
    manifest_bytes = safe_file(release, 'FILES.jsonl').read_bytes()
    if sha(manifest_bytes) != profile['manifest_sha256']:
        raise ValueError('Release manifest differs from pinned profile')
    manifest = {}
    for line in manifest_bytes.splitlines():
        item = json.loads(line)
        if item['path'] in manifest:
            raise ValueError('Duplicate manifest path')
        manifest[item['path']] = item

    def verified(name):
        expected = manifest[name]
        data = safe_file(release, name).read_bytes()
        if len(data) != expected['bytes'] or sha(data) != expected['sha256']:
            raise ValueError('Release checksum mismatch: ' + name)
        return data

    catalog_bytes = verified('catalog.jsonl')
    records = [json.loads(line) for line in catalog_bytes.splitlines() if line.strip()]
    catalog = {r['task_id']: r for r in records}
    if len(catalog) != len(records):
        raise ValueError('Duplicate task IDs')
    selections = profile['tasks']
    if not selections or len({x['task_id'] for x in selections}) != len(selections):
        raise ValueError('Select unique tasks')
    prepared, all_labels = [], set()
    for spec in selections:
        row = catalog[spec['task_id']]
        if row['schema'] != 'benchdock.catalog/v1' or row['distribution'] != 'bundled':
            raise ValueError('Source-reference records cannot be imported for execution')
        task_bytes = verified(spec['task_path'])
        if json.loads(task_bytes) != row:
            raise ValueError('Task record differs from catalog')
        if not re.fullmatch(r'[A-Za-z0-9._-]+', row['task_id']):
            raise ValueError('Unsupported task ID')
        environment = spec['environment']
        if set(environment) != {'platform', 'timeoutSeconds', 'allowedEdits', 'dependencies'}:
            raise ValueError('Profile needs an explicit environment contract')
        if environment['platform'] not in {'darwin', 'portable'} or type(environment['timeoutSeconds']) is not int or not 0 < environment['timeoutSeconds'] <= 86400:
            raise ValueError('Unsupported runtime profile')
        if environment['allowedEdits'] != ['work/**', 'output/**'] or not isinstance(environment['dependencies'], list):
            raise ValueError('Unsupported writable paths or dependency declaration')
        labels = spec['capabilityLabels']
        if not labels or len(set(labels)) != len(labels) or any(not re.fullmatch(r'[a-z][a-z0-9-]*', x) for x in labels):
            raise ValueError('Invalid capability labels')
        all_labels.update(labels)
        files, inputs = {}, []
        for item in row['inputs']:
            destination_name = item['destination']
            if not destination_name.startswith('input/') or any(x in {'', '.', '..'} for x in destination_name.split('/')) or '\\' in destination_name or ':' in destination_name:
                raise ValueError('Input destination must stay under input/')
            if destination_name in files:
                raise ValueError('Duplicate input destination')
            data = verified(item['path'])
            if len(data) != item['bytes'] or sha(data) != item['sha256']:
                raise ValueError('Input metadata differs from manifest')
            files[destination_name] = data
            inputs.append({'source': destination_name, 'destination': destination_name, 'delivery': 'workspace', 'sha256': sha(data)})
        for license_file in row['license_files']:
            if not license_file.startswith('licenses/'):
                raise ValueError('Unsupported license path')
            files[license_file] = verified(license_file)
        for name in ['LICENSE', 'NOTICE.md']:
            files[name] = verified(name)
        metadata = {'repo_id': profile['repo_id'], 'revision': profile['revision'], 'manifest_sha256': sha(manifest_bytes),
                    'catalog_sha256': sha(catalog_bytes), 'task_id': row['task_id'], 'task_record_sha256': sha(task_bytes), 'profile_sha256': sha(profile_bytes)}
        question = {'schema': 'evaldock.question/v1', 'version': profile['revision'], 'id': row['task_id'], 'title': row['title'],
                    'task': {'instructions': row['prompt']}, 'capabilityLabels': labels, 'environment': environment, 'inputs': inputs,
                    'grading': {'mode': 'unavailable', 'reason': 'PRIVATE_EVALUATOR_NOT_DISTRIBUTED'}, 'benchdock': metadata}
        files['question.json'] = (json.dumps(question, ensure_ascii=False, indent=2) + '\n').encode()
        files['PROVENANCE.json'] = task_bytes
        prepared.append((sha(row['task_id'].encode())[:24], files))
    descriptions = {'schema': 'evaldock.dataset-planner-catalog/v1', 'version': profile['revision'], 'datasets': [{
        'datasetId': 'dataset.benchdock-public/v1', 'name': 'BenchDock public pilot',
        'description': 'Explicitly selected public tasks. Execution and trace collection only; private scoring is separate.',
        'labelIds': ['label.' + x + '/v1' for x in sorted(all_labels)], 'availableCaseCount': len(prepared)}]}
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.benchdock-import-', dir=destination.parent))
    try:
        for task_dir, files in prepared:
            for name, data in files.items():
                target = staging / 'benchdock-public' / task_dir / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        (staging/'catalog.md').write_text('# BenchDock public pilot\n\n```json evaldock-dataset-catalog\n' + json.dumps(descriptions, indent=2) + '\n```\n')
        receipt = {'schema': 'evaldock.benchdock-import/v1', 'repo_id': profile['repo_id'], 'revision': profile['revision'],
                   'manifest_sha256': sha(manifest_bytes), 'profile_sha256': sha(profile_bytes), 'imported_tasks': [s['task_id'] for s in selections],
                   'source_reference_records_excluded': sum(r['distribution'] == 'source_reference' for r in records),
                   'scoring': 'PRIVATE_EVALUATOR_NOT_DISTRIBUTED', 'environment_execution_verified': False}
        (staging/'benchdock-import.json').write_text(json.dumps(receipt, indent=2)+'\n')
        # mkdir makes destination reservation exclusive; never replace an existing dataset.
        destination.mkdir()
        try:
            for child in staging.iterdir():
                shutil.move(str(child), str(destination/child.name))
        except Exception:
            raise ValueError('Import incomplete; inspect the newly reserved destination')
        return receipt
    finally:
        shutil.rmtree(staging)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--release', required=True, type=Path)
    p.add_argument('--profile', required=True, type=Path)
    p.add_argument('--destination', required=True, type=Path)
    a = p.parse_args()
    try:
        print(json.dumps(import_release(a.release, a.profile, a.destination), indent=2))
    except (ValueError, OSError, KeyError, TypeError) as error:
        p.exit(1, str(error)+'\n')
