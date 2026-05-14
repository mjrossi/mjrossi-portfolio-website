<!--
  Buttondown → LinkedIn automation TEMPLATE — paste below the marker into
  Buttondown's Automation editor when the action is "Create a LinkedIn post".
  ────────────────────────────────────────────────────────────────────────────

  NOT the same as the RSS-to-email template (docs/buttondown-rss-template.md)
  — that one sets the body of an email; this one sets the body of a LinkedIn
  post that goes out from the same trigger.

  Source of truth lives here in the repo; Buttondown's dashboard is the copy
  that actually publishes. Drift is the operator's responsibility — edit this
  file first, re-paste.

  ─── LinkedIn post limits ───
  LinkedIn allows up to 3000 characters per post, but the algorithm truncates
  to ~200 chars in-feed with a "see more" expander — the first two lines do
  most of the work. Lead with the title and a one-line dek so the preview
  reads cleanly without expansion.

  Buttondown posts to your LinkedIn **profile** as a standard post.
  LinkedIn Newsletters (LinkedIn's own newsletter product) is NOT supported
  — LinkedIn doesn't expose an API for it. Standard profile post is the only
  surface available, which is fine: the canonical link does the job.

  ─── Template variables ───
  {{ item.title }}         — title of the RSS entry being syndicated
  {{ item.url }}           — canonical URL on mjrossi.com
  {{ item.description }}   — frontmatter "description" field (the one-line
                             summary required by src/content.config.ts)

  ─── Design intent ───
  Title on its own line. Description as the dek. Canonical link last so the
  unfurl preview attaches. No hashtag stuffing — the audience is professional
  contacts, not algorithmic discovery. The byline isn't repeated since the
  post comes from the personal profile already.
-->

============================================================================
PASTE EVERYTHING BELOW THIS LINE INTO BUTTONDOWN'S LINKEDIN AUTOMATION BODY:
============================================================================

New on The Urbanist Lexicon:

{{ item.title }}

{{ item.description }}

Read more: {{ item.url }}
