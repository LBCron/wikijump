import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = rel => fs.readFileSync(path.join(lab, rel));
const json = rel => JSON.parse(read(rel).toString('utf8'));

test('the sibling mobile and narrow-mobile search receipt binds the frozen source and each measured viewport', () => {
  const receipt = json('evidence/search-controls-20261022/basalt.json');
  assert.equal(receipt.schema, 'theme_lab_wikidot_search_control.v1');
  assert.equal(receipt.source_sha256, 'df4b78d344536f5b7c363ac86b2ddc6f3c31b3647693f473169550e03fca17c5');
  assert.equal(receipt.public_writes, 0);
  assert.equal(receipt.external_requests_sent, 0);
  assert.equal(receipt.offline, true);
  const sizes = {mobile: {width: 390, height: 844}, 'narrow-mobile': {width: 320, height: 800}};
  assert.deepEqual(receipt.source_measurements.map(m => m.viewport).sort(), Object.keys(sizes).sort());
  for (const m of receipt.source_measurements) {
    assert.deepEqual(m.viewport_size, sizes[m.viewport]);
    assert.equal(m.source_sha256, receipt.source_sha256);
    assert.equal(m.original_html_sha256, receipt.original_html_sha256);
    assert.equal(m.loaded.offline, true);
    assert.equal(m.after_focus.display, 'none');
    assert.equal(m.action_error, null);
    assert.equal(m.navigation, '/search:site/q/' + encodeURIComponent(m.after_focus.value));
    assert.ok(m.handler.events.some(event => event.type === 'submit' && event.fn === m.handler.search));
  }
});

test('every artifact of the sibling search receipt is present with its recorded SHA-256', () => {
  const receipt = json('evidence/search-controls-20261022/basalt.json');
  const names = receipt.artifacts.map(a => a.path);
  assert.ok(names.includes('evidence/search-controls-20261022/objects/' + receipt.original_html_sha256.slice(0, 2) + '/' + receipt.original_html_sha256));
  assert.ok(names.includes(receipt.replay_entry.replace('/o/', 'evidence/search-controls-20261022/objects/').replace(/\/([0-9a-f]{64})$/u, (_, d) => '/' + d.slice(0, 2) + '/' + d)));
  for (const artifact of receipt.artifacts) assert.equal(sha(read(artifact.path)), artifact.sha256, artifact.path);
  for (const program of receipt.measurement_programs) assert.equal(sha(read(program.path)), program.sha256, program.path);
});

test('the nav submenu source receipt records the translucent frozen menu at tablet, mobile and narrow-mobile', () => {
  const receipt = json('evidence/nav-source-submenu-20261022/basalt.json');
  assert.equal(receipt.schema, 'theme_lab_source_navigation_submenu.v1');
  assert.deepEqual(receipt.source_measurements.map(m => m.viewport), ['tablet', 'mobile', 'narrow-mobile']);
  for (const m of receipt.source_measurements) {
    assert.equal(m.action_error, null);
    assert.deepEqual(m.backgrounds, ['rgba(252, 252, 252, 0.875)']);
    assert.deepEqual(m.backdrops, ['blur(1.6px)']);
    assert.equal(m.links_overlapping_title, 12);
    assert.equal(sha(read(m.screenshot_png)), m.screenshot_sha256);
  }
  for (const artifact of receipt.artifacts) assert.equal(sha(read(artifact.path)), artifact.sha256, artifact.path);
});
