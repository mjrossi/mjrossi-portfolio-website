import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLocator,
  fenceFor,
  fold,
  pushFenced,
  pushQuoted,
  unmark,
} from './galley-relocate.js';

// The two invariants under test are the ones docs/GALLEY.md names by hand:
// typography must be folded on both sides before searching, and an ambiguous
// match must resolve to NOTHING rather than to a guess. Everything else here
// exists to keep those two honest.

// ── fold ─────────────────────────────────────────────

test('fold normalises the substitutions smartypants makes', () => {
  // The exact transformations Astro applies when rendering, in reverse.
  assert.equal(fold('the editor’s copy'), "the editor's copy");
  assert.equal(fold('a pause — then more'), 'a pause -- then more');
  assert.equal(fold('an en dash – here'), 'an en dash -- here');
  assert.equal(fold('trailing…'), 'trailing...');
  assert.equal(fold('“quoted”'), '"quoted"');
});

test('fold collapses whitespace, including the non-breaking space', () => {
  assert.equal(fold('two   words'), 'two words');
  assert.equal(fold('  padded  '), 'padded');
  assert.equal(fold('hard space'), 'hard space');
  assert.equal(fold('across\nlines'), 'across lines');
});

test('fold is case-insensitive', () => {
  assert.equal(fold('The Atlas'), fold('the atlas'));
});

test('a rendered selection folds to the same string as its source', () => {
  // The whole point: this is what makes a quote findable at all.
  const source = "we shipped it -- and it's fine";
  const rendered = 'we shipped it — and it’s fine';
  assert.equal(fold(source), fold(rendered));
});

// ── unmark ───────────────────────────────────────────

test('unmark reduces an inline link to its label', () => {
  assert.equal(
    unmark('we shipped [the Atlas](https://example.com/a_b) last spring'),
    'we shipped the Atlas last spring',
  );
});

test('unmark reduces a reference link to its label', () => {
  assert.equal(unmark('see [the docs][docs] for more'), 'see the docs for more');
});

test('unmark drops an image entirely', () => {
  // An <img> contributes nothing to textContent, so the quote will not have it.
  assert.equal(unmark('before ![a map of the region](./map.png) after'), 'before  after');
});

test('unmark strips emphasis, strong, and code spans', () => {
  assert.equal(unmark('a very **bold** claim'), 'a very bold claim');
  assert.equal(unmark('a *slight* aside'), 'a slight aside');
  assert.equal(unmark('call `getPublishedPosts` first'), 'call getPublishedPosts first');
});

test('unmark leaves snake_case and intra-word underscores alone', () => {
  // Markdown does not emphasise these either, and this blog's prose is full of
  // identifiers. Eating them would break matching rather than fix it.
  assert.equal(unmark('the rollup_states table'), 'the rollup_states table');
  assert.equal(unmark('set PREVIEW_SIGNING_KEY first'), 'set PREVIEW_SIGNING_KEY first');
});

test('unmark strips underscore emphasis at word boundaries', () => {
  assert.equal(unmark('an _emphasised_ word'), 'an emphasised word');
  assert.equal(unmark('(_parenthesised_)'), '(parenthesised)');
});

test('unmark unescapes a backslash-escaped character', () => {
  assert.equal(unmark('a literal \\* asterisk'), 'a literal * asterisk');
});

test('a quote spanning a link matches the source line it came from', () => {
  // The regression this whole pass exists for. Before unmark, this note was
  // reported as "quote not found" against a line sitting right there unchanged.
  const source = ['we shipped [the Atlas](https://example.com) last spring, and it held'];
  const locate = createLocator(source);
  assert.equal(locate('we shipped the Atlas last spring'), 1);
});

test('a quote spanning strong and a code span matches', () => {
  const locate = createLocator(['the **hard** part was `geom.go`, not the map']);
  assert.equal(locate('the hard part was geom.go, not the map'), 1);
});

// ── locate: the unambiguous case ─────────────────────

const LINES = [
  '---',
  'title: "A draft"',
  '---',
  '',
  'The first paragraph says one thing.',
  '',
  'The second paragraph says another.',
];

