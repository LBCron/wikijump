#!/usr/bin/env python3
"""Ingest and restore the current campaign evidence inventory (#2506).

`campaign-inventory` is run on a checkout whose completion check passes. It
enumerates the allowlisted campaign trees, refuses any symlink or non-regular
entry, ingests the bytes into the shared content-addressed store (read-only,
byte-verified copies) and writes the inventory JSON. The inventory records the
expected receipt and run-contract SHA-256 values, so a restore can prove the
restored campaign is the one that passed.

`campaign-restore` is a pinned, no-overwrite restore. It reuses the transfer
path of content-addressed-authority-store.py with a campaign-specific inventory
reader, then verifies the restored receipt and run contracts against the
inventory. Unlike the authority restore, it never reads the source worktree.

Successor-bound exception (LA-34): LA-33a made the black-highlighter-theme
targeted evidence per-runtime, so a successor admission re-captures the
option-scenario receipts and screenshots on its own runtime and commits
them over the closure-era files at the same paths. For inventoried files
under SUCCESSOR_BOUND_PREFIXES whose checkout bytes differ from the
inventory, campaign-restore accepts the checkout bytes only when they are
hash-bound by the committed candidate freeze (the receipts and the visual
review via targeted_evidence_bindings, the screenshots via the bound
receipts' own rows) and the frozen blob for the path is still archived
and verified in the store. Anything else keeps failing closed on the
byte comparison, and the frozen record stays verifiable from the store.
When the #3381 LIVING_FILES exception (PR #3399) lands at the next
campaign freeze, it sits beside this mechanism, not in place of it.
Exception: paths in LIVING_FILES are living disposition records whose contents
legitimately move after the campaign closes (the exemption ledger's contract
bindings track the current acceptance instrument). Restore accepts the
checkout's current version of a living file and never overwrites it; the
frozen copy stays in the store and the published inventory. A checkout that
has no living file yet receives the frozen copy as its starting point.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess

HERE = Path(__file__).resolve().parent


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


store = _load('authority_blobs', 'content-addressed-authority-store.py')
authority = store.authority

SCHEMA = 'wikijump.theme_lab_current_campaign_evidence_inventory.v1'
THEME_LAB_REL = 'install/local/theme-lab'
RECEIPT = 'current-campaign-acceptance.json'
SIGMA9_DEFAULT = 'ports/current-acceptance/run-contract.json'
SIGMA10_DEFAULT = 'sigma10-migration/current-campaign/run-contract.json'
PROBE = HERE / 'campaign-completion-probe.mjs'
FREEZE_REL = 'publication/frozen-candidate-set.json'
# Inventoried trees whose files a successor admission legitimately replaces
# with runtime-bound successors (LA-34). Paths outside these prefixes never
# qualify for the successor-bound exception, even if a binding matches.
SUCCESSOR_BOUND_PREFIXES = ('ports/black-highlighter-theme/option-scenarios/runs/', 'ports/black-highlighter-theme/option-scenarios/captures/')
_SUCCESSOR_RUNS_PREFIX = SUCCESSOR_BOUND_PREFIXES[0]
_SUCCESSOR_CAPTURES_PREFIX = SUCCESSOR_BOUND_PREFIXES[1]
_SUCCESSOR_SCREENSHOT_SEPARATOR = '/install/local/theme-lab/'
# Post-closure living files (owner decision, 2026-10-30, issue #3381). See the
# module docstring: restore accepts the checkout's current version of these
# paths instead of verifying them against the frozen inventory.
LIVING_FILES = frozenset({
    'ports/current-acceptance/faithful-design-exemptions.json',
})
# Directory trees (theme-lab relative) that the campaign depends on. Each one
# is enumerated only if it exists; a missing tree simply contributes nothing,
# and the completion check decides whether that is acceptable.
# W17 (COMPLETION-TRACKER manifest TODOs): nav-source-submenu and
# source-navigation-overlays evidence, current-acceptance source-oracles
# (already under ports/current-acceptance), and only the runs/ and captures/
# subtrees of black-highlighter-theme option-scenarios. ports/authority-evidence
# is otherwise NOT inventoried here: the authority restore
# (restore-checkout-authority-evidence.sh) already covers it, except the
# source-navigation-overlays proof the campaign completion opens directly
# (navigation-overlay-provenance.mjs) and the authority supplement omits.
TREE_ROOTS = (
    'ports/current-acceptance',
    'ports/migration/sigma10-current',
    'ports/migration/sigma10-campaign-20261028-s10b',
    'ports/authority-evidence/source-navigation-overlays-20261001',
    'ports/black-highlighter-theme/option-scenarios/runs',
    'ports/black-highlighter-theme/option-scenarios/captures',
    'sigma10-migration/current-campaign',
    'sigma10-migration/sources',
    'sigma10-migration/fixtures',
    'sigma10-migration/baseline-probe',
)
EVIDENCE_CHILD = re.compile(r'(?:search-controls|sigma10-baseline|nav-source-submenu|source-navigation-overlays)-[A-Za-z0-9][A-Za-z0-9._-]*')
# The complete allowlist of inventoried files. Anything else is refused on
# both the build and the restore side.
ALLOWED = re.compile(
    r'current-campaign-acceptance\.json'
    r'|(?:ports/(?:current-acceptance|migration/sigma10-current|migration/sigma10-campaign-20261028-s10b|authority-evidence/source-navigation-overlays-20261001)'
    r'|ports/black-highlighter-theme/option-scenarios/(?:runs|captures)'
    r'|sigma10-migration/(?:current-campaign|sources|fixtures|baseline-probe)'
    r'|evidence/(?:search-controls|sigma10-baseline|nav-source-submenu|source-navigation-overlays)-[A-Za-z0-9][A-Za-z0-9._-]*)/.+'
)


def allowed_path(rel):
    if not isinstance(rel, str) or '\\' in rel or '\0' in rel or rel.startswith('/'):
        return False
    if any(part in ('', '.', '..') for part in rel.split('/')):
        return False
    return ALLOWED.fullmatch(rel) is not None


def valid_sha(value):
    return isinstance(value, str) and authority.SHA.fullmatch(value) is not None


def no_symlink_chain(root, rel):
    """Return the entry's lstat, or None when absent; refuse symlinks on the way."""
    current, info = root, None
    for part in PurePosixPath(rel).parts:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(info.st_mode):
            raise ValueError(f'symlink in campaign source: {rel}')
    return info


