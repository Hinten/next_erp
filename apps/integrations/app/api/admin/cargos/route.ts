import { ACCESS_ACTION } from '@delfrance/schemas';
import { mutateEditor } from '@/lib/accessRoutes';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (req: Request) => mutateEditor(req, ACCESS_ACTION.createCargo);
