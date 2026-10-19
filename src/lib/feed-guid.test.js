// Unit tests for the RSS GUID. Run via `npm test`.
//
// A GUID is an identity, not a URL that happens to be correct today: once
// Buttondown has seen one, changing it means that post can be emailed again.
// So these pin literal strings the production feed was already serving, rather
// than re-deriving them from GUID_ORIGIN — a test that built its expectation
// the same way the code does would follow the code anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUID_ORIGIN, feedGuid } from './feed-guid.js';

test('GUIDs match what the feed served before they were pinned', () => {
  assert.equal(feedGuid('denormalized-by-design'), 'https://mjrossi.com/blog/denormalized-by-design/');
  assert.equal(
    feedGuid('the-atlas-data-was-the-hard-part'),
    'https://mjrossi.com/blog/the-atlas-data-was-the-hard-part/',
  );
});

test('the origin is the original domain, whatever the blog is served from', () => {
  assert.equal(GUID_ORIGIN, 'https://mjrossi.com');
});
