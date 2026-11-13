import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type AuthConfig, type Me, get } from './api';

export const useMe = () => useQuery<Me>({ queryKey: ['me'], queryFn: () => get('/v1/auth/me'), retry: false, staleTime: 60_000 });
export const useAuthConfig = () => useQuery<AuthConfig>({ queryKey: ['auth-config'], queryFn: () => get('/v1/auth/config'), staleTime: 60_000 });

/** Título de pestaña coherente en todo el panel. */
export function useTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} · DNI Directos 24/7`;
    return () => { document.title = prev; };
  }, [title]);
}
