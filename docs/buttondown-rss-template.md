<!--
  Buttondown RSS-to-email TEMPLATE — paste below the marker into
  Buttondown's RSS-to-email automation → Template field.
  ────────────────────────────────────────────────────────────────────────────

  NOTE: This is NOT the same as the regular "Email design" Header/Footer slots.
  Buttondown's RSS-to-email automation has its own dedicated template setting,
  with different available variables ({{ item.title }} and {{ item.url }} for
  each entry pulled from the feed). Pasting this into the regular Email design
  slots won't produce the right output.

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
  {{ item.title }}        — title of an RSS entry being mailed
  {{ item.url }}          — canonical URL of the entry
  {{ unsubscribe_url }}   — Buttondown's one-click unsubscribe link

  ─── Design intent ───
  The blog is a periodical within the site. Site identity is "Matthew Rossi"
  (the author, masthead of every page); blog identity is "The Urbanist
  Lexicon" (the periodical). Emails lead with the periodical — h1 is the
  publication name, h2 is the periodical tagline — and the author drops to
  a byline below the post link. Body is a simple linked title; visitors
  click through to read on the site, where full broadsheet typography lives.
  Email is the push notification, not the reading surface.
-->

============================================================================
PASTE EVERYTHING BELOW THIS LINE INTO BUTTONDOWN'S RSS-TO-EMAIL TEMPLATE:
============================================================================

# <span class="masthead-publication">THE URBANIST <span class="masthead-publication-accent">LEXICON</span></span>

## <span class="masthead-tagline">A record of systems, movement, and the transition from bits to bricks.</span>

---

[{{ item.title }}]({{ item.url }})

---

<small class="masthead-byline">By <a href="https://mjrossi.com">Matthew Rossi</a> · <a href="https://mjrossi.com/blog">mjrossi.com/blog</a></small>

<small class="footer-colophon">*Set in Fraunces &amp; Source Serif · Built in Astro, served from the edge.*</small>

<small class="footer-meta">You're receiving this because you subscribed at [mjrossi.com/blog](https://mjrossi.com/blog) · [Unsubscribe]({{ unsubscribe_url }}).</small>
