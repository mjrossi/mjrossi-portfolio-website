/// <reference path="../.astro/types.d.ts" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

interface Env {
  ASSETS: Fetcher;
  BUTTONDOWN_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
}

declare namespace App {
  interface Locals extends Runtime {}
}

interface ImportMetaEnv {
  readonly PUBLIC_TURNSTILE_SITE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
