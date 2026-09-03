'use client';

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { apiRequest, ApiError, getToken, setToken, SESSION_EXPIRED_EVENT } from './api';

/**
 * Single-user mode.
 *
 * The owner runs this app on their own phone and does not want to type a
 * password every time they open it, so when credentials are compiled in the
 * app signs itself in on launch and goes straight to the dashboard.
 *
 * Authentication is not removed, only made invisible: the server still
 * authenticates every request, still enforces role permissions, and still
 * attributes each action to a real user in the audit trail. What changes is
 * only who types the password.
 *
 * The trade-off is that these credentials live inside the APK, so the package
 * should be treated as sensitive. Leave them unset to get the ordinary sign-in
 * screen back.
 */
const AUTO_LOGIN_EMAIL = process.env.NEXT_PUBLIC_AUTO_LOGIN_EMAIL ?? '';
const AUTO_LOGIN_PASSWORD = process.env.NEXT_PUBLIC_AUTO_LOGIN_PASSWORD ?? '';

export const autoLoginConfigured = AUTO_LOGIN_EMAIL !== '' && AUTO_LOGIN_PASSWORD !== '';

/** Set when the user signs out deliberately, so they are not signed straight back in. */
const SUPPRESS_AUTO_LOGIN_KEY = 'pg.auth.suppressAutoLogin';

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'manager' | 'staff';
  permissions: string[];
  branchIds: string[] | null;
};

/** Why the app is not showing the dashboard, when it is not. */
export type AuthBlocker =
  | null
  /** Automatic sign-in could not reach the server; the address may be wrong. */
  | 'unreachable'
  /** The compiled-in credentials were rejected, or there are none. */
  | 'credentials';

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  blocker: AuthBlocker;
  /** Last error from an automatic sign-in, for the setup screen. */
  blockerMessage: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  /** Retries automatic sign-in, after the server address has been corrected. */
  retryAutoLogin: () => Promise<void>;
  /** True when the signed-in user holds every permission listed. */
  can: (...permissions: string[]) => boolean;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  blocker: null,
  blockerMessage: null,
  signIn: async () => undefined,
  signOut: () => undefined,
  retryAutoLogin: async () => undefined,
  can: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [blocker, setBlocker] = useState<AuthBlocker>(null);
  const [blockerMessage, setBlockerMessage] = useState<string | null>(null);

  /**
   * Signs in with the compiled-in credentials.
   *
   * Distinguishes "cannot reach the server" from "the server said no", because
   * the two need different things from the user: the first is a wrong address,
   * the second is a wrong password.
   */
  const attemptAutoLogin = useCallback(async (): Promise<boolean> => {
    if (!autoLoginConfigured) {
      setBlocker('credentials');
      return false;
    }

    try {
      const response = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/login', {
        body: { email: AUTO_LOGIN_EMAIL, password: AUTO_LOGIN_PASSWORD },
      });
      setToken(response.token);
      setUser(response.user);
      setBlocker(null);
      setBlockerMessage(null);
      return true;
    } catch (error) {
      const apiError = error as ApiError;
      setBlockerMessage(apiError.message);
      // A network failure or a 5xx is the server being unreachable or unwell;
      // anything else is the credentials themselves being wrong.
      setBlocker(apiError.status === 0 || apiError.status >= 500 ? 'unreachable' : 'credentials');
      return false;
    }
  }, []);

  // Restore the session on launch so the app opens where the user left it, and
  // sign in automatically when there is nothing to restore.
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (getToken()) {
        try {
          const response = await apiRequest<{ user: AuthUser }>('/api/auth/me');
          if (!cancelled) {
            setUser(response.user);
            setLoading(false);
          }
          return;
        } catch {
          // The stored token is stale; fall through to signing in again.
          setToken(null);
        }
      }

      const suppressed =
        window.sessionStorage.getItem(SUPPRESS_AUTO_LOGIN_KEY) === 'true';

      if (!cancelled) {
        if (suppressed) setBlocker('credentials');
        else await attemptAutoLogin();
        setLoading(false);
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [attemptAutoLogin]);

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
    // Signing in by hand clears any earlier failure and re-enables automatic
    // sign-in on the next launch.
    window.sessionStorage.removeItem(SUPPRESS_AUTO_LOGIN_KEY);
    setToken(response.token);
    setUser(response.user);
    setBlocker(null);
    setBlockerMessage(null);
  }, []);

  const signOut = useCallback(() => {
    // Without this the app would sign straight back in and signing out would
    // appear to do nothing. Session-scoped, so the next launch is automatic again.
    window.sessionStorage.setItem(SUPPRESS_AUTO_LOGIN_KEY, 'true');
    setToken(null);
    setUser(null);
    setBlocker('credentials');
  }, []);

  const retryAutoLogin = useCallback(async () => {
    window.sessionStorage.removeItem(SUPPRESS_AUTO_LOGIN_KEY);
    setLoading(true);
    await attemptAutoLogin();
    setLoading(false);
  }, [attemptAutoLogin]);

  const can = useCallback(
    (...permissions: string[]) =>
      user !== null && permissions.every((permission) => user.permissions.includes(permission)),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, blocker, blockerMessage, signIn, signOut, retryAutoLogin, can }),
    [user, loading, blocker, blockerMessage, signIn, signOut, retryAutoLogin, can],
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
