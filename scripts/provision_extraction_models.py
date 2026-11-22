"""Explicit operator-only download. Run separately from extraction."""
import argparse
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.model_artifacts import artifact_files, verify_artifacts, verify_file


def provision(root):
    if not root.is_absolute():
        raise ValueError('absolute destination required')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.resolve() != root or root.stat().st_mode & 0o077:
        raise ValueError('canonical private destination required')
    for model, record, relative in artifact_files():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.parent.resolve() != target.parent:
            raise ValueError('symlinked destination')
        if target.exists():
            verify_file(target, record)
            continue
        partial = target.with_suffix(target.suffix + '.part')
        if partial.is_symlink() or (partial.exists() and not partial.is_file()):
            raise ValueError('unsafe partial file')
        if partial.exists() and partial.stat().st_size > record['bytes']:
            raise ValueError('oversized partial file')
        if partial.exists() and partial.stat().st_size == record['bytes']:
            verify_file(partial, record)
            partial.replace(target)
            continue
        url = f"https://huggingface.co/{model['repo']}/resolve/{model['revision']}/{record['path']}"
        print('Provisioning', relative, record['bytes'], flush=True)
        subprocess.run(['curl', '--fail', '--location', '--proto', '=https',
                        '--proto-redir', '=https', '--connect-timeout', '20',
                        '--retry', '2', '--max-time', '1200',
                        '--max-filesize', str(record['bytes']),
                        '--continue-at', '-', '--output', str(partial), url], check=True)
        verify_file(partial, record)
        partial.replace(target)
    verify_artifacts(root)
    print('All pinned model files verified')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', type=Path)
    provision(parser.parse_args().destination)
