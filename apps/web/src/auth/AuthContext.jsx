import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiRequest } from "@/lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState(null);
  const [status, setStatus] = useState("loading");
  const [retryKey, setRetryKey] = useState(0);
  const bootstrapRequest = useRef(null);

  const refreshCsrf = useCallback(async () => {
    const data = await apiRequest("/api/auth/csrf", { cache: "no-store" });
    setCsrfToken(data.csrfToken);
    return data.csrfToken;
  }, []);

  const signIn = useCallback(async (role, credentials) => {
    const token = csrfToken ?? (await refreshCsrf());
    const data = await apiRequest(`/api/auth/${role.toLowerCase()}/login`, {
      method: "POST",
      csrfToken: token,
      body: JSON.stringify(credentials),
    });
    setUser(data.user);
    setCsrfToken(data.csrfToken);
    setStatus("ready");
    return data.user;
  }, [csrfToken, refreshCsrf]);

  const registerStudent = useCallback(async (details) => {
    const token = csrfToken ?? (await refreshCsrf());
    return apiRequest("/api/auth/student/register", {
      method: "POST",
      csrfToken: token,
      body: JSON.stringify(details),
    });
  }, [csrfToken, refreshCsrf]);

  const signOut = useCallback(async () => {
    const token = csrfToken ?? (await refreshCsrf());
    await apiRequest("/api/auth/logout", { method: "POST", csrfToken: token });
    setUser(null);
    setCsrfToken(null);
    setStatus("ready");
  }, [csrfToken, refreshCsrf]);

  useEffect(() => {
    let active = true;
    bootstrapRequest.current ??= (async () => {
      await refreshCsrf();
      return apiRequest("/api/auth/me", { cache: "no-store" });
    })();

    bootstrapRequest.current
      .then((data) => {
        if (!active) return;
        setUser(data.user);
        setStatus("ready");
      })
      .catch((error) => {
        if (!active) return;
        if (error.status === 401) {
          setUser(null);
          setStatus("ready");
        } else {
          setStatus("error");
        }
      });

    return () => {
      active = false;
    };
  }, [refreshCsrf, retryKey]);

  const retrySession = useCallback(() => {
    bootstrapRequest.current = null;
    setStatus("loading");
    setCsrfToken(null);
    setRetryKey((current) => current + 1);
  }, []);

  const value = useMemo(
    () => ({ user, status, csrfToken, signIn, signOut, registerStudent, retrySession }),
    [user, status, csrfToken, signIn, signOut, registerStudent, retrySession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider.");
  return context;
}
