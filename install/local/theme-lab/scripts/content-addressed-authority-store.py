#!/usr/bin/env python3
"""Import or restore SHA-pinned authority evidence from a portable blob store.

The independently pinned inventory and checkout-local adaptation ledger define
the permitted paths and hashes. In restore mode the original source worktree
is never read. Offline, local-only transport; a separately backed-up copy of
the store and inventory is required for durable operational availability.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile

restore_path = Path(__file__).with_name('restore-authority-evidence.py')
spec = importlib.util.spec_from_file_location('authority_restore', restore_path)
authority = importlib.util.module_from_spec(spec)
spec.loader.exec_module(authority)


def inventory_files(destination, inventory_path, expected_sha):
    if not authority.SHA.fullmatch(expected_sha) or authority.checksum(inventory_path) != expected_sha:
        raise ValueError('inventory SHA-256 mismatch')
    doc = json.loads(inventory_path.read_text())
    if doc.get('schema') != authority.SCHEMA or not isinstance(doc.get('files'), list) or not doc['files']:
        raise ValueError('invalid authority inventory schema/files')
    entries, roots = {}, {}
    for row in doc['files']:
        if not isinstance(row, dict):
            raise ValueError('invalid authority inventory entry')
        rel, digest, size = row.get('relative_path'), row.get('sha256'), row.get('size_bytes')
        if (not isinstance(rel, str) or not rel.startswith(authority.PREFIX)
                or not isinstance(digest, str) or not authority.SHA.fullmatch(digest)
                or type(size) is not int or size < 0 or rel in entries):
            raise ValueError('invalid or duplicate inventory entry')
        authority.safe_file(destination, rel, existing=False)
        entries[rel] = (digest, size)
        if row.get('ledger_root'):
            if row.get('ledger_hash_verified') is not True:
                raise ValueError(f'unverified ledger root: {rel}')
            roots[rel] = digest
    if roots != authority.ledger_roots(destination):
        raise ValueError('inventory/ledger authority identity mismatch')
    objects = {}
    for digest, size in entries.values():
        if digest in objects and objects[digest] != size:
            raise ValueError(f'inconsistent size for content-addressed object: {digest}')
        objects[digest] = size
    return entries, objects


def blob_path(store, digest):
    return authority.safe_file(store, f'objects/{digest[:2]}/{digest}', existing=False)


def verify_file(file, digest, size, label):
    if not file.is_file() or file.stat().st_size != size or authority.checksum(file) != digest:
        raise ValueError(f'{label} size/SHA-256 mismatch: {file}')


def verify_file_identity(file, digest, size, label):
    """verify_file, plus the (device, inode) identity of the hashed bytes.

    The identity comes from fstat on the open stream, so it names the
    exact bytes whose digest was just checked.
    """
    if not file.is_file():
        raise ValueError(f'{label} size/SHA-256 mismatch: {file}')
    with file.open('rb') as stream:
        info = os.fstat(stream.fileno())
        if info.st_size != size or hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
            raise ValueError(f'{label} size/SHA-256 mismatch: {file}')
    return (info.st_dev, info.st_ino)


def _verify_job(job):
    key, spec, digest, size, label = job
    try:
        if spec[0] == 'safe':
            target = authority.safe_file(spec[1], spec[2])
        elif spec[0] == 'collect-missing':
            target = spec[1]
            if not target.exists():
                return key, 'missing', None
        else:
            target = spec[1]
        return key, 'ok', verify_file_identity(target, digest, size, label)
    except ValueError as error:
        return key, 'error', error


def _run_verify_jobs(jobs):
    """Run content verifications on a thread pool; outcomes keyed by job key.

    Hashing bulk file contents releases the GIL, so threads divide the
    multi-GB verification reads across cores. Callers re-raise outcomes
    in inventory order, so the first failure reported is the same one
    the serial walk reported.
    """
    outcomes = {}
    if jobs:
        workers = min(8, os.cpu_count() or 1, len(jobs))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for key, status, payload in pool.map(_verify_job, jobs):
                outcomes[key] = (status, payload)
    return outcomes


def install_file(source, destination, digest, size):
    """Byte-check while copying; atomic, non-overwriting and crash-resumable."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.theme-lab-blob-', dir=destination.parent)
    try:
        checksum = hashlib.sha256()
        copied = 0
        with os.fdopen(fd, 'wb') as out, source.open('rb') as inp:
            while chunk := inp.read(1024 * 1024):
                copied += len(chunk)
                checksum.update(chunk)
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        if copied != size or checksum.hexdigest() != digest:
            raise ValueError(f'input changed during copy: {source}')
        Path(tmp).chmod(0o444)
        os.link(tmp, destination, follow_symlinks=False)
    finally:
        Path(tmp).unlink(missing_ok=True)


