// Moved to the shared data layer (`@/lib/data/newDocId`) so the pedido port can
// reuse it. Re-exported here for the produto callers' existing import path.
export { newDocId } from '@/lib/data/newDocId';
