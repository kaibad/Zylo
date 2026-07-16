import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import api from "../api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem("zylo_token"));
  const [loading, setLoading] = useState(true);

  const restoreSession = useCallback(async () => {
    const savedToken = localStorage.getItem("zylo_token");
    const savedUser = localStorage.getItem("zylo_user");

    if (!savedToken) {
      setToken(null);
      setUser(null);
      setLoading(false);
      return;
    }

    if (savedToken) {
      api.defaults.headers.common.Authorization = `Bearer ${savedToken}`;
    }

    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch {
        localStorage.removeItem("zylo_user");
      }
    }

    try {
      const res = await api.get("/auth/me");
      const currentUser = res.data.user;
      localStorage.setItem("zylo_user", JSON.stringify(currentUser));
      setToken(savedToken);
      setUser(currentUser);
    } catch {
      localStorage.removeItem("zylo_token");
      localStorage.removeItem("zylo_user");
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  const login = useCallback(async (username, password) => {
    const res = await api.post("/auth/login", { username, password });
    const { token: newToken, user: newUser } = res.data;
    localStorage.setItem("zylo_token", newToken);
    localStorage.setItem("zylo_user", JSON.stringify(newUser));
    api.defaults.headers.common.Authorization = `Bearer ${newToken}`;
    setToken(newToken);
    setUser(newUser);
    return newUser;
  }, []);

  const register = useCallback(async (username, password) => {
    const res = await api.post("/auth/register", { username, password });
    const { token: newToken, user: newUser } = res.data;
    localStorage.setItem("zylo_token", newToken);
    localStorage.setItem("zylo_user", JSON.stringify(newUser));
    api.defaults.headers.common.Authorization = `Bearer ${newToken}`;
    setToken(newToken);
    setUser(newUser);
    return newUser;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("zylo_token");
    localStorage.removeItem("zylo_user");
    delete api.defaults.headers.common.Authorization;
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, token, loading, login, logout, register }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