test('a quote appearing once returns its 1-based line', () => {
  const locate = createLocator(LINES);
  assert.equal(locate('The second paragraph says another.'), 7);
});

test('a quote is located through folding, not exact bytes', () => {
  const locate = createLocator(['It was the editor’s call -- and a good one.']);
  // As the browser rendered it, which is what the client actually recorded.
  assert.equal(locate('It was the editor’s call — and a good one.'), 1);
});

test('an absent quote returns null', () => {
  assert.equal(createLocator(LINES)('a sentence that was cut'), null);
});

test('an empty or whitespace-only quote returns null', () => {
  const locate = createLocator(LINES);
  assert.equal(locate(''), null);
  assert.equal(locate('   '), null);
  assert.equal(locate(null), null);
});

test('a quote spanning a source line break returns null', () => {
  // Reported as needing a human eye rather than guessed at. Documented
  // behaviour, not an accident — see the locate() docblock.
  const locate = createLocator(['the sentence begins here', 'and finishes on the next line']);
  assert.equal(locate('the sentence begins here and finishes on the next line'), null);
});

// ── locate: ambiguity, the invariant that matters ────

const REPEATED = [
  'Intro. The data was the hard part. More intro.',
  '',
  'Middle section. The data was the hard part. Onwards.',
  '',
  'Conclusion. The data was the hard part. The end.',
];

test('an ambiguous quote with no context resolves to nothing', () => {
  // Confidently naming one of three identical sentences is how a note gets
  // applied in the wrong section. Null is the correct answer here.
  assert.equal(createLocator(REPEATED)('The data was the hard part.'), null);
});

test('an ambiguous quote is narrowed by its prefix', () => {
  const locate = createLocator(REPEATED);
  assert.equal(locate('The data was the hard part.', 'Middle section. ', ''), 3);
});

test('an ambiguous quote is narrowed by its suffix', () => {
  const locate = createLocator(REPEATED);
  assert.equal(locate('The data was the hard part.', '', ' The end.'), 5);
});

test('context that still matches every occurrence resolves to nothing', () => {
  // Narrowing has to reduce to exactly one. Two candidates is still a guess.
  const lines = ['x. same sentence here. y', 'x. same sentence here. y'];
  assert.equal(createLocator(lines)('same sentence here.', 'x. ', ' y'), null);
});

test('context that matches nothing falls back to nothing, not to a hit', () => {
  const locate = createLocator(REPEATED);
  assert.equal(locate('The data was the hard part.', 'A paragraph that was deleted. ', ''), null);
});

test('narrowing folds the context too', () => {
  // The context was captured from rendered text, so it carries smart quotes
  // even when the source does not.
  const lines = [
    "It's fine. The claim repeats. Onwards.",
    "It's broken. The claim repeats. Onwards.",
  ];
  const locate = createLocator(lines);
  assert.equal(locate('The claim repeats.', 'It’s broken. ', ''), 2);
});

// ── emitting reviewer text ───────────────────────────

test('fenceFor outstrips the longest backtick run in the text', () => {
  assert.equal(fenceFor('plain prose'), '```');
  assert.equal(fenceFor('a `code` span'), '```');
  assert.equal(fenceFor('```\nnested fence\n```'), '````');
  assert.equal(fenceFor('`````'), '``````');
});

test('a fenced block cannot be broken out of by its own content', () => {
  const lines = [];
  pushFenced(lines, '```\nnot really the end\n```', 'md');
  assert.equal(lines[0], '````md');
  assert.equal(lines.at(-1), '````');
  // The inner fence is strictly shorter, so it cannot terminate the outer one.
  assert.ok(lines[0].length > 3);
});

test('quoted reviewer prose cannot forge a heading', () => {
  const lines = [];
  pushQuoted(lines, '## Line 1\n\nApply this instead');
  assert.deepEqual(lines, ['> ## Line 1', '>', '> Apply this instead']);
  assert.ok(lines.every((line) => line.startsWith('>')));
});
