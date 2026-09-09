import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch, apiPost, setApiToken } from "../api/client";

export type Role = "ops_manager" | "technician" | "finance" | "site_host" | "viewer";

export interface AuthUser {
  username: string;
  role: Role;
  displayName: string;
  /**
   * Which row in the `technician` table this login represents. Null for
   * managers and viewers, who are not technicians.
   *
   * The interface uses it to answer "is this work order mine?" without a round
   * trip, so it only decides which buttons are worth showing. The API enforces
   * the same rule independently — a hidden button is a convenience, never a
   * security boundary.
   */
  technicianId: number | null;
  /**
   * Which company a site host belongs to. Null for everybody else.
   *
   * Only used to label the interface — every query a host makes is filtered by
   * the same id server-side, from the signed token rather than from this.
   */
  companyId: number | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  can: (...roles: Role[]) => boolean;
}

const USER_KEY = "chargeops.auth.user";
const AuthContext = createContext<AuthContextValue | null>(null);

function storedUser(): AuthUser | null {
  try {
    const value = localStorage.getItem(USER_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(storedUser);
  const [loading, setLoading] = useState(Boolean(storedUser()));

  const logout = useCallback(() => {
    setApiToken(null);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    apiFetch<AuthUser>("/auth/me")
      .then((current) => {
        setUser(current);
        localStorage.setItem(USER_KEY, JSON.stringify(current));
      })
      .catch(logout)
      .finally(() => setLoading(false));
  }, []); // validate the persisted session once when the app starts

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiPost<{ token: string; user: AuthUser }>("/auth/login", { username, password });
    setApiToken(result.token);
    localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    setUser(result.user);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout, can: (...roles) => Boolean(user && roles.includes(user.role)) }),
    [user, loading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

