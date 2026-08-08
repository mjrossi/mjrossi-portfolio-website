// The galley: inline editorial review on scheduled posts. See CLAUDE.md.
//
// Loads ONLY when the page was opened with a signed preview link that names a
// reviewer, which means only on responses middleware has already forced to
// `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`. It is
// therefore structurally incapable of appearing on a publicly cacheable page —
// a tighter carve-out than the newsletter form, which ships on every /blog hit.
//
// Served as a static asset (not bundled) for the same reasons as
// newsletter.js: it loads as an external module under `script-src 'self'`, and
// what we write is what gets served.
//
// NOTE ON DOM CONSTRUCTION: the CSP sets `require-trusted-types-for 'script'`,
// so assigning innerHTML throws. Everything here is createElement +
// textContent. That is also what makes reviewer-supplied note text safe to
// display without escaping it by hand.

(() => {
  const body = document.querySelector('.post-body');
  const mount = document.getElementById('galley');
  if (!body || !mount) return;

  const slug = mount.dataset.slug;
  const reviewer = mount.dataset.reviewer;
  // The revision of the .mdx this page was rendered from. Echoed when saving so
  // the endpoint can refuse a note written against a page that has since moved,
  // and compared against the server's current revision on every read so the
  // client knows when its own anchors have gone stale wholesale. See
  // src/lib/post-source.ts.
  const pageRevision = mount.dataset.revision;
  // Read from the URL rather than a data attribute: the token is already in
  // the address bar, and copying it into the DOM would only widen where it
  // can leak from (an extension reading attributes, a screenshot of devtools).
  const token = new URLSearchParams(location.search).get('preview');
  if (!slug || !token) return;

  const CONTEXT = 32;
  const api = `/api/galley?preview=${encodeURIComponent(token)}`;

  let notes = [];
  let closedNotes = [];
  // Set when the server's revision no longer matches the page in front of the
  // reviewer. Every anchor on screen is then suspect, not just the ones the
  // server flagged — see renderNotes.
  let pageStale = false;

  // ── element helpers ────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ── selection → anchor ─────────────────────────────

  // Turns the current selection into the three things a note records: the MDX
  // line range of the block it started in, the exact quoted text, and a little
  // context either side. See src/lib/remark-source-anchors.js for why all
  // three are needed rather than just the line range.
  function resolveSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return null;

    let quote = sel.toString().replace(/\s+/g, ' ').trim();
    if (!quote) return null;

    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const block = node?.closest?.('[data-src]');
    // Diagrams and <Figure> carry no anchor — mdxJsxFlowElement has no
    // hProperties channel — so a selection inside one resolves to nothing and
    // the button simply doesn't appear.
    if (!block || !body.contains(block)) return null;

    // Context is taken from the rendered text, which has collapsed whitespace.
    // The pull script normalises the .mdx the same way before searching, so a
    // quote spanning a source line break still matches.
    const blockText = block.textContent.replace(/\s+/g, ' ').trim();

    // Where the selection STARTED, not where its text first happens to appear.
    // Measured by collapsing everything in the block up to the selection start
    // the same way blockText was collapsed, so the two indices agree.
    //
    // `indexOf` alone would capture the context around the FIRST occurrence: an
    // editor selecting the second of two identical sentences in a block would
    // get prefix/suffix describing the first, and the pull script would then
    // "disambiguate" the note onto the wrong passage. That is precisely the
    // mis-anchoring prefix/suffix exist to prevent, so it must not be
    // reintroduced here.
    function offsetOfSelectionStart() {
      const head = document.createRange();
      head.setStart(block, 0);
      try {
        head.setEnd(range.startContainer, range.startOffset);
      } catch {
        // startContainer outside the block (a selection anchored above it).
        return -1;
      }
      return head.toString().replace(/\s+/g, ' ').replace(/^ /, '').length;
    }

    // Verified against the quote rather than trusted: whitespace collapsing at
    // the boundary can shift the offset by one, and a nested element's text may
    // not appear verbatim. `indexOf` remains the fallback — it is right in
    // every case except the repeated-text one measured above.
    let at = offsetOfSelectionStart();
    if (blockText.slice(at, at + quote.length) !== quote) at = blockText.indexOf(quote);

    // A selection dragged across a block boundary yields text that appears in
    // no single block, so the quote would be unfindable and the context empty —
    // and the note would still save, looking correct to the editor and landing
    // in the review file as permanently unlocatable. Clamp to the part inside
    // the block the selection STARTED in, which is the block the anchor names.
    if (at === -1) {
      const clamped = range.cloneRange();
      clamped.setEnd(block, block.childNodes.length);
      const inBlock = clamped.toString().replace(/\s+/g, ' ').trim();
      if (inBlock) {
        quote = inBlock;
        // Clamping moved the END of the selection, never its start, so the
        // measured offset still holds — same preference and same fallback.
        at = offsetOfSelectionStart();
        if (blockText.slice(at, at + quote.length) !== quote) at = blockText.indexOf(quote);
      }
    }
    // Still not found (a selection starting inside a nested element whose text
    // does not appear verbatim in the block). Better no button than a note that
    // can never be pointed at a passage.
    if (at === -1) return null;

    const prefix = blockText.slice(Math.max(0, at - CONTEXT), at);
    const suffix = blockText.slice(at + quote.length, at + quote.length + CONTEXT);

    return { src: block.dataset.src, quote, prefix, suffix, rect: range.getBoundingClientRect() };
  }

  // ── chrome ─────────────────────────────────────────

  const bar = el('div', 'galley-bar');
  const barLabel = el('span', 'galley-bar-label');
  barLabel.append(el('strong', null, 'Galley'), el('span', 'galley-sep', ' · '), document.createTextNode(`reviewing as ${reviewer}`));
  const barCount = el('button', 'galley-bar-toggle');
  barCount.type = 'button';
  barCount.setAttribute('aria-expanded', 'false');
  // Shown when the draft has been revised under this page. Deliberately in the
  // bar rather than the panel: it is the one thing a reviewer needs to see
  // without opening anything, because every marker on the page is wrong until
  // they reload.
  const barStale = el('span', 'galley-bar-stale', 'Draft revised — reload to review the current version');
  barStale.hidden = true;
  bar.append(barLabel, barStale, barCount);

  const panel = el('aside', 'galley-panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Editorial notes');
  const panelList = el('ol', 'galley-list');
  const panelEmpty = el('p', 'galley-empty', 'No notes yet. Select any passage to leave one.');

  // Notes from rounds the author has closed. Kept visible, collapsed, because a
  // second reviewer needs to see that a point was already raised — and whether it
  // was acted on or declined — rather than re-filing it. A real <details> so the
  // disclosure works without any of our own state.
  const addressed = el('details', 'galley-addressed');
  addressed.hidden = true;
  const addressedSummary = el('summary', 'galley-addressed-summary');
  const addressedList = el('ol', 'galley-list galley-list-addressed');
  addressed.append(addressedSummary, addressedList);

  panel.append(el('h2', 'galley-panel-title', 'Notes'), panelEmpty, panelList, addressed);

  const addBtn = el('button', 'galley-add', 'Add note');
  addBtn.type = 'button';
  addBtn.hidden = true;

  const composer = el('form', 'galley-composer');
  composer.hidden = true;
  const composerQuote = el('blockquote', 'galley-composer-quote');
  const composerInput = el('textarea', 'galley-composer-input');
  composerInput.rows = 4;
  composerInput.placeholder = 'What should change here?';
  composerInput.setAttribute('aria-label', 'Your note');
  // Optional replacement text. Filling this in makes the note a `suggestion`
  // rather than a `comment` — the second kind the schema, the validator and the
  // pull script have always handled, and which nothing could previously create.
  // An editor proposing better wording has often said everything they mean by
  // writing it, so the prose above stays optional once this is filled.
  const composerReplaceLabel = el('p', 'galley-composer-sublabel', 'Suggested replacement (optional)');
  const composerReplace = el('textarea', 'galley-composer-input');
  composerReplace.rows = 3;
  composerReplace.placeholder = 'Rewrite the passage as you would have it read.';
  composerReplace.setAttribute('aria-label', 'Suggested replacement');
  const composerMsg = el('p', 'galley-composer-msg');
  const composerSubmit = el('button', 'galley-composer-submit', 'Leave note');
  composerSubmit.type = 'submit';
  const composerCancel = el('button', 'galley-composer-cancel', 'Cancel');
  composerCancel.type = 'button';
  const composerActions = el('div', 'galley-composer-actions');
  composerActions.append(composerCancel, composerSubmit);
  composer.append(composerQuote, composerInput, composerReplaceLabel, composerReplace, composerActions, composerMsg);

  mount.append(bar, panel, addBtn, composer);

  // ── rendering ──────────────────────────────────────

  function renderCount() {
    const open = notes.length === 1 ? '1 note' : `${notes.length} notes`;
    barCount.textContent = closedNotes.length > 0 ? `${open} · ${closedNotes.length} addressed` : open;
  }

  /**
   * One note in the panel.
   *
   * `stale` notes get no line number. The stored `src_start` is an absolute line
   * in a revision this page is not showing, so printing it would name a line the
   * reviewer can go and look at and find something else entirely.
   */
  function renderNote(note, { closed = false } = {}) {
    const item = el('li', closed ? 'galley-note galley-note-closed' : 'galley-note');
    const meta = el('p', 'galley-note-meta');
    meta.append(el('span', 'galley-note-reviewer', note.reviewer));
    if (note.src_start && !note.stale && !closed) {
      meta.append(el('span', 'galley-sep', ' · '), el('span', 'galley-note-line', `line ${note.src_start}`));
    } else if (note.src_start && note.stale) {
      // `note.stale`, not `closed`, decides this. A closed note is usually also
      // stale — the revision that answered it is the one that changed the file —
      // but not always: closing a round the author declined leaves notes written
      // against the current source. Badging those "earlier revision" states
      // something false about a file nobody has touched. They simply get no line
      // number, which is the same treatment and claims nothing.
      meta.append(
        el('span', 'galley-sep', ' · '),
        el('span', 'galley-note-stale', 'earlier revision'),
      );
    }
    item.append(meta);
    if (note.quote) item.append(el('blockquote', 'galley-note-quote', note.quote));
    if (note.body) item.append(el('p', 'galley-note-body', note.body));
    // Without this a suggestion — a note whose whole content is its
    // replacement text and whose prose is optional — rendered as an empty
    // list item, since only `body` was ever displayed.
    if (note.suggestion) {
      item.append(el('p', 'galley-note-sublabel', 'Suggested replacement'));
      item.append(el('pre', 'galley-note-suggestion', note.suggestion));
    }
    return item;
  }

  function renderNotes() {
    panelList.replaceChildren();
    panelEmpty.hidden = notes.length > 0;
    for (const note of notes) panelList.append(renderNote(note));

    addressedList.replaceChildren();
    addressed.hidden = closedNotes.length === 0;
    addressedSummary.textContent = `Addressed (${closedNotes.length})`;
    for (const note of closedNotes) addressedList.append(renderNote(note, { closed: true }));

    barStale.hidden = !pageStale;
    renderCount();
    markAnchors();
  }

  // Give every block that carries a note a marker, so an editor can see at a
  // glance which passages have already been discussed and doesn't re-file
  // feedback a colleague has left. This is the whole reason notes are shared.
  //
  // A MARKER IS ONLY EVER PLACED FOR A NOTE WRITTEN AGAINST THIS EXACT REVISION.
  // The lookup below is a literal `[data-src="42-47"]` match, with no fallback to
  // the quote — so once the source has changed, those line numbers either match
  // nothing or, worse, match whichever block has since moved into that range.
  // The second case is the one that matters: it badges a paragraph with a note
  // about prose it never contained, and nothing on screen says so. Skipping
  // stale notes gives up a highlight; keeping them gives a wrong one.
  //
  // Two independent gates, because they fail at different granularities:
  //   pageStale   — the server has a newer revision than this document, so EVERY
  //                 anchor here is suspect, including notes the server considers
  //                 current (they were written against the source we don't have).
  //   note.stale  — this page is current, but that note predates it.
  // Closed notes are never passed here at all: they belong to a finished round
  // and describe a revision this page is not showing.
  function markAnchors() {
    for (const marked of body.querySelectorAll('.galley-marked')) {
      marked.classList.remove('galley-marked');
      marked.removeAttribute('data-galley-count');
    }
    if (pageStale) return;
    const counts = new Map();
    for (const note of notes) {
      if (!note.src_start || note.stale) continue;
      const key = `${note.src_start}-${note.src_end}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [src, count] of counts) {
      // Nested blocks can carry the SAME range — a list item whose only child
      // paragraph spans the same lines — and querySelector returns the outer
      // one, which highlights the whole list item instead of the sentence.
      // Take the innermost match: the one containing no further match. That is
      // also what resolveSelection anchored to, since closest() walks up from
      // the selection and stops at the nearest ancestor.
      const candidates = [...body.querySelectorAll(`[data-src="${src}"]`)];
      const block =
        candidates.find((node) => !node.querySelector(`[data-src="${src}"]`)) ?? candidates[0];
      if (!block) continue;
      block.classList.add('galley-marked');
      block.dataset.galleyCount = String(count);
    }
  }

  // ── interaction ────────────────────────────────────

  let pending = null;

  function hideAdd() {
    addBtn.hidden = true;
  }

  function closeComposer() {
    composer.hidden = true;
    composerInput.value = '';
    composerReplace.value = '';
    composerMsg.textContent = '';
    composerMsg.classList.remove('is-error');
    pending = null;
  }

  document.addEventListener('selectionchange', () => {
    if (!composer.hidden) return;
    const found = resolveSelection();
    if (!found) {
      hideAdd();
      return;
    }
    pending = found;
    addBtn.hidden = false;
    // Position above the selection, clamped into the viewport so a selection
    // at the very top of the page doesn't put the button off-screen.
    const top = found.rect.top + window.scrollY - 44;
    addBtn.style.top = `${Math.max(window.scrollY + 8, top)}px`;
    addBtn.style.left = `${Math.max(8, found.rect.left + window.scrollX)}px`;
  });

  // Keep the button from destroying the selection it acts on.
  //
  // mousedown on a button collapses the document selection, which queues a
  // selectionchange whose handler resolves to nothing and calls hideAdd(). That
  // task runs before mouseup at any human click speed, so the button is
  // display:none by the time the click would land, the event is dispatched on
  // the ancestor instead, and the listener below never fires: the editor selects
  // a passage, sees the button, clicks it, and nothing happens. Suppressing the
  // default mousedown action preserves the selection and the button both.
  //
  // This is the standard toolbar idiom for exactly this reason, and it is
  // harmless where a UA would have kept the selection anyway.
  addBtn.addEventListener('mousedown', (event) => event.preventDefault());

  addBtn.addEventListener('click', () => {
    if (!pending) return;
    hideAdd();
    composerQuote.textContent = pending.quote;
    composer.hidden = false;
    composerInput.focus();
  });

  composerCancel.addEventListener('click', closeComposer);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !composer.hidden) closeComposer();
  });

  barCount.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    barCount.setAttribute('aria-expanded', String(!panel.hidden));
  });

  composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = composerInput.value.trim();
    const replacement = composerReplace.value.trim();
    if (!text && !replacement) {
      composerMsg.textContent = 'Write something first.';
      composerMsg.classList.add('is-error');
      return;
    }
    if (!pending) return;

    composerSubmit.disabled = true;
    composerMsg.classList.remove('is-error');
    composerMsg.textContent = 'Saving…';

    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          // A replacement makes it a suggestion; prose alone is a comment.
          // src/lib/galley.js requires `body` for a comment and `suggestion`
          // for a suggestion, which is exactly the pair the guard above allows.
          kind: replacement ? 'suggestion' : 'comment',
          // The revision `src` was read from. The endpoint refuses the note if
          // this is not the source it currently holds, because the line range
          // above would then point into a file nobody is looking at.
          revision: pageRevision,
          src: pending.src,
          quote: pending.quote,
          prefix: pending.prefix,
          suffix: pending.suffix,
          body: text,
          suggestion: replacement,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // The link is the credential, so the two failures worth naming
        // separately are both about the link itself — an editor who has had a
        // token expire needs to know to ask for a new one, not to retry.
        const messages = {
          not_authorised: 'This link can no longer leave notes. Ask for a fresh one.',
          slug_mismatch: 'This link belongs to a different draft.',
          // The draft moved while this page was open, so the passage this note
          // is anchored to may no longer be there. Says "copy" because the text
          // survives in the composer only until the reload, and there is no way
          // to restore the selection afterwards.
          stale_page:
            'This draft was revised while you were reading. Copy your note, reload, and re-select the passage.',
          too_many_notes: "That's a lot of notes in one go — take a short break and continue.",
          body_too_long: 'That note is too long. Try splitting it in two.',
          suggestion_too_long: 'That replacement is too long. Try splitting it in two.',
          // Refused by the transport cap before the field checks ran, so
          // neither *_too_long message applies. Says the same thing they do,
          // because from the editor's side it is the same problem.
          payload_too_large: 'That note is too long. Try splitting it in two.',
          // The draft is fine; the database behind the galley is not. Tells the
          // editor not to retype the note, which is what "Try again" invites.
          galley_db_error: 'The galley is having trouble saving. Let the author know.',
        };
        // hasOwn, not a bare lookup: `data.error` reaches this from a response
        // body, and an object literal inherits Object.prototype — so an error
        // named "constructor" or "toString" would resolve to a function and get
        // stringified into the panel.
        composerMsg.textContent = Object.hasOwn(messages, data.error)
          ? messages[data.error]
          : 'Could not save that note. Try again.';
        composerMsg.classList.add('is-error');
        composerSubmit.disabled = false;
        return;
      }
      closeComposer();
      await load();
    } catch {
      composerMsg.textContent = 'Network error. Your note was not saved.';
      composerMsg.classList.add('is-error');
    } finally {
      composerSubmit.disabled = false;
    }
  });

  // ── load ───────────────────────────────────────────

  // Declared above load() because load() records against it. See refresh().
  const REFRESH_THROTTLE_MS = 5000;
  let lastLoad = 0;

  async function load() {
    // EVERY load counts against the throttle, including the one after a save and
    // the one at startup. Booking it in refresh() alone meant saving a note and
    // alt-tabbing straight back fired a second GET inside the window the
    // throttle exists to bound.
    lastLoad = Date.now();
    try {
      const res = await fetch(api, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      notes = Array.isArray(data.notes) ? data.notes : [];
      closedNotes = Array.isArray(data.closed) ? data.closed : [];
      // The server is serving a revision this page was not rendered from, so the
      // document on screen is behind the one every note is being measured
      // against. Withholds all markers (see markAnchors) and raises the reload
      // prompt — without which the first the reviewer would hear of it is a
      // refused save after typing a note.
      //
      // Compared only when both sides are known: a page with no data-revision
      // cannot write anyway, and guessing "stale" there would show a reload
      // prompt that reloading does not clear.
      pageStale = Boolean(pageRevision && data.revision && data.revision !== pageRevision);
      renderNotes();
    } catch {
      // A failed read leaves the bar showing the last known count. The editor
      // can still write; losing the list is not worth an error banner.
    }
  }

  // Reviewers work concurrently, and `load()` otherwise runs exactly twice — at
  // startup and after this reviewer saves something — so a colleague's note
  // filed in the meantime never appears. Refreshing when the tab comes back
  // covers the way the page is actually used (read here, write elsewhere,
  // return) without polling: an idle tab costs nothing, and the endpoint's
  // traffic stays proportional to activity rather than to session length.
  //
  // Throttled because `visibilitychange` and `focus` both fire on a single
  // alt-tab back, and the two would otherwise be two requests every time.
  function refresh() {
    if (document.hidden) return;
    if (Date.now() - lastLoad < REFRESH_THROTTLE_MS) return;
    load();
  }
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);

  renderCount();
  load();
})();
