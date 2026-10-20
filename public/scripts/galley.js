// The galley: inline editorial review on scheduled posts. See docs/GALLEY.md.
//
// Loads only for a signed link that names a reviewer, so only on responses
// middleware has forced to no-store + noindex. Served unbundled under
// `script-src 'self'`.
//
// The CSP requires Trusted Types, so innerHTML throws: everything is
// createElement + textContent, which is also what makes reviewer text safe.

import { anchorSelection, findQuote } from './galley-quote.js';

(() => {
  const body = document.querySelector('.post-body');
  const mount = document.getElementById('galley');
  if (!body || !mount) return;

  const slug = mount.dataset.slug;
  const reviewer = mount.dataset.reviewer;
  // The revision this page was rendered from: echoed on save, compared on read.
  const pageRevision = mount.dataset.revision;
  // From the URL, not a data attribute: the DOM would only widen where it leaks.
  const token = new URLSearchParams(location.search).get('preview');
  if (!slug || !token) return;

  const CONTEXT = 32;
  const api = `/api/galley?preview=${encodeURIComponent(token)}`;

  let notes = [];
  let closedNotes = [];
  // The server has a newer revision than this page: every anchor is suspect.
  let pageStale = false;

  // ── element helpers ────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** The block's text nodes in order; joined, they are its textContent. */
  function textNodesIn(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
  }

  // ── selection → anchor ─────────────────────────────

  // The selection → line range, quote and context. What gets STORED is decided
  // by anchorSelection, which is pure and unit-tested; a wrong anchor lives in
  // D1 for good. Only the DOM measuring stays here.
  function resolveSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return null;

    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const block = node?.closest?.('[data-src]');
    // Diagrams and <Figure> carry no anchor, so no button appears.
    if (!block || !body.contains(block)) return null;

    // The start as an offset into the block's text (a Range's toString() is
    // the same concatenation as textNodesIn). -1 means unmeasurable, not zero.
    let rawStart = -1;
    const head = document.createRange();
    head.setStart(block, 0);
    try {
      head.setEnd(range.startContainer, range.startOffset);
      rawStart = head.toString().length;
    } catch {
      // startContainer outside the block (a selection anchored above it).
    }

    const anchor = anchorSelection(
      textNodesIn(block).map((textNode) => textNode.data),
      rawStart,
      sel.toString(),
      CONTEXT,
    );
    if (!anchor) return null;

    return {
      src: block.dataset.src,
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      rect: range.getBoundingClientRect(),
    };
  }

  // ── chrome ─────────────────────────────────────────

  const bar = el('div', 'galley-bar');
  const barLabel = el('span', 'galley-bar-label');
  barLabel.append(el('strong', null, 'Galley'), el('span', 'galley-sep', ' · '), document.createTextNode(`reviewing as ${reviewer}`));
  const barCount = el('button', 'galley-bar-toggle');
  barCount.type = 'button';
  barCount.setAttribute('aria-expanded', 'false');
  // In the bar, not the panel: every marker is wrong until they reload.
  const barStale = el('span', 'galley-bar-stale', 'Draft revised — reload to review the current version');
  barStale.hidden = true;
  bar.append(barLabel, barStale, barCount);

  const panel = el('aside', 'galley-panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Editorial notes');
  const panelList = el('ol', 'galley-list');
  const panelEmpty = el('p', 'galley-empty', 'No notes yet. Select any passage to leave one.');

  // Closed rounds, collapsed, so a point already raised isn't re-filed.
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
  // Filling this makes the note a `suggestion`; the prose is then optional.
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

  /** One note in the panel. A stale note's line number would name the wrong line, so it gets none. */
  function renderNote(note, { closed = false } = {}) {
    const item = el('li', closed ? 'galley-note galley-note-closed' : 'galley-note');
    const meta = el('p', 'galley-note-meta');
    meta.append(el('span', 'galley-note-reviewer', note.reviewer));
    if (note.src_start && !note.stale && !closed) {
      meta.append(el('span', 'galley-sep', ' · '), el('span', 'galley-note-line', `line ${note.src_start}`));
    } else if (note.src_start && note.stale) {
      // `stale`, not `closed`: a declined round's notes are closed but current.
      meta.append(
        el('span', 'galley-sep', ' · '),
        el('span', 'galley-note-stale', 'earlier revision'),
      );
    }
    item.append(meta);
    if (note.quote) item.append(el('blockquote', 'galley-note-quote', note.quote));
    if (note.body) item.append(el('p', 'galley-note-body', note.body));
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

  // Custom highlights paint a Range without touching the DOM. A <mark> would
  // mutate the tree resolveSelection measures, so a slip would corrupt an
  // anchor, not just a colour. Without the API (Firefox < 140) every note gets
  // the block marker.
  const HIGHLIGHT = 'galley-note';
  const highlights =
    typeof Highlight === 'function' && typeof CSS !== 'undefined' && CSS.highlights
      ? new Highlight()
      : null;
  if (highlights) CSS.highlights.set(HIGHLIGHT, highlights);

  // Mark every passage carrying a note, so colleagues don't re-file feedback.
  // Each current note gets ONE marker: its quoted words when findQuote places
  // them unambiguously, otherwise the whole block. `data-galley-count` counts
  // only the block-marked ones.
  //
  // MARKERS ONLY FOR NOTES ON THIS EXACT REVISION. The lookup is a literal
  // `[data-src]` match, so after an edit those lines may belong to a different
  // block — a confidently wrong marker. Two gates: `pageStale` (this whole page
  // is behind) and `note.stale` (that note predates it). Closed notes never get
  // markers. Never add a quote fallback here; see docs/GALLEY.md.
  function markAnchors() {
    for (const marked of body.querySelectorAll('.galley-marked')) {
      marked.classList.remove('galley-marked');
      marked.removeAttribute('data-galley-count');
    }
    // Before the gate, so a page that just went stale loses its highlights too.
    highlights?.clear();
    if (pageStale) return;

    const groups = new Map();
    for (const note of notes) {
      if (!note.src_start || note.stale) continue;
      const key = `${note.src_start}-${note.src_end}`;
      const group = groups.get(key);
      if (group) group.push(note);
      else groups.set(key, [note]);
    }

    for (const [src, group] of groups) {
      // Nested blocks can share a range (a list item and its one paragraph).
      // Take the innermost, which is what closest() anchored to.
      const candidates = [...body.querySelectorAll(`[data-src="${src}"]`)];
      const block =
        candidates.find((node) => !node.querySelector(`[data-src="${src}"]`)) ?? candidates[0];
      if (!block) continue;

      const nodes = highlights ? textNodesIn(block) : [];
      const texts = nodes.map((node) => node.data);
      let unplaced = 0;

      for (const note of group) {
        const hit = highlights && note.quote ? findQuote(texts, note.quote) : null;
        if (!hit) {
          unplaced += 1;
          continue;
        }
        try {
          const range = document.createRange();
          range.setStart(nodes[hit.startIndex], hit.startOffset);
          range.setEnd(nodes[hit.endIndex], hit.endOffset);
          highlights.add(range);
        } catch {
          // Shouldn't happen; the block marker is the right way to be wrong.
          unplaced += 1;
        }
      }

      if (unplaced === 0) continue;
      block.classList.add('galley-marked');
      block.dataset.galleyCount = String(unplaced);
    }
  }

  // ── the on-screen keyboard ─────────────────────────

  // How much of the layout viewport is off the bottom of the screen, published
  // as --galley-keyboard to lift the fixed composer (see GalleyMargin.astro).
  // Layout minus visual viewport; zero where the keyboard still resizes the
  // layout viewport, so no platform sniffing.
  //
  // The retractable toolbar is in this number too (clientHeight is the LARGE
  // viewport), so the composer slides slightly as it retracts. Intended, not a
  // bug. `offsetTop` is subtracted or a scrolled visual viewport counts twice.
  const viewport = window.visualViewport;

  // A pinch that settles back can report 1.0000001.
  const ZOOM_EPSILON = 1.01;

  let lift = 0;

  function trackKeyboard() {
    // HELD, not reset, while zoomed: the subtraction would measure the zoom,
    // and resetting to 0 would drop an open composer under the keyboard.
    if (!viewport || viewport.scale > ZOOM_EPSILON) return;

    const covered =
      document.documentElement.clientHeight - viewport.height - viewport.offsetTop;
    // `calc(4rem + NaNpx)` is dropped, and `bottom: auto` puts the composer at the TOP.
    const next = Number.isFinite(covered) ? Math.max(0, Math.round(covered)) : 0;
    // Skip no-op writes: `scroll` fires constantly and each write restyles the galley.
    if (next === lift) return;
    lift = next;
    mount.style.setProperty('--galley-keyboard', `${lift}px`);
  }

  // The keyboard opening is a resize; scrolling the field into view is a scroll.
  viewport?.addEventListener('resize', trackKeyboard);
  viewport?.addEventListener('scroll', trackKeyboard);
  trackKeyboard();

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
    // Above the selection, clamped on-screen.
    const top = found.rect.top + window.scrollY - 44;
    addBtn.style.top = `${Math.max(window.scrollY + 8, top)}px`;
    addBtn.style.left = `${Math.max(8, found.rect.left + window.scrollX)}px`;
  });

  // mousedown would collapse the selection, the selectionchange handler would
  // hide the button before mouseup, and the click would never land.
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
          kind: replacement ? 'suggestion' : 'comment',
          // Refused by the endpoint if the source has since moved.
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
        const messages = {
          not_authorised: 'This link can no longer leave notes. Ask for a fresh one.',
          slug_mismatch: 'This link belongs to a different draft.',
          // "Copy": the text survives only until the reload.
          stale_page:
            'This draft was revised while you were reading. Copy your note, reload, and re-select the passage.',
          too_many_notes: "That's a lot of notes in one go — take a short break and continue.",
          body_too_long: 'That note is too long. Try splitting it in two.',
          suggestion_too_long: 'That replacement is too long. Try splitting it in two.',
          // The transport cap; to the editor, the same problem.
          payload_too_large: 'That note is too long. Try splitting it in two.',
          galley_db_error: 'The galley is having trouble saving. Let the author know.',
        };
        // hasOwn: an error named "constructor" would find Object.prototype's.
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

  const REFRESH_THROTTLE_MS = 5000;
  let lastLoad = 0;

  async function load() {
    // Every load counts against the throttle, including after a save.
    lastLoad = Date.now();
    try {
      const res = await fetch(api, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      notes = Array.isArray(data.notes) ? data.notes : [];
      closedNotes = Array.isArray(data.closed) ? data.closed : [];
      // Raise the reload prompt now, not on a refused save. Only when both
      // sides are known, or the prompt would survive the reload.
      pageStale = Boolean(pageRevision && data.revision && data.revision !== pageRevision);
      renderNotes();
    } catch {
      // Keep the last known list; not worth an error banner.
    }
  }

  // Refetch when the tab comes back, so a colleague's notes appear without
  // polling. Throttled: one alt-tab fires both visibilitychange and focus.
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
