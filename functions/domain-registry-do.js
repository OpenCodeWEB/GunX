/**
 * Pages Functions entrypoint for the .gunx registry Durable Object.
 * Wrangler requires the DO class to be reachable from the functions
 * directory when a binding references it (see wrangler.toml at repo root).
 */
export { DomainRegistryObject } from "../worker/src/DomainRegistryDO.js";