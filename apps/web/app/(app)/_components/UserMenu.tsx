'use client';

import { signOut } from 'firebase/auth';
import { useRouter } from 'next/navigation';
import { Avatar, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { useAuth } from '@/lib/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';

function initials(email: string | null | undefined): string {
  if (!email) return '?';
  const local = email.split('@')[0] ?? '';
  return local.slice(0, 2).toUpperCase();
}

export function UserMenu() {
  const { user } = useAuth();
  const router = useRouter();

  if (!user) return null;

  async function handleSignOut() {
    await signOut(getFirebaseAuth());
    router.replace('/login');
  }

  return (
    <Menu shadow="md" width={220} position="bottom-end">
      <Menu.Target>
        <UnstyledButton>
          <Group gap="xs">
            <Avatar size="sm" color="blue" radius="xl">
              {initials(user.email)}
            </Avatar>
            <Text size="sm" visibleFrom="sm">
              {user.email}
            </Text>
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{user.email ?? 'Conta'}</Menu.Label>
        <Menu.Item onClick={handleSignOut} color="red">
          Sair
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
