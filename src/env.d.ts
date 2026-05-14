/// <reference path="../.astro/types.d.ts" />

// `Env` is the runtime binding shape for the Cloudflare Worker. It's read
// via `import { env } from 'cloudflare:workers'` inside src/lib/server.ts;
// the adapter no longer puts env on `Astro.locals.runtime.env` (removed in
// Astro v6 / @astrojs/cloudflare 13 — accessing the old path now throws).
//
// The slim `App.Locals` shape comes from @astrojs/cloudflare's own
// types.d.ts, referenced via .astro/types.d.ts above. We don't augment it
// here — only `cfContext: ExecutionContext` lives there now.
interface Env {
  ASSETS: Fetcher;
  BUTTONDOWN_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
}

interface ImportMetaEnv {
  readonly PUBLIC_TURNSTILE_SITE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
