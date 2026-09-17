/* Deliberately empty.

   The classifier used to run here, which is where a 1.17 s inference belongs.
   It cannot: loadLiteRt() evaluates its emscripten glue with importScripts(),
   which a module worker forbids -- "Module scripts don't support
   importScripts()" -- and the runtime is ESM-only, so a classic worker cannot
   load it either. The model therefore runs on the main thread; see engine.js
   for what that costs and how scan.js pays for it.

   This file is kept, and kept in the service worker's shell list, so that a
   phone still holding an older cached copy of the app cannot end up fetching a
   worker that no longer exists. Revisit if LiteRT ships a worker-safe loader.
*/
