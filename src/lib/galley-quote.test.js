import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collapse,
  locateQuote,
  findQuote,
  rawOffsetOf,
  collapsedOffsetOf,
  anchorSelection,
} from '../../public/scripts/galley-quote.js';

// The module under test lives in public/scripts/ because public/scripts/galley.js
// imports it over HTTP at runtime — it is served, not bundled. Tested from here
// because `npm test` globs src/**/*.test.js, and because the alternative (a
// *.test.js next to it) would be served to the public alongside it.

// ── collapse ───────────────────────────────────────────

test('collapse matches the normalisation resolveSelection applies to a quote', () => {
  assert.equal(collapse('  hello   there \n'), 'hello there');
  assert.equal(collapse('one\n\ttwo'), 'one two');
  assert.equal(collapse(''), '');
  assert.equal(collapse('   '), '');
});

test('collapse folds a non-breaking space, because textContent carries U+00A0 verbatim', () => {
  // &nbsp; in the .mdx reaches both sides of the comparison as U+00A0 — the
  // selection the reviewer made and the block we later search. \s matches it,
  // so both fold to a plain space and the quote is still findable.
  assert.equal(collapse('a\u00a0b'), 'a b');
});

// ── locateQuote ────────────────────────────────────────

test('locateQuote finds a unique quote', () => {
  assert.equal(locateQuote('the quick brown fox', 'quick brown'), 4);
  assert.equal(locateQuote('the quick brown fox', 'the'), 0);
});

test('locateQuote refuses an ambiguous quote rather than guessing an occurrence', () => {
  // The whole stance of this feature: a marker on the wrong passage is worse
  // than no marker. Same rule galley-relocate.js applies on the pull side.
  assert.equal(locateQuote('a note, and another note', 'note'), -1);
});

test('locateQuote refuses a quote that is not there', () => {
  assert.equal(locateQuote('the quick brown fox', 'lazy dog'), -1);
  assert.equal(locateQuote('', 'anything'), -1);
  assert.equal(locateQuote('the quick brown fox', ''), -1);
});

// ── findQuote ──────────────────────────────────────────

test('findQuote locates a quote inside a single text node', () => {
  assert.deepEqual(findQuote(['the quick brown fox'], 'quick brown'), {
    startIndex: 0,
    startOffset: 4,
    endIndex: 0,
    endOffset: 15,
  });
});

test('findQuote spans text nodes, which is the normal case for a selection over a link', () => {
  // `we shipped [the Atlas](…) last spring` renders as three text nodes, and an
  // editor selecting a whole sentence crosses all of them. If this returned
  // null the highlight would be dead exactly where it is most wanted.
  const texts = ['we shipped ', 'the Atlas', ' last spring'];
  assert.deepEqual(findQuote(texts, 'shipped the Atlas last'), {
    startIndex: 0,
    startOffset: 3,
    endIndex: 2,
    endOffset: 5,
  });
});

test('findQuote collapses a whitespace run that straddles a node boundary', () => {
  // The rendered text has a source line break inside it. The quote the client
  // recorded was already collapsed, so the search side has to collapse the same
  // way — across the boundary, not per node.
  const texts = ['A line\n', '  and more'];
  assert.deepEqual(findQuote(texts, 'line and'), {
    startIndex: 0,
    startOffset: 2,
    endIndex: 1,
    endOffset: 5,
  });
});

test('findQuote maps through collapsed runs to RAW offsets', () => {
  // 'one   two' collapses to 'one two', so the quote's collapsed length (7) is
  // shorter than the raw span (9). Returning collapsed offsets would end the
  // highlight two characters early, mid-word.
  assert.deepEqual(findQuote(['one   two'], 'one two'), {
    startIndex: 0,
    startOffset: 0,
    endIndex: 0,
    endOffset: 9,
  });
});

test('findQuote accounts for whitespace trimmed off the front of the block', () => {
  // block.textContent routinely starts with the newline and indentation that
  // preceded the text in the HTML. collapse() trims it; the raw offsets must not.
  assert.deepEqual(findQuote(['\n  Hello there  \n'], 'Hello'), {
    startIndex: 0,
    startOffset: 3,
    endIndex: 0,
    endOffset: 8,
  });
});

