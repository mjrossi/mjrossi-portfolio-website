// Everything asserted about wrangler configuration: the worker-name pairing the
// preview-host unlock depends on, and the binding-drift check between the
// wrangler.jsonc in this repo and the config the build actually deploys.
//
// Self-contained — reads files, calls check(), touches nothing else in the run.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORKER_NAME } from '../../src/lib/preview.js';
import { check, stripComments } from './check.mjs';

const WRANGLER_CONFIG = resolve('wrangler.jsonc');

// Every binding the deployed Worker carries must be declared in wrangler.jsonc.
//
// The build does NOT deploy wrangler.jsonc — it deploys dist/server/wrangler.json,
// which @astrojs/cloudflare generates from it and is free to add to. It already
// does: when `config.session.driver` is unset the adapter injects a SESSION KV
// binding unconditionally, which is how a KV namespace came to exist in the
// account without this repo mentioning it. That is invisible locally — the
// binding only shows up in generated output and the Cloudflare dashboard — so
// without this check the next adapter release can quietly add another one and
// nothing fails until someone audits the account by hand.
//
// Compares binding NAMES only, and never values. `vars` is no longer empty —
// it carries the Cloudflare Access team domain and AUD tag that gate /admin —
// but those are account-scoped identifiers rather than credentials, and the walk
// below reads only the `binding` property of objects, so a var's value is never
// touched. Real secrets still never appear in the generated config, so this
// cannot leak one or trip over a missing .dev.vars.
//
// The walk is structural rather than a list of known binding categories, and
// that is the whole point: the case this check exists for is an adapter release
// injecting something *new*, which by definition lands in a category nobody
// thought to enumerate. Today's generated config already carries a dozen keys a
// hand-written list would have missed (`pipelines`, `secrets_store_secrets`,
// `ai_search`, `agent_memory`, `artifacts`, `worker_loaders`, `vpc_services`,
// `logfwdr.bindings`, `previews.kv_namespaces`, plus the object-shaped
// `browser` / `images` / `version_metadata` that aren't emitted while unused).
// Wrangler keys almost all of them off a `binding` property, so walking for that
// property catches an invented `some_future_thing_2027` too.
const NAME_KEYED_BINDINGS = [
  'durable_objects.bindings',
  'send_email',
  'logfwdr.bindings',
  'unsafe.bindings',
  'ratelimits',
];

function atPath(config, path) {
  return path.split('.').reduce((node, key) => node?.[key], config);
}

function bindingNames(config) {
  const names = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.binding === 'string') names.add(node.binding);
    for (const value of Object.values(node)) walk(value);
  };
  walk(config);
  // The exceptions: five collections key the binding as `name` rather than
  // `binding`, so the structural walk cannot see them. Unlike a category
  // allowlist, an omission here is not a hole in the whole check, only in the
  // collection omitted — but it is still a hole, so the assertion below
  // re-derives the same set from wrangler's shipped JSON schema and fails if
  // they diverge.
  //
  // `workflows` and `containers` carry a `name` too and are deliberately absent:
  // workflows also carry a `binding` (the walk has them already, and adding the
  // workflow's own name would be a false positive), and a container's `name` is
  // an app identifier rather than an env binding — its Worker-visible binding is
  // the Durable Object one, which is covered.
  for (const path of NAME_KEYED_BINDINGS) {
    for (const entry of atPath(config, path) ?? []) {
      if (typeof entry?.name === 'string') names.add(entry.name);
    }
  }
  return names;
}

// Locate the generated config the way wrangler itself does, then assert it
// exists *before* reading it. Silently skipping the comparison on a missing
// file would fail open on precisely the scenario this check guards — a future
// adapter release that relocates its output would take the whole block out of
// the suite with nothing going red.
//
// .wrangler/deploy/config.json is wrangler's redirected-configuration pointer:
// the adapter writes it, and `wrangler dev`/`deploy` follow it rather than the
// root wrangler.jsonc. Reading the path from there instead of hardcoding it
// means a relocation is *followed*, not merely reported. The literal path stays
// as a fallback for the case where the redirect itself is what disappeared.
function resolveGeneratedConfig() {
  const redirect = resolve('.wrangler/deploy/config.json');
  if (existsSync(redirect)) {
    try {
      const { configPath } = JSON.parse(readFileSync(redirect, 'utf8'));
      if (configPath) return resolve('.wrangler/deploy', configPath);
    } catch {
      // Fall through to the default path; the existence check below reports it.
    }
  }
  return resolve('dist/server/wrangler.json');
}

