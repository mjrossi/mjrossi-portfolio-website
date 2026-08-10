import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdminPath } from './admin-path.js';

// Three things have to agree on this answer — the middleware gate, the sitemap
// filter, and the Cloudflare Access path pattern. See admin-path.js.

test('the Desk root matches, with or without a trailing slash', () => {
  assert.equal(isAdminPath('/admin'), true);
  assert.equal(isAdminPath('/admin/'), true);
});

test('everything under the Desk matches', () => {
  assert.equal(isAdminPath('/admin/why-im-pivoting'), true);
  assert.equal(isAdminPath('/admin/why-im-pivoting/'), true);
  assert.equal(isAdminPath('/admin/a/b/c'), true);
});

test('a path that merely BEGINS with the letters does not match', () => {
  // The isPreviewHost trap, one layer down: a bare startsWith would 404 these
  // for everyone without an Access token, silently.
  assert.equal(isAdminPath('/administrator'), false);
  assert.equal(isAdminPath('/admin-notes'), false);
  assert.equal(isAdminPath('/admins'), false);
});

test('the Desk nested under something else does not match', () => {
  assert.equal(isAdminPath('/blog/admin'), false);
  assert.equal(isAdminPath('/x/admin/y'), false);
});

test('ordinary routes do not match', () => {
  for (const path of ['/', '/blog', '/work', '/blog/rss.xml', '/api/galley', '/404']) {
    assert.equal(isAdminPath(path), false, `${path} matched`);
  }
});

test('case matters, so this never claims a path Access is not covering', () => {
  // Access matches case-sensitively. Treating /ADMIN as the Desk here would
  // create a path this code protects and the edge does not.
  assert.equal(isAdminPath('/ADMIN'), false);
  assert.equal(isAdminPath('/Admin/x'), false);
});

test('non-strings are not the Desk', () => {
  for (const value of [null, undefined, 0, {}, []]) {
    assert.equal(isAdminPath(value), false);
  }
});
