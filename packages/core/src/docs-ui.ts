/**
 * # Docs UI
 *
 * Self-contained HTML pages that render the generated OpenAPI / AsyncAPI
 * documents, pulling their viewer libraries from a CDN (no bundled dependency).
 * Used by {@link server} when the `docs` option is enabled — it serves the spec
 * JSON (computed once and cached in memory) plus a Swagger UI, a ReDoc, and an
 * AsyncAPI page.
 *
 * @module
 */

/** Configuration for the built-in documentation routes (`ServerOptions.docs`). */
export interface DocsOptions {
  /** `info` (title/version) passed to the generated documents. */
  readonly info?: { title?: string; version?: string };
  /** Path serving the OpenAPI 3.1 JSON (default `/docs/openapi.json`); `false` to disable. */
  readonly openapiJson?: string | false;
  /** Path serving the AsyncAPI 3.0 JSON (default `/docs/asyncapi.json`); `false` to disable. */
  readonly asyncapiJson?: string | false;
  /** Path serving the Swagger UI page (default `/docs/swagger`); `false` to disable. */
  readonly swagger?: string | false;
  /** Path serving the ReDoc page (default `/docs/redoc`); `false` to disable. */
  readonly redoc?: string | false;
  /** Path serving the AsyncAPI viewer page (default `/docs/asyncapi`); `false` to disable. */
  readonly asyncapi?: string | false;
}

/** Fully-resolved docs routes (internal). @internal */
export interface ResolvedDocs {
  readonly info?: { title?: string; version?: string };
  readonly openapiJson: string | null;
  readonly asyncapiJson: string | null;
  readonly swagger: string | null;
  readonly redoc: string | null;
  readonly asyncapi: string | null;
}

const DEFAULTS = {
  openapiJson: '/docs/openapi.json',
  asyncapiJson: '/docs/asyncapi.json',
  swagger: '/docs/swagger',
  redoc: '/docs/redoc',
  asyncapi: '/docs/asyncapi',
} as const;

/** Resolve the `docs` option into concrete routes, or `null` when disabled. @internal */
export function normalizeDocs(opt: boolean | DocsOptions | undefined): ResolvedDocs | null {
  if (!opt) {return null;}
  const o = opt === true ? {} : opt;
  const pick = (v: string | false | undefined, d: string): string | null => (v === false ? null : (v ?? d));
  return {
    info: o.info,
    openapiJson: pick(o.openapiJson, DEFAULTS.openapiJson),
    asyncapiJson: pick(o.asyncapiJson, DEFAULTS.asyncapiJson),
    swagger: pick(o.swagger, DEFAULTS.swagger),
    redoc: pick(o.redoc, DEFAULTS.redoc),
    asyncapi: pick(o.asyncapi, DEFAULTS.asyncapi),
  };
}

/** Escape a string for safe inclusion in an HTML attribute. */
function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A self-contained Swagger UI page (loaded from unpkg) pointed at `specUrl`. */
export function swaggerHtml(specUrl: string, title = 'API — Swagger UI'): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${attr(title)}</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: '#swagger-ui' })
    </script>
  </body>
</html>`;
}

/** A self-contained ReDoc page (loaded from the Redocly CDN) pointed at `specUrl`. */
export function redocHtml(specUrl: string, title = 'API — ReDoc'): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${attr(title)}</title>
  </head>
  <body style="margin: 0">
    <redoc spec-url="${attr(specUrl)}"></redoc>
    <script src="https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js" crossorigin></script>
  </body>
</html>`;
}

/** A self-contained AsyncAPI page (the `@asyncapi/web-component`, loaded from unpkg) pointed at `specUrl`. */
export function asyncapiHtml(specUrl: string, title = 'API — AsyncAPI'): string {
  const css = 'https://unpkg.com/@asyncapi/react-component@2/styles/default.min.css';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${attr(title)}</title>
    <link rel="stylesheet" href="${css}" />
  </head>
  <body>
    <asyncapi-component schemaUrl="${attr(specUrl)}" cssImportPath="${css}"></asyncapi-component>
    <script src="https://unpkg.com/@asyncapi/web-component@2/lib/asyncapi-web-component.js" defer></script>
  </body>
</html>`;
}