def walk(root, rel, found):
    with os.scandir(root / rel) as entries:
        for entry in sorted(entries, key=lambda item: item.name):
            child = f'{rel}/{entry.name}'
            if entry.is_symlink():
                raise ValueError(f'symlink in campaign source: {child}')
            if entry.is_dir(follow_symlinks=False):
                walk(root, child, found)
            elif entry.is_file(follow_symlinks=False):
                found.append(child)
            else:
                raise ValueError(f'non-regular campaign source entry: {child}')


def enumerate_campaign_files(theme_lab):
    theme_lab = Path(theme_lab)
    found = []
    for rel in TREE_ROOTS:
        info = no_symlink_chain(theme_lab, rel)
        if info is None:
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError(f'campaign source is not a directory: {rel}')
        walk(theme_lab, rel, found)
    info = no_symlink_chain(theme_lab, 'evidence')
    if info is not None:
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError('campaign source evidence is not a directory')
        with os.scandir(theme_lab / 'evidence') as entries:
            for entry in sorted(entries, key=lambda item: item.name):
                if entry.is_symlink():
                    raise ValueError(f'symlink in campaign source: evidence/{entry.name}')
                if EVIDENCE_CHILD.fullmatch(entry.name):
                    if not entry.is_dir(follow_symlinks=False):
                        raise ValueError(f'non-directory campaign evidence tree: evidence/{entry.name}')
                    walk(theme_lab, f'evidence/{entry.name}', found)
    info = no_symlink_chain(theme_lab, RECEIPT)
    if info is not None:
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f'non-regular campaign receipt: {RECEIPT}')
        found.append(RECEIPT)
    found.sort()
    refuse_collisions(found)
    for rel in found:
        if not allowed_path(rel):
            raise ValueError(f'campaign source path outside the allowlist: {rel}')
    return found


