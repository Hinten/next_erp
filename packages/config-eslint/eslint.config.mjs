// Relative import, not `@delfrance/config-eslint` — this package IS that
// package, so importing its own published name would resolve through
// `exports` back to `./index.js` anyway, but the relative path avoids relying
// on the workspace symlink existing for self-lint.
import base, { prettier } from './index.js';

export default [...base, prettier];
