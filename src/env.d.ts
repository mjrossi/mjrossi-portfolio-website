/// <reference path="../.astro/types.d.ts" />

// `Env` is the worker's runtime bindings, read through `cloudflare:workers` in
// src/lib/server.ts. `App.Locals` extends @astrojs/cloudflare's own with the
// gates src/middleware.ts resolves per request.
interface Env {
  ASSETS: Fetcher;
  BUTTONDOWN_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  // Galley notes and preview links. Optional: without it the galley fails, not
  // the whole worker.
  DB?: D1Database;
  // Unset: every preview token is rejected.
  PREVIEW_SIGNING_KEY?: string;
  // The Access app guarding /admin, from `vars` in wrangler.jsonc: identifiers,
  // not secrets. Unset means the Desk is unreachable, not open.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Local dev and smoke only: a JWKS that replaces the fetch to Cloudflare.
  // THIS REPLACES THE TRUST ROOT. .dev.vars only; never `wrangler secret put`.
  ACCESS_JWKS_OVERRIDE?: string;
}

declare namespace App {
  // Optional on purpose: middleware doesn't run for prerendered routes or the
  // build, so a reader can see `undefined` — and `undefined` must always mean
  // denied. Never read these as `!== false` or `?? true`.
  interface Locals {
    /** True on *.workers.dev preview deploys — reveals every scheduled post. */
    showScheduled?: boolean;
    /**
     * Slug a valid signed link authorises, else null. Only
     * src/pages/blog/[...slug].astro reads it, so a link never reaches the
     * index, tag pages or RSS.
     */
    previewSlug?: string | null;
    /**
     * Reviewer label from a signed link, else null; non-null also authorises
     * galley notes. Same rule as previewSlug: never in blog.ts or the RSS route
     * (smoke greps for it).
     */
    previewReviewer?: string | null;
    /**
     * Who Access says is at the Desk, after access.js verified the JWT. For
     * display only: middleware has already 404ed anyone unauthorised.
     */
    admin?: { email: string | null; sub: string | null } | null;
  }
}

/**
 * Epoch ms the bundle was built, inlined by Vite's `define`. Only for "did the
 * build make an OG card for this post?" (BlogPost.astro). "Is it live?" wants
 * isPublished with the real clock.
 */
declare const __BUILD_TIME__: number;

interface ImportMetaEnv {
  readonly PUBLIC_TURNSTILE_SITE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
