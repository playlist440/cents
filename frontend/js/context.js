import { createContext } from './vendor/preact-htm.js';

/** Provided by the outlet to every page: { key, active, route, params, query }. */
export const PageContext = createContext(null);
