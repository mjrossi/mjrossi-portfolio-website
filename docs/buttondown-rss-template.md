<!--
  Buttondown RSS-to-email TEMPLATE — paste below the marker into
  Buttondown's RSS-to-email automation → Template field.
  ────────────────────────────────────────────────────────────────────────────

  NOTE: This is NOT the same as the regular "Email design" Header/Footer slots.
  Buttondown's RSS-to-email automation has its own dedicated template setting,
  with different available variables ({{ item.title }}, {{ item.url }}, and
  {{ item.description }} for each entry pulled from the feed). Pasting this
  into the regular Email design slots won't produce the right output.

  Pairs with: docs/buttondown-email-custom.css (paste into Settings → Email
  design → Custom CSS — that slot's CSS does carry over and style this
  template's rendered output).

  Source of truth lives here in the repo; Buttondown's dashboard is the copy
  that actually serves emails. Drift is the operator's responsibility — edit
  this file first, re-paste.

  ─── Buttondown RSS-to-email Subject field ───
  Set the Subject template (separate field in the automation config — NOT
  here) to:

      The Urbanist Lexicon · {{ item.title }}

  Prefixing with the periodical name helps subscribers identify the email at
  a glance in a busy inbox; the post title alone is sometimes ambiguous.

  ─── Template variables ───
  {{ item.title }}         — title of an RSS entry being mailed
  {{ item.url }}           — canonical URL of the entry
  {{ item.description }}   — frontmatter "description" field (the one-line
                             summary required by src/content.config.ts; also
                             used on the blog list page and OG cards)
  {{ unsubscribe_url }}    — Buttondown's one-click unsubscribe link

  ─── Design intent ───
  Magazine layout. The article — post title + dek — gets the typographic
  lead inside the white card. The periodical name lives in a small-caps
  ribbon above it (kicker), parallel weight to Buttondown's auto-injected
  "THE URBANIST LEXICON · <DATE>" line just above the card, so the brand
  appears without dominating. Author drops to a small byline below the
  article. Email is the push notification + an inbox-readable dek — the
  full post lives on the site, where broadsheet typography belongs.
-->

============================================================================
PASTE EVERYTHING BELOW THIS LINE INTO BUTTONDOWN'S RSS-TO-EMAIL TEMPLATE:
============================================================================

<small class="masthead-ribbon">THE URBANIST <span class="masthead-publication-accent">LEXICON</span></small>

# [{{ item.title }}]({{ item.url }})

<p class="post-dek">{{ item.description }}</p>

---

<small class="masthead-byline">By <a href="https://mjrossi.com">Matthew Rossi</a> · <a href="https://mjrossi.com/blog">mjrossi.com/blog</a></small>

<small class="footer-colophon">*Set in Fraunces &amp; Source Serif · Built in Astro, served from the edge.*</small>

<small class="footer-meta">You're receiving this because you subscribed at [mjrossi.com/blog](https://mjrossi.com/blog) · [Unsubscribe]({{ unsubscribe_url }}).</small>
