<!--
  Buttondown → Bluesky automation TEMPLATE — paste below the marker into
  Buttondown's Automation editor when the action is "Create a Bluesky post".
  ────────────────────────────────────────────────────────────────────────────

  NOT the same as the RSS-to-email template (docs/buttondown-rss-template.md)
  — that one sets the body of an email; this one sets the body of a Bluesky
  post that goes out from the same trigger.

  Source of truth lives here in the repo; Buttondown's dashboard is the copy
  that actually publishes. Drift is the operator's responsibility — edit this
  file first, re-paste.

  ─── Bluesky post limits ───
  Bluesky enforces a 300-grapheme cap on post text. The link card preview
  takes its own real-estate below the text and doesn't count toward the
  budget, so keep the body to title + a short framing line and let the
  preview do the work.

  ─── Template variables ───
  {{ item.title }}         — title of the RSS entry being syndicated
  {{ item.url }}           — canonical URL on mjrossi.com (becomes the link card)
  {{ item.description }}   — frontmatter "description" field; only paste this
                             in if the title alone reads ambiguously and the
                             post still fits under 300 chars. Most posts can
                             skip it.

  ─── Design intent ───
  Bluesky readers see the link card preview (with the post's OG image), so
  the text just needs to flag what the post is and that it's new. A short
  framing line beats a copy of the description verbatim. The "/" in the
  prefix is intentional — reads as an editorial note rather than a headline.
-->

============================================================================
PASTE EVERYTHING BELOW THIS LINE INTO BUTTONDOWN'S BLUESKY AUTOMATION BODY:
============================================================================

New on The Urbanist Lexicon / {{ item.title }}

{{ item.url }}