def refuse_collisions(paths):
    seen, folded = set(), set()
    for rel in paths:
        if rel in seen:
            raise ValueError(f'duplicate campaign path: {rel}')
        if rel.casefold() in folded:
            raise ValueError(f'case-colliding campaign path: {rel}')
        seen.add(rel)
        folded.add(rel.casefold())


def normalize_contract(value, default):
    rel = default if value is None else value
    if not isinstance(rel, str) or not rel or rel.startswith('/') or '\\' in rel or any(part in ('', '.', '..') for part in rel.split('/')):
        raise ValueError(f'run contract path is not a theme-lab relative path: {value}')
    return rel


def run_checker(theme_lab, sigma9, sigma10):
    command = ['node', str(PROBE), '--root', str(theme_lab)]
    if sigma9:
        command += ['--sigma9-run-contract', sigma9]
    if sigma10:
        command += ['--sigma10-run-contract', sigma10]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {'status': 'error', 'failures': [completed.stderr[-500:] or 'completion probe produced no JSON']}


def build_inventory(checkout_root, store_root, output, *, sigma9=None, sigma10=None, checker=run_checker):
    checkout = Path(checkout_root).resolve(strict=True)
    info = no_symlink_chain(checkout, THEME_LAB_REL)
    if info is None or not stat.S_ISDIR(info.st_mode):
        raise ValueError('campaign source is not a checkout with a Theme Lab directory')
    theme_lab = checkout / THEME_LAB_REL
    sigma9 = normalize_contract(sigma9, SIGMA9_DEFAULT)
    sigma10 = normalize_contract(sigma10, SIGMA10_DEFAULT)
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise ValueError(f'refusing to overwrite inventory output: {output}')

    observed = checker(theme_lab, None if sigma9 == SIGMA9_DEFAULT else sigma9, None if sigma10 == SIGMA10_DEFAULT else sigma10)
    if observed.get('status') != 'pass':
        raise ValueError(f"campaign completion checker is not pass: {observed.get('status')}")

    rels = enumerate_campaign_files(theme_lab)
    rows = {}
    for rel in rels:
        source = authority.safe_file(theme_lab, rel)
        digest = authority.checksum(source)
        rows[rel] = (digest, source.stat().st_size)
    for label, rel in (('receipt', RECEIPT), ('sigma9 run contract', sigma9), ('sigma10 run contract', sigma10)):
        if rel not in rows:
            raise ValueError(f'{label} is not in the campaign evidence set: {rel}')
    store_path = Path(store_root)
    if store_path.is_symlink():
        raise ValueError('store root cannot be a symlink')
    store_path.mkdir(parents=True, exist_ok=True)
    store_real, lab_real = store_path.resolve(strict=True), theme_lab.resolve(strict=True)
    if store_real == lab_real or store_real in lab_real.parents or lab_real in store_real.parents:
        raise ValueError('store and campaign source must be independent')
    for rel in rels:
        digest, size = rows[rel]
        blob = store.blob_path(store_real, digest)
        if blob.exists():
            store.verify_file(blob, digest, size, 'stored blob')
        else:
            store.install_file(authority.safe_file(theme_lab, rel), blob, digest, size)

    def binding(rel):
        digest, size = rows[rel]
        return {'path': rel, 'sha256': digest}

    doc = {
        'schema': SCHEMA,
        'receipt': binding(RECEIPT),
        'run_contracts': {'sigma9': binding(sigma9), 'sigma10': binding(sigma10)},
        'checker': {'command': 'campaign-completion-probe', 'status': 'pass',
                    'failure_count': len(observed.get('failures') or [])},
        'files': [{'relative_path': rel, 'sha256': rows[rel][0], 'size_bytes': rows[rel][1]} for rel in rels],
    }
    output.write_text(json.dumps(doc, indent=2) + '\n')
    return {'status': 'built', 'inventory_files': len(rels),
            'unique_blobs': len({digest for digest, _ in rows.values()}),
            'checker_status': 'pass', 'output': str(output)}