def link_file(blob, destination, digest, size, verified_identities=None):
    """Hardlink an already verified read-only blob: no copy, no overwrite.

    Falls back to the checked copy when the store is on another filesystem.
    A blob swapped between the plan and the link cannot enter the checkout:
    the linked file must be the inode whose bytes were hashed under this
    digest in this run (`verified_identities`, keyed by device and inode), and
    anything else is hashed in full.
    """
    if blob.stat().st_mode & 0o222:
        raise ValueError(f'stored blob is writable, refusing to share it: {blob}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(blob, destination, follow_symlinks=False)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        install_file(blob, destination, digest, size)
        return
    try:
        info = destination.lstat()
        if not (verified_identities and info.st_size == size
                and verified_identities.get((info.st_dev, info.st_ino)) == digest):
            verify_file(destination, digest, size, 'linked evidence')
    except ValueError:
        destination.unlink()
        raise


def transfer(store_root, destination_root, inventory_path, expected_sha, *, mode, source_root=None, apply=False, link=False, reader=None):
    if mode not in ('ingest', 'restore'):
        raise ValueError('mode must be ingest or restore')
    if link and mode != 'restore':
        raise ValueError('--link applies only to restore')
    destination = Path(destination_root).resolve(strict=True)
    store_input = Path(store_root)
    if store_input.is_symlink():
        raise ValueError('store root cannot be a symlink')
    if not store_input.exists():
        if apply and mode == 'ingest':
            store_input.mkdir(parents=True)
        else:
            raise ValueError('store root is unavailable')
    store = store_input.resolve(strict=True)
    if not store.is_dir() or store == destination or store in destination.parents or destination in store.parents:
        raise ValueError('store and checkout must be independent directories')
    source = None
    if mode == 'ingest':
        if source_root is None:
            raise ValueError('ingest requires the source checkout')
        source = Path(source_root).resolve(strict=True)
        for other in (destination, store):
            if source == other or source in other.parents or other in source.parents:
                raise ValueError('source, store and destination must be independent')
    elif source_root is not None:
        raise ValueError('restore must not depend on the original source worktree')

    entries, objects = (reader or inventory_files)(destination, Path(inventory_path), expected_sha)
    # Every distinct object is verified once, as in the serial walk this
    # replaces; the hashing itself runs on a thread pool and the outcomes
    # are re-raised in inventory order below.
    jobs = []
    if mode == 'ingest':
        for rel, (digest, size) in entries.items():
            jobs.append((('source', rel), ('safe', source, rel), digest, size, 'source evidence'))
    for digest, size in objects.items():
        jobs.append((('blob', digest), ('collect-missing', blob_path(store, digest)), digest, size, 'stored blob'))
    outcomes = _run_verify_jobs(jobs)
    missing_objects = {}
    verified_identities = {}
    for rel, (digest, size) in entries.items():
        if mode == 'ingest':
            status, payload = outcomes[('source', rel)]
            if status == 'error':
                raise payload
            verified_identities[payload] = digest
        # Rechecking the same blob once per path can multiply multi-GB read
        # costs for deduplicated manifests. Verify each distinct SHA once.
        status, payload = outcomes[('blob', digest)]
        if status == 'error':
            raise payload
        if status == 'missing':
            missing_objects.setdefault(digest, (rel, size))
        else:
            verified_identities[payload] = digest
    if mode == 'restore' and missing_objects:
        raise ValueError(f'missing SHA-pinned blob objects: {len(missing_objects)}; example {next(iter(missing_objects))}')

    missing_files = []
    checkout_jobs = []
    for rel, (digest, size) in entries.items():
        target = authority.safe_file(destination, rel, existing=False)
        if not target.exists():
            missing_files.append((rel, digest, size))
            continue
        # A checkout file hardlinked to an object verified above -- the
        # shape --link restores create -- holds bytes already proven in
        # this run under the same digest, so it is not hashed a second
        # time. Any other file is hashed exactly as before.
        info = target.lstat()
        if info.st_size == size and verified_identities.get((info.st_dev, info.st_ino)) == digest:
            continue
        checkout_jobs.append((('checkout', rel), ('path', target), digest, size,
                              'existing checkout evidence'))
    checkout_outcomes = _run_verify_jobs(checkout_jobs)
    for rel in entries:
        outcome = checkout_outcomes.get(('checkout', rel))
        if outcome is not None and outcome[0] == 'error':
            raise outcome[1]

    if apply:
        if mode == 'ingest':
            for digest, (rel, size) in missing_objects.items():
                target = blob_path(store, digest)
                target.parent.mkdir(parents=True, exist_ok=True)
                target = blob_path(store, digest)
                install_file(authority.safe_file(source, rel), target, digest, size)
        else:
            for rel, digest, size in missing_files:
                target = authority.safe_file(destination, rel, existing=False)
                target.parent.mkdir(parents=True, exist_ok=True)
                target = authority.safe_file(destination, rel, existing=False)
                if link:
                    link_file(blob_path(store, digest), target, digest, size, verified_identities)
                else:
                    install_file(blob_path(store, digest), target, digest, size)

    return {'status': 'applied' if apply else 'verified-plan', 'mode': mode,
            'inventory_sha256': expected_sha, 'inventory_files': len(entries),
            'unique_blobs': len(objects), 'missing_blobs': len(missing_objects),
            'bytes_to_ingest': sum(size for _, size in missing_objects.values()),
            'checkout_files_missing': len(missing_files),
            'checkout_bytes_missing': sum(size for _, _, size in missing_files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', required=True, choices=('ingest', 'restore'))
    parser.add_argument('--source-root', type=Path)
    parser.add_argument('--destination-root', type=Path, required=True)
    parser.add_argument('--store-root', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--inventory-sha256', required=True)
    parser.add_argument('--apply', action='store_true', help='default is read-only verification')
    parser.add_argument('--link', action='store_true',
                        help='restore by hardlinking the verified read-only blobs (no extra disk)')
    args = parser.parse_args()
    print(json.dumps(transfer(args.store_root, args.destination_root, args.inventory,
                              args.inventory_sha256, mode=args.mode,
                              source_root=args.source_root, apply=args.apply,
                              link=args.link), indent=2))


if __name__ == '__main__':
    main()