test('findQuote handles a quote at each end of the block', () => {
  const texts = ['first', ' middle ', 'last'];
  // Ends on a node boundary. Range treats "end of node 0" and "start of node 1"
  // as the same position, and the tight encoding is the one asserted: the loose
  // one would reach into the following element to enclose no characters of it.
  assert.deepEqual(findQuote(texts, 'first'), {
    startIndex: 0,
    startOffset: 0,
    endIndex: 0,
    endOffset: 5,
  });
  // Starts on a node boundary — resolved the other way, into the node that
  // actually holds the quoted characters.
  assert.deepEqual(findQuote(texts, 'last'), {
    startIndex: 2,
    startOffset: 0,
    endIndex: 2,
    endOffset: 4,
  });
});

test('findQuote folds a non-breaking space on both sides', () => {
  assert.deepEqual(findQuote(['an\u00a0em dash'], 'an em'), {
    startIndex: 0,
    startOffset: 0,
    endIndex: 0,
    endOffset: 5,
  });
});

test('findQuote skips empty text nodes without shifting the mapping', () => {
  assert.deepEqual(findQuote(['ab', '', 'cd'], 'bc'), {
    startIndex: 0,
    startOffset: 1,
    endIndex: 2,
    endOffset: 1,
  });
});

test('findQuote returns null rather than a marker on the wrong passage', () => {
  assert.equal(findQuote(['a note, and another note'], 'note'), null);
  assert.equal(findQuote(['the quick brown fox'], 'lazy dog'), null);
});

test('findQuote returns null for the inputs a note can legitimately carry', () => {
  // quote is nullable in the schema — a whole-draft note has no anchor at all
  // (src/lib/galley.js). Those fall back to the block marker; they must not throw.
  assert.equal(findQuote(['some text'], null), null);
  assert.equal(findQuote(['some text'], ''), null);
  assert.equal(findQuote(['some text'], '   '), null);
  assert.equal(findQuote([], 'anything'), null);
  assert.equal(findQuote(['', ''], 'anything'), null);
});

test('findQuote tolerates a quote the client trimmed differently', () => {
  // The stored quote went through clean() in src/lib/galley.js, which trims
  // again. Collapsing the quote here means neither side has to have been first.
  assert.deepEqual(findQuote(['the quick brown fox'], '  quick   brown '), {
    startIndex: 0,
    startOffset: 4,
    endIndex: 0,
    endOffset: 15,
  });
});

// ── collapsedOffsetOf: measuring where a selection starts ──

test('collapsedOffsetOf keeps the space BEFORE the selection, which collapse() would trim', () => {
  // The asymmetry this function is built around. A position is not a string:
  // the quote 'there' begins at collapsed index 6 of 'Hello there', and the raw
  // text before it ends with the space. Trimming it reports 5 — every anchor in
  // a block one character short, and prefix/suffix sliced one character off.
  const texts = ['Hello there'];
  assert.equal(collapsedOffsetOf(texts, 6), 6);
  assert.equal(collapse('Hello '), 'Hello'); // what trimming would have given
});

test('collapsedOffsetOf drops whitespace the block OPENS with', () => {
  // textContent routinely starts with the newline and indentation from the
  // HTML. collapse() drops it from blockText, so a quote at the very start of
  // the block has to measure as 0 or nothing will line up.
  assert.equal(collapsedOffsetOf(['\n  Hello there'], 3), 0);
});

test('collapsedOffsetOf folds a run to the single space it becomes', () => {
  assert.equal(collapsedOffsetOf(['one   two'], 6), 4);
});

test('collapsedOffsetOf reports -1 for a position it cannot measure', () => {
  // Distinct from 0. anchorSelection treats -1 as "not measured" and falls back
  // to indexOf; treating it as position zero would silently anchor every
  // unmeasurable selection to the start of the block.
  assert.equal(collapsedOffsetOf(['text'], -1), -1);
  assert.equal(collapsedOffsetOf(null, 0), -1);
});

// ── anchorSelection ────────────────────────────────────

test('anchorSelection records the quote with context either side', () => {
  const texts = ['The quick brown fox jumps over the lazy dog.'];
  const anchor = anchorSelection(texts, 4, 'quick brown', 8);
  assert.equal(anchor.quote, 'quick brown');
  assert.equal(anchor.prefix, 'The ');
  assert.equal(anchor.suffix, ' fox jum');
  assert.equal(anchor.at, 4);
});

