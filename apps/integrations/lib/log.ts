import { createLogger } from '@delfrance/logger';

// Root logger for apps/integrations (server-only API app). Create a child per
// module/route for context: `const log = rootLog.child({ mod: 'admin/users' })`.
export const rootLog = createLogger('integrations');
