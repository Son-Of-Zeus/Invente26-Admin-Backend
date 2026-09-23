import React from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import ScanPage from "./pages/Scan";
import AttendancePage from "./pages/Attendance";
import AnalyticsPage from "./pages/Analytics";
import LoginPage from "./pages/Login";
import TechRegistrationPage from "./pages/TechRegistration";
import WorkshopRegistrationPage from "./pages/WorkshopRegistration";
import NonTechRegistrationPage from "./pages/NonTechRegistration";
import SuperAdminDump from "./pages/SuperAdminDump";
import ReceiptReviewPage from "./pages/ReceiptReview";

function RequireAuth({ children, roles }) {
  // simple guard in App; more advanced guard is implemented in pages as needed
  // We'll rely on backend to enforce actual authorization.
  const token = localStorage.getItem("token");
  if (!token) return <Navigate to="/login" replace />;
  if (roles) {
    try {
      const encodedPayload = token.split(".")[1];
      const base64 = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
      const tokenRoles = [
        payload.primary_role,
        payload.role,
        ...(Array.isArray(payload.roles) ? payload.roles : []),
      ].filter(Boolean);
      if (!roles.some(role => tokenRoles.includes(role)))
        return <div className="p-4">Forbidden</div>;
    } catch {
      return <Navigate to="/login" replace />;
    }
  }
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <div className="min-h-screen bg-gray-100">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <Navigate to="/reciept-review" replace />
                </RequireAuth>
              }
            />
            <Route
              path="/scan"
              element={
                <RequireAuth>
                  <ScanPage />
                </RequireAuth>
              }
            />

            <Route
              path="/attendance"
              element={
                <RequireAuth
                  roles={["event_admin", "super_admin", "master_admin"]}
                >
                  <AttendancePage />
                </RequireAuth>
              }
            />
            <Route
              path="/analytics"
              element={
                <RequireAuth roles={["event_admin", "dept_admin", "super_admin", "master_admin", "workshop_admin"]}>
                  <AnalyticsPage />
                </RequireAuth>
              }
            />
            <Route
              path="/tech-registration"
              element={
                <RequireAuth roles={["volunteer", "super_admin", "master_admin"]}>
                  <TechRegistrationPage />
                </RequireAuth>
              }
            />
            <Route
              path="/workshop-registration"
              element={
                <RequireAuth roles={["volunteer", "super_admin", "master_admin", "workshop_admin", "workshop_volunteer"]}>
                  <WorkshopRegistrationPage />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/dump"
              element={
                <RequireAuth roles={["super_admin"]}>
                  <SuperAdminDump />
                </RequireAuth>
              }
            />
            <Route
              path="/non-tech-registration"
              element={
                <RequireAuth roles={["volunteer", "super_admin", "master_admin", "dept_admin"]}>
                  <NonTechRegistrationPage />
                </RequireAuth>
              }
            />
            <Route
              path="/receipt-review"
              element={
                <RequireAuth>
                  <ReceiptReviewPage />
                </RequireAuth>
              }
            />
            <Route
              path="/reciept-review"
              element={
                <RequireAuth>
                  <ReceiptReviewPage />
                </RequireAuth>
              }
            />
            <Route path="*" element={<div className="p-6">Not found</div>} />
          </Routes>
        </div>
      </Router>
    </AuthProvider>
  );
}
