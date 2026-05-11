/// <reference path="../.astro/types.d.ts" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

interface Env {
  ASSETS: Fetcher;
}

declare namespace App {
  interface Locals extends Runtime {}
}