// isPreviewHost tells the production workers.dev alias apart from a preview
// one purely by comparing the first hostname label to WORKER_NAME. If the
// Worker were renamed in wrangler.jsonc without updating preview.js, that
// comparison would stop matching and the live site's own alias would start
// serving every scheduled draft, RSS included. Same drift-prevention rationale
// as the shared csp.js / security-headers.js modules.
function checkWorkerName() {
  if (!existsSync(WRANGLER_CONFIG)) return;
  const raw = stripComments(readFileSync(WRANGLER_CONFIG, 'utf8'));
  const configuredName = raw.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
  check(
    'preview.js WORKER_NAME matches wrangler.jsonc name',
    configuredName === WORKER_NAME,
    `wrangler.jsonc name=${configuredName ?? '(none)'} vs preview.js WORKER_NAME=${WORKER_NAME}`,
  );
  check(
    'wrangler.jsonc disables the production workers.dev alias',
    /"workers_dev"\s*:\s*false/.test(raw),
    'workers_dev is not set to false — the production alias would expose scheduled drafts',
  );
}

// Re-derive NAME_KEYED_BINDINGS from wrangler's own config schema, so the list
// above cannot quietly rot. A collection it misses is missed *silently* —
// `ratelimits` sat in exactly that state until a review caught it — and nobody
// re-derives a comment that claims to be exhaustive. A wrangler upgrade that
// adds a name-keyed collection now goes red here instead. Skipped (not failed)
// if the schema file ever stops shipping: that is a packaging change, not drift.
function checkNameKeyedBindingsList() {
  const schemaPath = resolve('node_modules/wrangler/config-schema.json');
  if (!existsSync(schemaPath)) return;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const found = new Set();
    const scan = (props, prefix) => {
      for (const [key, value] of Object.entries(props ?? {})) {
        const item = value.items ?? value.anyOf?.map((a) => a.items).find(Boolean);
        const fields = item?.properties;
        if (fields) {
          if ('name' in fields && !('binding' in fields)) found.add(`${prefix}${key}`);
        } else if (value.properties && prefix === '') {
          scan(value.properties, `${key}.`);
        }
      }
    };
    scan(schema.definitions?.RawConfig?.properties ?? schema.properties, '');
    // Name-keyed but an app definition rather than an env binding — see above.
    found.delete('containers');
    const missing = [...found].filter((key) => !NAME_KEYED_BINDINGS.includes(key));
    check(
      'NAME_KEYED_BINDINGS still matches wrangler config schema',
      missing.length === 0,
      `${missing.join(', ')} key their binding off \`name\` in wrangler's schema but are not in` +
        ' NAME_KEYED_BINDINGS — bindings in those collections are invisible to the drift check',
    );
  } catch (err) {
    check('wrangler config schema parses', false, String(err));
  }
}

function checkBindingDrift() {
  const generatedConfig = resolveGeneratedConfig();
  check(
    'generated wrangler config exists',
    existsSync(generatedConfig),
    `no generated config at ${generatedConfig} — either the build did not run, or the adapter moved` +
      ' it and the binding-drift check below is no longer running at all',
  );
  // Asserted rather than merely guarded, for the same fail-open reason as the
  // generated config above: a bare existsSync here would delete the comparison
  // silently.
  check(
    'wrangler.jsonc exists',
    existsSync(WRANGLER_CONFIG),
    `no wrangler.jsonc at ${WRANGLER_CONFIG} — the binding-drift check has nothing to compare against`,
  );
  if (!existsSync(WRANGLER_CONFIG) || !existsSync(generatedConfig)) return;

  let declared;
  let generated;
  try {
    // stripComments only removes lines that START with `//`, so URLs inside
    // string values survive — but a trailing `// comment` after a value would
    // not be stripped and would break the parse. Keep comments on their own
    // lines in wrangler.jsonc. Trailing commas are legal in JSONC but not JSON,
    // so drop them too rather than failing on a legal config.
    const asJson = stripComments(readFileSync(WRANGLER_CONFIG, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
    declared = bindingNames(JSON.parse(asJson));
    generated = bindingNames(JSON.parse(readFileSync(generatedConfig, 'utf8')));
  } catch (err) {
    declared = null;
    check('wrangler configs parse as JSON', false, String(err));
  }
  if (!declared) return;

  // Without this the comparison passes vacuously whenever the walk stops
  // finding anything — a wrangler release renaming the `binding` property, or
  // an adapter emitting a differently-shaped document, would leave every
  // future binding undetected with the suite still green. ASSETS is
  // structurally guaranteed for a Worker with static assets, so its absence
  // means the walk broke rather than that a binding went away.
  check(
    'binding walk still finds bindings in the generated config',
    generated.has('ASSETS'),
    `generated config yielded [${[...generated].join(', ') || 'nothing'}] — ASSETS missing means` +
      ' the walk no longer understands the config shape, and the drift check below proves nothing',
  );
  const undeclared = [...generated].filter((name) => !declared.has(name));
  check(
    'wrangler.jsonc declares every binding in the built worker',
    undeclared.length === 0,
    `${undeclared.join(', ')} present in the generated config but not declared in wrangler.jsonc` +
      ' — the deployed Worker would carry a binding this repo never wrote down',
  );
}

export function checkWranglerConfig() {
  checkWorkerName();
  checkNameKeyedBindingsList();
  checkBindingDrift();
}