test('anchorSelection anchors the SECOND of two identical sentences to itself', () => {
  // The case the measured offset exists for, and the reason indexOf alone is
  // not enough. Selecting the second sentence must not come back with context
  // describing the first — galley-pull.mjs would then relocate the note onto
  // the wrong passage, confidently, months later.
  const texts = ['It matters. It matters. And then more.'];
  const anchor = anchorSelection(texts, 12, 'It matters.', 32);
  assert.equal(anchor.at, 12);
  assert.equal(anchor.prefix, 'It matters. ');
  assert.equal(anchor.suffix, ' And then more.');

  // Unmeasured, the same selection collapses onto the first occurrence — which
  // is exactly the bug, and is what the fallback costs when it has to be used.
  assert.equal(anchorSelection(texts, -1, 'It matters.', 32).at, 0);
});

test('anchorSelection falls back to indexOf when the measured offset does not fit', () => {
  // A nested element's text need not appear verbatim where the measurement
  // lands. The quote is still the reviewer's, so place it rather than refuse.
  const texts = ['we shipped ', 'the Atlas', ' last spring'];
  const anchor = anchorSelection(texts, 999, 'the Atlas', 32);
  assert.equal(anchor.at, 11);
  assert.equal(anchor.quote, 'the Atlas');
});

test('anchorSelection clamps a selection dragged past the end of its block', () => {
  // The editor kept dragging into the next paragraph. Everything after the
  // block boundary belongs to a block this anchor does not name, so the quote
  // is cut back to what is actually inside it. Without this the note saves with
  // a quote that appears in no block at all and can never be relocated.
  const texts = ['A first block sentence.'];
  const anchor = anchorSelection(texts, 2, 'first block sentence. And the next block too.', 32);
  assert.equal(anchor.quote, 'first block sentence.');
  assert.equal(anchor.at, 2);
  assert.equal(anchor.prefix, 'A ');
  assert.equal(anchor.suffix, '');
});

test('anchorSelection refuses rather than quoting a whole block it was never given', () => {
  // Unmeasurable start AND an unplaceable quote. The clamp needs somewhere to
  // clamp from; without it, taking the rest of the block would file a note
  // quoting a paragraph the reviewer never selected.
  assert.equal(anchorSelection(['A first block sentence.'], -1, 'text from elsewhere'), null);
});

test('anchorSelection refuses an empty selection', () => {
  assert.equal(anchorSelection(['some text'], 0, '   '), null);
  assert.equal(anchorSelection(['some text'], 0, ''), null);
  assert.equal(anchorSelection(['some text'], 0, null), null);
});

test('anchorSelection collapses the selection the same way the block is collapsed', () => {
  // sel.toString() carries the source line break inside the selection.
  const texts = ['A line\n', '  and more'];
  const anchor = anchorSelection(texts, 2, 'line\n  and', 32);
  assert.equal(anchor.quote, 'line and');
  assert.equal(anchor.at, 2);
});

// ── the invariants the two halves rest on ──────────────

test('anchorSelection and findQuote are inverses', () => {
  // The round trip this module exists to keep honest: what the write side
  // stores, the read side must find, at the position the write side meant.
  //
  //   selection → anchorSelection → quote → findQuote → node coords
  //             → rawOffsetOf → collapsedOffsetOf → the same offset back
  //
  // A one-character drift in either direction is invisible on its own: the note
  // saves, the marker appears, and only the words underneath are wrong.
  const cases = [
    { texts: ['The quick brown fox'], rawStart: 4, selected: 'quick brown' },
    { texts: ['we shipped ', 'the Atlas', ' last spring'], rawStart: 3, selected: 'shipped the Atlas' },
    { texts: ['A line\n', '  and more'], rawStart: 2, selected: 'line\n  and' },
    { texts: ['\n  Hello there  \n'], rawStart: 3, selected: 'Hello' },
    { texts: ['one   two three'], rawStart: 0, selected: 'one   two' },
    { texts: ['ab', '', 'cd ef'], rawStart: 1, selected: 'bcd' },
    // Both sides carry the U+00A0 a browser reports, and both must fold it.
    { texts: ['an\u00a0em dash here'], rawStart: 0, selected: 'an\u00a0em' },
  ];

  for (const { texts, rawStart, selected } of cases) {
    const label = JSON.stringify(selected);
    const anchor = anchorSelection(texts, rawStart, selected, 32);
    assert.ok(anchor, `anchorSelection placed nothing for ${label}`);

    const hit = findQuote(texts, anchor.quote);
    assert.ok(hit, `findQuote lost ${JSON.stringify(anchor.quote)}`);

    const backToRaw = rawOffsetOf(texts, hit.startIndex, hit.startOffset);
    assert.equal(
      collapsedOffsetOf(texts, backToRaw),
      anchor.at,
      `round trip moved the anchor for ${label}`,
    );

    // And the characters findQuote would mark are the ones anchorSelection
    // quoted — the property a reader of the page actually observes.
    const raw = texts.join('');
    const marked = raw.slice(backToRaw, rawOffsetOf(texts, hit.endIndex, hit.endOffset));
    assert.equal(collapse(marked), anchor.quote, `marked text differs for ${label}`);
  }
});

