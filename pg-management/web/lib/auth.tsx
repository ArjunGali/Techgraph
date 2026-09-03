'use client';

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { apiRequest, getToken, setToken, SESSION_EXPIRED_EVENT } from './api';

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'manager' | 'staff';
  permissions: string[];
  branchIds: string[] | null;
};

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  /** True when the signed-in user holds every permission listed. */
  can: (...permissions: string[]) => boolean;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  signIn: async () => undefined,
  signOut: () => undefined,
  can: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session on launch so the app opens where the user left it.
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const response = await apiRequest<{ user: AuthUser }>('/api/auth/me');
        if (!cancelled) setUser(response.user);
      } catch {
        setToken(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  // A token the server has rejected is cleared everywhere at once.
  useEffect(() => {
    const onExpired = () => {
      setToken(null);
      setUser(null);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/login', {
      body: { email, password },
    });
    setToken(response.token);
    setUser(response.user);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const can = useCallback(
    (...permissions: string[]) =>
      user !== null && permissions.every((permission) => user.permissions.includes(permission)),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, can }),
    [user, loading, signIn, signOut, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

/** The permission strings the client checks, mirroring the server catalogue. */
export const P = {
  BRANCH_READ: 'branch.read',
  BRANCH_WRITE: 'branch.write',
  PROPERTY_WRITE: 'property.write',
  TENANT_READ: 'tenant.read',
  TENANT_WRITE: 'tenant.write',
  TENANT_MOVE: 'tenant.move',
  TENANT_DOCUMENT_READ: 'tenant.document.read',
  TENANT_DOCUMENT_WRITE: 'tenant.document.write',
  PRICING_READ: 'pricing.read',
  PRICING_WRITE: 'pricing.write',
  METER_READ: 'meter.read',
  METER_WRITE: 'meter.write',
  BILLING_READ: 'billing.read',
  BILLING_GENERATE: 'billing.generate',
  BILLING_CLOSE: 'billing.close',
  BILLING_REOPEN: 'billing.reopen',
  PAYMENT_READ: 'payment.read',
  PAYMENT_RECORD: 'payment.record',
  PAYMENT_APPROVE: 'payment.approve',
  REPORT_READ: 'report.read',
  REPORT_FINANCE: 'report.finance',
  MAINTENANCE_READ: 'maintenance.read',
  MAINTENANCE_WRITE: 'maintenance.write',
  EXPENSE_READ: 'expense.read',
  EXPENSE_WRITE: 'expense.write',
  MESSAGE_SEND: 'message.send',
  MESSAGE_READ: 'message.read',
  AUTOMATION_READ: 'automation.read',
  AUTOMATION_RUN: 'automation.run',
  USER_MANAGE: 'user.manage',
  AUDIT_READ: 'audit.read',
  SETTINGS_WRITE: 'settings.write',
} as const;
