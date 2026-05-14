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

  ─── Template variables ───
  {{ item.title }}        — title of an RSS entry being mailed
  {{ item.url }}          — canonical URL of the entry
  {{ unsubscribe_url }}   — Buttondown's one-click unsubscribe link

  ─── Design intent ───
  Mirror the site's masthead with the writer brand (MJROSSI) and the blog's
  periodical subtitle ("The Urbanist Lexicon" tagline). Body is a simple
  linked title — visitors click through to read the post on the site, where
  the full broadsheet typography lives. Email is the push notification, not
  the reading surface.
-->

============================================================================
PASTE EVERYTHING BELOW THIS LINE INTO BUTTONDOWN'S RSS-TO-EMAIL TEMPLATE:
============================================================================

# <span class="masthead-mj">MJ</span><span class="masthead-surname">ROSSI</span>

## <span class="masthead-tagline">A record of systems, movement, and the transition from bits to bricks.</span>

---

[{{ item.title }}]({{ item.url }})

---

<small class="footer-colophon">*Set in Fraunces &amp; Source Serif · Built in Astro, served from the edge.*</small>

<small class="footer-meta">You're receiving this because you subscribed at [mjrossi.com/blog](https://mjrossi.com/blog) · [Unsubscribe]({{ unsubscribe_url }}).</small>