def campaign_inventory_files(destination, inventory_path, expected_sha):
    """Campaign reader for the shared transfer: same (entries, objects) contract."""
    if not valid_sha(expected_sha) or authority.checksum(inventory_path) != expected_sha:
        raise ValueError('inventory SHA-256 mismatch')
    doc = json.loads(inventory_path.read_text())
    if not isinstance(doc, dict) or doc.get('schema') != SCHEMA:
        raise ValueError('invalid campaign inventory schema')
    files = doc.get('files')
    if not isinstance(files, list) or not files:
        raise ValueError('invalid campaign inventory files')
    checker = doc.get('checker')
    if not isinstance(checker, dict) or checker.get('status') != 'pass':
        raise ValueError('campaign inventory was not built from a passing completion check')
    entries, folded = {}, set()
    for row in files:
        if not isinstance(row, dict):
            raise ValueError('invalid campaign inventory entry')
        rel, digest, size = row.get('relative_path'), row.get('sha256'), row.get('size_bytes')
        if (not allowed_path(rel) or not valid_sha(digest) or type(size) is not int or size < 0 or rel in entries):
            raise ValueError('invalid, disallowed or duplicate campaign inventory entry')
        if rel.casefold() in folded:
            raise ValueError(f'case-colliding campaign inventory path: {rel}')
        folded.add(rel.casefold())
        authority.safe_file(destination, rel, existing=False)
        entries[rel] = (digest, size)
    runs = doc.get('run_contracts')
    if not isinstance(runs, dict) or set(runs) != {'sigma9', 'sigma10'}:
        raise ValueError('invalid campaign run-contract bindings')
    for label, value in (('receipt', doc.get('receipt')), ('sigma9 run contract', runs['sigma9']), ('sigma10 run contract', runs['sigma10'])):
        if not isinstance(value, dict) or not allowed_path(value.get('path')) or not valid_sha(value.get('sha256')):
            raise ValueError(f'invalid {label} binding')
        entry = entries.get(value['path'])
        if entry is None or entry[0] != value['sha256']:
            raise ValueError(f'{label} binding is not an inventoried file with that SHA-256')
    if doc['receipt']['path'] != RECEIPT:
        raise ValueError('campaign receipt binding has the wrong path')
    objects = {}
    for digest, size in entries.values():
        if digest in objects and objects[digest] != size:
            raise ValueError(f'inconsistent size for content-addressed object: {digest}')
        objects[digest] = size
    return entries, objects


def canonical_successor_screenshot(recorded):
    """Mirror canonicalBhlScreenshotPath: the theme-lab relative capture
    path for a recorded screenshot, or None when it is not a confined PNG
    under the frozen capture directory."""
    if not isinstance(recorded, str) or not recorded:
        return None
    if recorded.startswith(_SUCCESSOR_CAPTURES_PREFIX):
        relative = recorded
    elif recorded.startswith('/') and _SUCCESSOR_SCREENSHOT_SEPARATOR in recorded:
        relative = recorded.rsplit(_SUCCESSOR_SCREENSHOT_SEPARATOR, 1)[-1]
    else:
        return None
    if not relative.startswith(_SUCCESSOR_CAPTURES_PREFIX) or not relative.endswith('.png'):
        return None
    if any(part in ('', '.', '..') for part in relative.split('/')):
        return None
    return relative


def successor_freeze_bindings(theme_lab):
    """(receipt SHA-256 by path, visual-review SHA-256 by path) recorded in
    the candidate freeze's targeted_evidence_bindings.

    The freeze is read through authority.safe_file, so a symlinked or
    non-regular freeze fails closed here; a malformed freeze simply
    yields no bindings, which also fails closed downstream."""
    target = authority.safe_file(theme_lab, FREEZE_REL)
    doc = json.loads(target.read_text())
    receipts, reviews = {}, {}
    if not isinstance(doc, dict):
        return receipts, reviews
    bindings = doc.get('targeted_evidence_bindings')
    if not isinstance(bindings, list):
        return receipts, reviews
    for item in bindings:
        if not isinstance(item, dict):
            continue
        for row in item.get('receipts') or []:
            if isinstance(row, dict) and isinstance(row.get('path'), str) and valid_sha(row.get('sha256')):
                receipts[row['path']] = row['sha256']
        review = item.get('visual_review')
        if isinstance(review, dict) and isinstance(review.get('path'), str) and valid_sha(review.get('sha256')):
            reviews[review['path']] = review['sha256']
    return receipts, reviews


