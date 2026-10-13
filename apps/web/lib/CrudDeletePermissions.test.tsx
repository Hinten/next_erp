import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { deleteApp, initializeApp } from 'firebase/app';
import { getFirestore, terminate, type Firestore } from 'firebase/firestore';
import type { ComponentType } from 'react';
import { PERM } from '@delfrance/auth';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * Render every affected route, capturing its real ObjectView permission props.
 * The medidas route's own suite separately checks the real delete-button UI.
 * Schemas, field configurations, collection handles and query construction stay
 * real; only mounted I/O and unrelated account/address panels are doubled.
 */
interface PermissionProps {
  canEdit?: boolean;
  readOnly?: boolean;
  canDelete?: boolean;
  onDelete?: (id: string) => Promise<void>;
}

const h = vi.hoisted(() => ({
  granted: 0n,
  captured: null as PermissionProps | null,
  db: null as Firestore | null,
  storage: {},
  emptySnapshot: { data: [], loading: false, error: undefined, fromCache: false },
  missingSnapshot: { data: null, loading: false, error: undefined, fromCache: false },
}));

vi.mock('@delfrance/ui', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/ui')>()),
  ObjectView: (props: PermissionProps) => {
    h.captured = props;
    return null;
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { uid: 'permission-test-user' } }),
  usePermission: (bit: bigint) => ({ allowed: (h.granted & bit) === bit, loading: false }),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'permission-test-record' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => h.db,
  getFirebaseStorage: () => h.storage,
}));

vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useSnapshot: () => h.emptySnapshot,
  useDocSnapshot: () => h.missingSnapshot,
}));

vi.mock('@/lib/clientes/useDefaultFilialId', () => ({
  useDefaultFilialId: () => undefined,
}));
// The produto editor asks whether the kit has an active Shopee native-kit link (step 19), through `useQuery`; this
// suite renders the editor without a QueryClientProvider, so the hook is stubbed like `useDefaultFilialId` above.
vi.mock('@/lib/shopee/kitNativo', () => ({
  useKitNativoShopee: () => ({ temKitNativo: false, carregando: false }),
}));
vi.mock('@/lib/categorias/cascadeNomeCompleto', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/categorias/cascadeNomeCompleto')>()),
  listDescendantIdsForPicker: () => Promise.resolve([]),
}));

vi.mock('@/app/(app)/clientes/[id]/_components/EnderecosSection', () => ({
  EnderecosSection: () => null,
}));
vi.mock('@/app/(app)/canais/_components/RecalcularPrecosCanalAction', () => ({
  RecalcularPrecosCanalAction: () => null,
}));
vi.mock('@/app/(app)/canais/mercado-livre/_components/ContaMercadoLivrePanel', () => ({
  ContaMercadoLivrePanel: () => null,
}));
vi.mock('@/app/(app)/canais/shopee/_components/ContaShopeePanel', () => ({
  ContaShopeePanel: () => null,
}));
vi.mock('@/app/(app)/canais/whatsapp/_components/ContaWhatsappPanel', () => ({
  ContaWhatsappPanel: () => null,
}));
vi.mock('@/app/(app)/canais/whatsapp/_components/ContaWhatsappHealth', () => ({
  ContaWhatsappHealth: () => null,
}));

import BandeiraCartaoPage from '@/app/(app)/bandeiras-cartao/[id]/page';
import BalcaoPage from '@/app/(app)/canais/balcao/[id]/page';
import ContaMercadoLivrePage from '@/app/(app)/canais/mercado-livre/[id]/page';
import ContaShopeePage from '@/app/(app)/canais/shopee/[id]/page';
import ContaWhatsappPage from '@/app/(app)/canais/whatsapp/[id]/page';
import CategoriaPage from '@/app/(app)/categorias/[id]/page';
import ClientePage from '@/app/(app)/clientes/[id]/page';
import DepositoPage from '@/app/(app)/depositos/[id]/page';
import TabelaDeMedidasPage from '@/app/(app)/medidas/[id]/page';
import MotivoIncidentePage from '@/app/(app)/motivos-incidente/[id]/page';
import OperacaoPage from '@/app/(app)/operacoes/[id]/page';
import EditarProdutoPage from '@/app/(app)/produtos/[id]/editar/page';
import GrupoVariacaoPage from '@/app/(app)/variacoes/[id]/page';

// Creating refs/queries does no I/O. No snapshot listener or operation reaches
// this named test app; the explicit database id matches Enterprise's name.
const testApp = initializeApp(
  { projectId: 'demo-crud-delete-permissions' },
  'crud-delete-permissions',
);
h.db = getFirestore(testApp, 'default');

interface PageCase {
  path: string;
  Page: ComponentType;
  permissions: { write: bigint; delete: bigint };
}

const PAGES: PageCase[] = [
  { path: '/medidas/[id]', Page: TabelaDeMedidasPage, permissions: PERM.produto },
  { path: '/produtos/[id]/editar', Page: EditarProdutoPage, permissions: PERM.produto },
  { path: '/variacoes/[id]', Page: GrupoVariacaoPage, permissions: PERM.produto },
  { path: '/clientes/[id]', Page: ClientePage, permissions: PERM.cliente },
  { path: '/categorias/[id]', Page: CategoriaPage, permissions: PERM.categoria },
  { path: '/depositos/[id]', Page: DepositoPage, permissions: PERM.estoque },
  { path: '/bandeiras-cartao/[id]', Page: BandeiraCartaoPage, permissions: PERM.pagamento },
  { path: '/motivos-incidente/[id]', Page: MotivoIncidentePage, permissions: PERM.pedido },
  { path: '/operacoes/[id]', Page: OperacaoPage, permissions: PERM.fiscal },
  { path: '/canais/balcao/[id]', Page: BalcaoPage, permissions: PERM.integracao },
  { path: '/canais/mercado-livre/[id]', Page: ContaMercadoLivrePage, permissions: PERM.integracao },
  { path: '/canais/shopee/[id]', Page: ContaShopeePage, permissions: PERM.integracao },
  { path: '/canais/whatsapp/[id]', Page: ContaWhatsappPage, permissions: PERM.integracao },
];

const GRANTS = [
  { label: 'neither permission', write: false, delete: false },
  { label: 'write only', write: true, delete: false },
  { label: 'delete only', write: false, delete: true },
  { label: 'write and delete', write: true, delete: true },
];

beforeEach(() => {
  h.granted = 0n;
  h.captured = null;
  localStorage.clear();
});

afterAll(async () => {
  if (h.db) await terminate(h.db);
  await deleteApp(testApp);
});

describe.each(PAGES)('$path — separate write and delete permissions', ({ Page, permissions }) => {
  it.each(GRANTS)('$label', async (grant) => {
    h.granted = (grant.write ? permissions.write : 0n) | (grant.delete ? permissions.delete : 0n);

    await act(async () => {
      render(
        <MantineTestProvider>
          <Page />
        </MantineTestProvider>,
      );
    });

    expect(h.captured).not.toBeNull();
    expect(h.captured?.canDelete).toBe(grant.delete);
    expect(h.captured?.canEdit).toBe(grant.write);
    expect(h.captured?.readOnly).toBe(!grant.write);
    expect(h.captured?.onDelete).toBeTypeOf('function');
  });
});
