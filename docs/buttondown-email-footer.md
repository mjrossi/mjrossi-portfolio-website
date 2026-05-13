<!--
  Buttondown email FOOTER — paste below the marker into
  Buttondown → Settings → Email design → Footer.
  ──────────────────────────────────────────────────────────────────────────

  Markdown with inline <small>/<span> hooks for the colophon's quieter
  visual treatment. Same source-of-truth model as the header file:
  edit here, re-paste the affected slot.

  Pairs with:
    docs/buttondown-email-header.md
    docs/buttondown-email-custom.css

  ─── Template variables ───
  {{ rss_entry.link }}     — canonical URL of the post being mailed
                              (only defined for RSS-to-email broadcasts; the
                              {% if rss_entry %} guard handles manual sends)
  {{ unsubscribe_url }}    — Buttondown's one-click unsubscribe link

  ─── Iteration loop ───
  Same as the header file. Inspect the rendered email source after a test
  send to confirm the CSS in docs/buttondown-email-custom.css targets the
  correct wrapper classes.
-->

============================================================================
PASTE EVERYTHING BELOW THIS LINE INTO BUTTONDOWN'S FOOTER FIELD:
============================================================================

{% if rss_entry %}[Read this on mjrossi.com]({{ rss_entry.link }}) · {% endif %}[Browse the blog](https://mjrossi.com/blog)

---

<small class="footer-colophon">*Set in Fraunces &amp; Source Serif · Built in Astro, served from the edge.*</small>

<small class="footer-meta">You're receiving this because you subscribed at [mjrossi.com/blog](https://mjrossi.com/blog). [Unsubscribe]({{ unsubscribe_url }}).</small>
