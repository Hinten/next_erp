'use client';

import { useMemo, useState } from 'react';
import {
  Center,
  NavLink,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PERM, hasPerm } from '@delfrance/auth';
import { useTenant } from '@/lib/auth';

interface NavLeaf {
  href: string;
  label: string;
  perm?: bigint;
}

interface NavGroup {
  label: string;
  perm?: bigint;
  children: NavLeaf[];
}

type NavEntry = NavLeaf | NavGroup;

const isGroup = (e: NavEntry): e is NavGroup => 'children' in e;

// ─── Edit this array to add, remove, or reorder navigation entries ───────────
// Mirrors the Flutter drawer in lib/menuLateral/homeMenu.dart so the rewrite
// stays at parity. Leaves that don't have a page yet point to placeholders.
const NAV: NavEntry[] = [
  { href: '/inicio', label: 'Início' },
  { href: '/chat', label: 'Atendimento', perm: PERM.chat.read },
  { href: '/clientes', label: 'Clientes', perm: PERM.cliente.read },
  {
    label: 'Movimento',
    perm: PERM.pedido.read,
    children: [
      { href: '/pedidos', label: 'Pedidos', perm: PERM.pedido.read },
      { href: '/pedidos/entradas', label: 'Entradas', perm: PERM.pedido.read },
      { href: '/operacoes', label: 'Operações' },
      { href: '/motivos-incidente', label: 'Motivos de incidente' },
      { href: '/bandeiras-cartao', label: 'Bandeira cartão' },
      { href: '/nfe/exportar', label: 'Exportar NF-e', perm: PERM.nfe.read },
    ],
  },
  {
    label: 'Inventário',
    perm: PERM.produto.read,
    children: [
      { href: '/produtos', label: 'Produtos', perm: PERM.produto.read },
      { href: '/variacoes', label: 'Variações', perm: PERM.produto.read },
      { href: '/categorias', label: 'Categorias', perm: PERM.produto.read },
      { href: '/medidas', label: 'Medidas', perm: PERM.produto.read },
      { href: '/listas-de-precos', label: 'Lista de Precos', perm: PERM.produto.read },
      { href: '/depositos', label: 'Depositos de Estoque', perm: PERM.produto.read },
      { href: '/etiquetas', label: 'Etiquetas', perm: PERM.produto.read },
      { href: '/balanco', label: 'Balanço', perm: PERM.produto.read },
    ],
  },
  {
    label: 'Canais de venda',
    perm: PERM.configuracoes.read,
    children: [
      { href: '/canais/amazon', label: 'Amazon' },
      { href: '/canais/balcao', label: 'Balcão' },
      { href: '/canais/facebook', label: 'Facebook' },
      { href: '/canais/loja-integrada', label: 'Loja Integrada' },
      { href: '/canais/magalu', label: 'Magalu' },
      { href: '/canais/mercado-livre', label: 'Mercado Livre' },
      { href: '/canais/shopee', label: 'Shopee' },
      { href: '/canais/webchat', label: 'Webchat' },
      { href: '/whatsapp', label: 'Whatsapp', perm: PERM.chat.read },
    ],
  },
  {
    label: 'Logística',
    children: [
      { href: '/logistica/melhor-envios', label: 'Melhor Envios' },
      { href: '/logistica/motoboy', label: 'Motoboy' },
      { href: '/logistica/fob', label: 'Por conta do destinatário (FOB)' },
      { href: '/logistica/retirada', label: 'Retirada' },
    ],
  },
  {
    label: 'Meios de Pagamento',
    perm: PERM.pagamento.read,
    children: [
      { href: '/pagamentos/mercado-pago', label: 'Mercado Pago', perm: PERM.pagamento.read },
    ],
  },
  {
    label: 'Relatórios',
    perm: PERM.pedido.read,
    children: [
      { href: '/relatorios/checkouts', label: 'Checkouts' },
      { href: '/relatorios/localizacao-produtos', label: 'Localização de produtos' },
      { href: '/relatorios/produtos', label: 'Vendas por produto' },
      { href: '/relatorios/vendas', label: 'Vendas por período' },
      { href: '/relatorios/mais-vendidos', label: 'Produtos Mais Vendidos' },
      { href: '/relatorios/vendas-estampas', label: 'Vendas Estampas' },
    ],
  },
  {
    label: 'Configurações',
    perm: PERM.configuracoes.read,
    children: [
      { href: '/configuracoes/filiais', label: 'Filiais' },
      { href: '/configuracoes/cargos', label: 'Cargos' },
      { href: '/configuracoes/usuarios', label: 'Usuários' },
    ],
  },
];
// ─────────────────────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV === 'development';

