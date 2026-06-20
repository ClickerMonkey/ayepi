/**
 * # @ayepi/plugin
 *
 * A plugin system for [`@ayepi/core`](https://www.npmjs.com/package/@ayepi/core):
 * compose an API from independent **plugins** — each a frontend-safe spec, its
 * implementation, an exported **state** service that dependents call directly,
 * lifecycle hooks, and a `requires` list — and install/uninstall them into a
 * **running** server.
 *
 * - {@link plugin} — define a plugin (a ctx-aware builder: `.middleware`/`.handlers`/
 *   `.lifecycle`).
 * - {@link createPluginHost} — install/uninstall plugins into a live server, in
 *   dependency order, with their lifecycle and dependency context wired up.
 *
 * Built on core's hot `Server.install`/`uninstall`, the in-process `localClient`
 * caller, and `provide`.
 *
 * @module
 */

export { plugin } from './plugin';
export type {
  Plugin,
  AnyPlugin,
  PluginConfig,
  PluginCtx,
  DepsCtx,
  DepsRecord,
  DepHandle,
  PartialHandlers,
  Lifecycle,
  PluginShape,
  CtxOf,
  PluginHandlers,
  PluginHandler,
  PluginMiddleware,
  StateOf,
  SpecOf,
  NameOf,
} from './plugin';

export { createPluginHost } from './host';
export type { PluginHost, PluginHostOptions } from './host';
