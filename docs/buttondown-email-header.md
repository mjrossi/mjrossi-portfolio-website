<!--
  Buttondown email HEADER — paste below the marker into
  Buttondown → Settings → Email design → Header.
  ──────────────────────────────────────────────────────────────────────────

  Buttondown's header/footer fields accept Markdown, HTML, or plaintext
  (https://docs.buttondown.com/designing-your-email). The field is a plain
  text input, not a rich HTML editor — Markdown is the most readable choice
  in that UI, with sparse inline <span> hooks for the few styling beats
  that need class-based targeting (the surname accent, edition meta, the
  italic tagline).

  Pairs with:
    docs/buttondown-email-footer.md
    docs/buttondown-email-custom.css

  Source of truth lives here in the repo; Buttondown's dashboard is the
  copy that actually serves emails. Drift is the operator's responsibility
  — edit this file first, then re-paste the affected slot.

  ─── Template variables ───
  {{ email.publish_date }}  — send date (renders "May 2026" via date filter)

  ─── Iteration loop ───
  1. Edit this file.
  2. Paste the content below the marker into Buttondown's Header field.
  3. Send a test email to yourself.
  4. View the email's source (most clients: View → Source / Show original).
  5. If Buttondown's wrapper classes around the header differ from what
     the CSS file assumes, refine the CSS targets in
     docs/buttondown-email-custom.css.
-->

============================================================================
PASTE EVERYTHING BELOW THIS LINE INTO BUTTONDOWN'S HEADER FIELD:
============================================================================

# <span class="masthead-mj">MJ</span><span class="masthead-surname">ROSSI</span>

<span class="masthead-loc">Brooklyn → Lisbon</span> · <span class="masthead-edition">{{ email.publish_date | date: "%B %Y" }}</span>

*<span class="masthead-tagline">Notes from a career in transit</span>*

---