const matches = (haystack: string, needle: string) =>
  haystack.toLocaleLowerCase().includes(needle);

export function SidebarNav() {
  const { claims, loading } = useTenant();
  const pathname = usePathname();
  const [search, setSearch] = useState('');

  const permitted = useMemo(() => {
    const grant = claims?.permissions ?? undefined;
    return (perm?: bigint) => !perm || hasPerm(grant, perm);
  }, [claims?.permissions]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return NAV.map((entry) => ({ entry, expand: false }));

    const out: { entry: NavEntry; expand: boolean }[] = [];
    for (const entry of NAV) {
      if (isGroup(entry)) {
        const titleHit = matches(entry.label, needle);
        const childHits = entry.children.filter((c) => matches(c.label, needle));
        if (titleHit || childHits.length > 0) {
          out.push({
            entry: titleHit ? entry : { ...entry, children: childHits },
            expand: true,
          });
        }
      } else if (matches(entry.label, needle)) {
        out.push({ entry, expand: false });
      }
    }
    return out;
  }, [search]);

  if (loading) {
    return (
      <Stack gap={4}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} height={32} />
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap="xs">
      <TextInput
        placeholder="Pesquisar"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        size="sm"
      />
      <Stack gap={2}>
        {filtered.length === 0 && (
          <Center py="md">
            <Text size="sm" c="dimmed">
              Nenhum item encontrado
            </Text>
          </Center>
        )}
        {filtered.map(({ entry, expand }) =>
          isGroup(entry) ? (
            <GroupNode
              key={entry.label}
              group={entry}
              defaultOpened={expand}
              permitted={permitted}
              pathname={pathname}
            />
          ) : (
            <LeafNode
              key={entry.href}
              leaf={entry}
              permitted={permitted}
              pathname={pathname}
            />
          ),
        )}
      </Stack>
    </Stack>
  );
}

function GroupNode({
  group,
  defaultOpened,
  permitted,
  pathname,
}: {
  group: NavGroup;
  defaultOpened: boolean;
  permitted: (perm?: bigint) => boolean;
  pathname: string | null;
}) {
  const groupAllowed = permitted(group.perm);
  if (!groupAllowed && !isDev) return null;

  const childActive = group.children.some(
    (c) => pathname === c.href || pathname?.startsWith(`${c.href}/`),
  );

  return (
    <NavLink
      label={group.label}
      defaultOpened={defaultOpened || childActive}
      style={groupAllowed ? undefined : { opacity: 0.5 }}
      childrenOffset={28}
    >
      {group.children.map((leaf) => (
        <LeafNode
          key={leaf.href}
          leaf={leaf}
          permitted={permitted}
          pathname={pathname}
        />
      ))}
    </NavLink>
  );
}

function LeafNode({
  leaf,
  permitted,
  pathname,
}: {
  leaf: NavLeaf;
  permitted: (perm?: bigint) => boolean;
  pathname: string | null;
}) {
  const allowed = permitted(leaf.perm);
  const active = pathname === leaf.href || pathname?.startsWith(`${leaf.href}/`);

  if (!allowed) {
    if (!isDev) return null;
    return (
      <Tooltip label="Sem permissão" position="right" withArrow>
        <NavLink
          label={leaf.label}
          active={active ?? false}
          style={{ opacity: 0.4, cursor: 'default' }}
          onClick={(e) => e.preventDefault()}
        />
      </Tooltip>
    );
  }

  return (
    <NavLink
      component={Link}
      href={leaf.href}
      label={leaf.label}
      active={active ?? false}
    />
  );
}
