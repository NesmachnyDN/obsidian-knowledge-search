"""Verify the explicitly provisioned, immutable extraction artifact set."""
import hashlib
import json
from pathlib import Path

MANIFEST = Path(__file__).with_name('extraction-model-artifacts.json')


def artifact_files():
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    for model in manifest['models']:
        for record in model['files']:
            yield model, record, Path(model['repo'].replace('/', '--')) / record['path']


def verify_file(path: Path, record: dict) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size != record['bytes']:
        raise ValueError('missing or invalid model artifact')
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != record['sha256']:
            raise ValueError('model artifact digest mismatch')


def verify_artifacts(root: Path) -> None:
    if not isinstance(root, Path) or not root.is_absolute() or not root.is_dir():
        raise ValueError('explicit local model directory required')
    if root.resolve(strict=True) != root:
        raise ValueError('noncanonical model directory')
    expected = {relative: record for _, record, relative in artifact_files()}
    actual = set()
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('model directory symlink')
        if path.is_file():
            actual.add(path.relative_to(root))
        elif not path.is_dir():
            raise ValueError('nonregular model artifact')
    if actual != expected.keys():
        raise ValueError('unexpected or missing model artifacts')
    for relative, record in expected.items():
        verify_file(root / relative, record)