def successor_bound_plan(theme_lab, store_root, entries):
    """Plan the LA-34 successor-bound exception for one restore.

    Returns one row per inventoried file under SUCCESSOR_BOUND_PREFIXES
    whose checkout bytes differ from the inventory yet are fully bound:
    the frozen blob is archived and verified in the store, and the
    checkout SHA-256 is the one the candidate freeze binds for that exact
    path (receipts and the visual review directly; screenshots through a
    row of a receipt that is itself bound in this same plan, with a
    unique path match). Differing files that fail any condition are left
    out of the plan, so the shared transfer keeps failing closed on them
    with the existing mismatch error."""
    differing = {}
    for rel, (digest, size) in entries.items():
        if not rel.startswith(SUCCESSOR_BOUND_PREFIXES):
            continue
        target = authority.safe_file(theme_lab, rel, existing=False)
        if not target.exists():
            continue
        checkout_sha = authority.checksum(target)
        if checkout_sha != digest or target.stat().st_size != size:
            differing[rel] = checkout_sha
    if not differing:
        return []
    store_input = Path(store_root)
    if store_input.is_symlink():
        raise ValueError('store root cannot be a symlink')
    if not store_input.exists():
        return []  # the transfer itself reports the unavailable store
    store_real = store_input.resolve(strict=True)
    frozen_verified = set()
    for rel in differing:
        digest, size = entries[rel]
        blob = store.blob_path(store_real, digest)
        if blob.exists():
            store.verify_file(blob, digest, size, 'stored blob')
            frozen_verified.add(rel)
    receipt_bindings, review_bindings = successor_freeze_bindings(theme_lab)
    bound = {}
    bound_receipts = set()
    for rel, checkout_sha in differing.items():
        if rel not in frozen_verified or not rel.startswith(_SUCCESSOR_RUNS_PREFIX):
            continue
        if receipt_bindings.get(rel) == checkout_sha:
            bound[rel] = 'targeted_evidence_bindings.receipts'
            bound_receipts.add(rel)
        elif review_bindings.get(rel) == checkout_sha:
            bound[rel] = 'targeted_evidence_bindings.visual_review'
    if bound_receipts:
        rows_by_path = {}
        for receipt_rel in sorted(bound_receipts):
            try:
                doc = json.loads(authority.safe_file(theme_lab, receipt_rel).read_text())
            except (ValueError, json.JSONDecodeError):
                continue
            rows = doc.get('rows') if isinstance(doc, dict) else None
            if not isinstance(rows, list):
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                canonical = canonical_successor_screenshot(row.get('screenshot'))
                if canonical is None or not valid_sha(row.get('screenshot_sha256')):
                    continue
                rows_by_path.setdefault(canonical, []).append((receipt_rel, row['screenshot_sha256']))
        for rel, checkout_sha in differing.items():
            if rel not in frozen_verified or not rel.startswith(_SUCCESSOR_CAPTURES_PREFIX):
                continue
            matches = rows_by_path.get(rel) or []
            if len(matches) == 1 and matches[0][1] == checkout_sha:
                bound[rel] = f'targeted_evidence_bindings.receipt:{matches[0][0]}'
    return [{'path': rel, 'inventory_sha256': entries[rel][0],
             'checkout_sha256': differing[rel], 'bound_by': bound[rel]}
            for rel in sorted(bound)]


def verify_bindings(theme_lab, inventory_path, *, required):
    doc = json.loads(Path(inventory_path).read_text())
    rows = [('receipt', doc['receipt']), ('sigma9 run contract', doc['run_contracts']['sigma9']),
            ('sigma10 run contract', doc['run_contracts']['sigma10'])]
    checked = 0
    for label, row in rows:
        target = authority.safe_file(theme_lab, row['path'], existing=False)
        if not target.exists():
            if required:
                raise ValueError(f'restored {label} is missing: {row["path"]}')
            continue
        if not target.is_file() or authority.checksum(target) != row['sha256']:
            raise ValueError(f'restored {label} SHA-256 mismatch: {row["path"]}')
        checked += 1
    return checked


