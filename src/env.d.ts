/// <reference path="../.astro/types.d.ts" />

// `Env` is the runtime binding shape for the Cloudflare Worker. It's read
// via `import { env } from 'cloudflare:workers'` inside src/lib/server.ts;
// the adapter no longer puts env on `Astro.locals.runtime.env` (removed in
// Astro v6 / @astrojs/cloudflare 13 — accessing the old path now throws).
//
// The base `App.Locals` shape comes from @astrojs/cloudflare's own types.d.ts,
// referenced via .astro/types.d.ts above (it contributes `cfContext:
// ExecutionContext`). We augment it below with the scheduled-post preview
// signals that src/middleware.ts resolves per request.
interface Env {
  ASSETS: Fetcher;
  BUTTONDOWN_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  // Galley notes — editorial feedback on scheduled posts. Holds the
  // conversation ABOUT a post; the post itself stays in git as MDX. Optional
  // so that a deploy without the binding degrades to "the galley 500s" rather
  // than taking the whole worker down. See src/pages/api/galley.ts.
  DB?: D1Database;
  // Signs and verifies scheduled-post preview links. Optional: when unset,
  // verifyPreviewToken() rejects every token and only the *.workers.dev host
  // unlock remains. See src/lib/preview.js.
  PREVIEW_SIGNING_KEY?: string;
}

declare namespace App {
  // Both signals are OPTIONAL on purpose. src/middleware.ts is their only
  // writer, and middleware does not run for prerendered routes (/404) or
  // during build-time rendering — so a reader can legitimately see
  // `undefined`. Typing them as required would assert a guarantee the system
  // doesn't make, and would hide the fail-closed default behind a cast.
  //
  // `undefined` must always mean "hidden". That holds today: getPublishedPosts
  // tests `opts.showScheduled === true`, and [...slug].astro guards on
  // `previewSlug && previewSlug === slug`. Keep any new reader on that side of
  // the default — never `!== false` or `?? true`.
  interface Locals {
    /** True on *.workers.dev preview deploys — reveals every scheduled post. */
    showScheduled?: boolean;
    /**
     * Slug authorised by a valid signed preview link, else null. Scoped to a
     * single post: only src/pages/blog/[...slug].astro reads this, so a
     * preview link can never reach the blog index, tag pages, or RSS.
     */
    previewSlug?: string | null;
    /**
     * Reviewer label carried by a signed preview link, else null. Non-null
     * means the link additionally authorises leaving galley notes on
     * `previewSlug` — see CLAUDE.md, "The galley".
     *
     * Subject to the same scoping rule as previewSlug, and for the same
     * reason: this must never reach src/lib/blog.ts or the RSS route, because
     * RSS drives Buttondown's mailing. smoke.mjs greps for exactly that.
     */
    previewReviewer?: string | null;
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_TURNSTILE_SITE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