test('an ambiguous quote degrades to NO marker rather than to the wrong words', () => {
  // The headline claim of the marker work, composed end to end. Each half is
  // tested alone above — anchorSelection anchors the second sentence to itself,
  // findQuote refuses a quote that occurs twice — but the property that matters
  // only exists when they are joined: a note filed on the SECOND of two
  // identical sentences must light neither, rather than confidently lighting
  // the first. `null` is the only alternative to a hit, so this pins it.
  const texts = ['It matters. It matters. And then more.'];

  const anchor = anchorSelection(texts, 12, 'It matters.', 32);
  assert.equal(anchor.at, 12, 'the write side placed the anchor on the wrong occurrence');
  assert.equal(anchor.quote, 'It matters.');

  // The stored prefix/suffix DO disambiguate — galley-pull.mjs relocates with
  // them — but GET /api/galley does not return them, so the client has only the
  // quote and must give up rather than guess. That asymmetry is deliberate.
  assert.equal(anchor.prefix, 'It matters. ');
  assert.equal(findQuote(texts, anchor.quote), null);
});

test('the paths that place an anchor WITHOUT a measured offset still round-trip', () => {
  // The inverses test above drives every case through the measured path. These
  // two reach `at` another way, and each one is a place a marker could land on
  // different words than the note recorded.
  const cases = [
    // indexOf fallback: the measurement did not fit, the quote is still placed.
    {
      texts: ['we shipped ', 'the Atlas', ' last spring'],
      rawStart: 999,
      selected: 'the Atlas',
      quote: 'the Atlas',
    },
    // Clamp: the selection was dragged past the end of the block and cut back.
    {
      texts: ['A first block sentence.'],
      rawStart: 2,
      selected: 'first block sentence. And the next block too.',
      quote: 'first block sentence.',
    },
  ];

  for (const { texts, rawStart, selected, quote } of cases) {
    const label = JSON.stringify(selected);
    const anchor = anchorSelection(texts, rawStart, selected, 32);
    assert.ok(anchor, `anchorSelection placed nothing for ${label}`);
    assert.equal(anchor.quote, quote, `wrong quote stored for ${label}`);

    const hit = findQuote(texts, anchor.quote);
    assert.ok(hit, `findQuote lost ${JSON.stringify(anchor.quote)}`);

    const start = rawOffsetOf(texts, hit.startIndex, hit.startOffset);
    assert.equal(collapsedOffsetOf(texts, start), anchor.at, `round trip moved ${label}`);

    const marked = texts.join('').slice(start, rawOffsetOf(texts, hit.endIndex, hit.endOffset));
    assert.equal(collapse(marked), anchor.quote, `marked text differs for ${label}`);
  }
});

// ── the invariant the two halves rest on ───────────────

test('the incremental collapse inside findQuote agrees with collapse()', () => {
  // findQuote builds the collapsed string as it records raw offsets, so it does
  // not call collapse() on the block. If the two ever disagreed, a quote the
  // client captured with collapse() would stop being findable — silently, and
  // only for whichever whitespace shape had drifted. Pinned by construction:
  // every sample below must locate at the index collapse() puts it at.
  const samples = [
    ['plain text'],
    ['  leading', ' and\ttrailing  '],
    ['a\n\n\nb'],
    ['\u00a0edge\u00a0'],
    ['one', '', 'two'],
    ['trailing space '],
  ];
  for (const texts of samples) {
    const blockText = collapse(texts.join(''));
    if (!blockText) continue;
    const word = blockText.split(' ').find((w) => blockText.split(w).length === 2);
    if (!word) continue;
    const hit = findQuote(texts, word);
    assert.ok(hit, `expected to locate ${JSON.stringify(word)} in ${JSON.stringify(texts)}`);
    // Reconstruct what the browser would select from those coordinates.
    const raw = texts.join('');
    const before = texts.slice(0, hit.startIndex).join('').length + hit.startOffset;
    const after = texts.slice(0, hit.endIndex).join('').length + hit.endOffset;
    assert.equal(collapse(raw.slice(before, after)), word);
  }
});