def restore(checkout_root, store_root, inventory_path, expected_sha, *, apply=False, link=False):
    checkout = Path(checkout_root).resolve(strict=True)
    info = no_symlink_chain(checkout, THEME_LAB_REL)
    if info is None or not stat.S_ISDIR(info.st_mode):
        raise ValueError('restore destination is not a checkout with a Theme Lab directory')
    theme_lab = checkout / THEME_LAB_REL
    entries, _objects = campaign_inventory_files(theme_lab, Path(inventory_path), expected_sha)
    living = {rel: entries[rel] for rel in LIVING_FILES if rel in entries}
    bound = successor_bound_plan(theme_lab, store_root, entries)
    bound_paths = {row['path'] for row in bound}

    def reader(destination, inventory, sha):
        filtered, objects = campaign_inventory_files(destination, inventory, sha)
        drop = bound_paths | set(living)
        if drop:
            filtered = {rel: value for rel, value in filtered.items() if rel not in drop}
            objects = {}
            for digest, size in filtered.values():
                if digest in objects and objects[digest] != size:
                    raise ValueError(f'inconsistent size for content-addressed object: {digest}')
                objects[digest] = size
        return filtered, objects

    result = store.transfer(store_root, theme_lab, inventory_path, expected_sha, mode='restore',
                            apply=apply, link=link, reader=reader)
    result['living_files'] = []
    for rel, (digest, size) in sorted(living.items()):
        target = authority.safe_file(theme_lab, rel, existing=False)
        if target.exists():
            result['living_files'].append({'path': rel, 'treatment': 'checkout-version-accepted'})
            continue
        if not apply:
            result['living_files'].append({'path': rel, 'treatment': 'absent (verification only)'})
            continue

        def living_reader(destination, path, sha, _rel=rel, _entry=(digest, size)):
            return {_rel: _entry}, {_entry[0]: _entry[1]}

        store.transfer(store_root, theme_lab, inventory_path, expected_sha, mode='restore',
                       apply=True, link=link, reader=living_reader)
        result['living_files'].append({'path': rel, 'treatment': 'frozen-copy-restored'})
    result['successor_bound'] = bound
    result['successor_bound_count'] = len(bound)
    result['bindings_verified'] = verify_bindings(theme_lab, inventory_path, required=apply)
    result['mode'] = 'campaign-restore'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', required=True, choices=('campaign-inventory', 'campaign-restore'))
    parser.add_argument('--checkout-root', type=Path, required=True)
    parser.add_argument('--store-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, help='campaign-inventory: inventory JSON to write (must not exist)')
    parser.add_argument('--sigma9-run-contract', help='theme-lab relative path; default is the shared contract')
    parser.add_argument('--sigma10-run-contract', help='theme-lab relative path; default is the shared contract')
    parser.add_argument('--inventory', type=Path, help='campaign-restore: pinned inventory JSON')
    parser.add_argument('--inventory-sha256', help='campaign-restore: pinned SHA-256 of the inventory')
    parser.add_argument('--apply', action='store_true', help='default is read-only verification')
    parser.add_argument('--link', action='store_true', help='restore by hardlinking the verified read-only blobs')
    args = parser.parse_args()
    if args.mode == 'campaign-inventory':
        if args.output is None:
            parser.error('campaign-inventory requires --output')
        result = build_inventory(args.checkout_root, args.store_root, args.output,
                                 sigma9=args.sigma9_run_contract, sigma10=args.sigma10_run_contract)
    else:
        if args.inventory is None or args.inventory_sha256 is None:
            parser.error('campaign-restore requires --inventory and --inventory-sha256')
        result = restore(args.checkout_root, args.store_root, args.inventory, args.inventory_sha256,
                         apply=args.apply, link=args.link)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
