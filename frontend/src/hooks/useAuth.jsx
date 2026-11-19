import React, { createContext, useContext, useMemo, useState } from "react";
import { createApi } from "../api/api";
import axios from "axios";

const AuthContext = createContext(null);

function decodeJwtPayload(token) {
  try {
    const encodedPayload = token?.split(".")[1];
    if (!encodedPayload) return null;
    const base64 = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function userFromPayload(payload) {
  if (!payload) return null;
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  const primaryRole = payload.primary_role || payload.role || roles[0] || null;

  return {
    ...payload,
    email: payload.email || null,
    role: primaryRole,
    primary_role: payload.primary_role || null,
    roles,
    permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
    department_id: payload.department_id ?? null,
    department_ids: Array.isArray(payload.department_ids) ? payload.department_ids : [],
    event_id: payload.event_id ?? null,
    event_ids: Array.isArray(payload.event_ids) ? payload.event_ids : [],
  };
}

function readStoredAuth() {
  const storedToken = localStorage.getItem("token");
  const payload = decodeJwtPayload(storedToken);
  const isStaffToken = payload
    && payload.iss === "invente-auth"
    && payload.token_type === "access"
    && typeof payload.sub === "string"
    && Array.isArray(payload.roles)
    && payload.roles.length > 0;

  if (!isStaffToken) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    return { token: null, user: null };
  }

  return { token: storedToken, user: userFromPayload(payload) };
}

// The context hook and provider intentionally live together for this app.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [initialAuth] = useState(readStoredAuth);
  const [token, setToken] = useState(initialAuth.token);
  const [user, setUser] = useState(initialAuth.user);

  // REMOVED: The problematic useEffect that caused the race condition.
  // The logic is now handled directly in login() and logout().

  const saveToken = (newToken) => {
    const payload = decodeJwtPayload(newToken);
    const newUser = userFromPayload(payload);

    if (!newUser || payload?.iss !== "invente-auth" || payload?.token_type !== "access") {
      throw new Error("server returned an invalid staff token");
    }

    localStorage.setItem("token", newToken);
    localStorage.setItem("user", JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
    return { token: newToken, user: newUser };
  };

  const login = async (email, password) => {
    const base = import.meta.env.VITE_API_BASE || "http://localhost:4000/organizers/api";
    const resp = await axios.post(
      `${base}/auth/login`,
      { email, password }
    );
    return saveToken(resp.data.token);
  };

  const signup = async (profile) => {
    const base = import.meta.env.VITE_API_BASE || "http://localhost:4000/organizers/api";
    const resp = await axios.post(`${base}/auth/signup`, profile);
    return saveToken(resp.data.token);
  };

  const logout = () => {
    // FIX: Clear localStorage immediately and synchronously BEFORE updating state.
    localStorage.removeItem("token");
    localStorage.removeItem("user");

    setToken(null);
    setUser(null);
  };

  const authAxios = useMemo(() => createApi(token), [token]);

  return (
    <AuthContext.Provider value={{ token, user, login, signup, logout, authAxios }}>
      {children}
    </AuthContext.Provider>
  );
}
