import React, { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useNavigate } from "react-router-dom";

export default function LoginPage() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [dept, setDept] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const { login, signup } = useAuth();
  const navigate = useNavigate();

  const isSignup = mode === "signup";

  function switchMode(nextMode) {
    setMode(nextMode);
    setError(null);
  }

  async function onSubmit(event) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (isSignup) {
        await signup({
          email,
          password,
          name,
          dept: dept || null,
        });
      } else {
        await login(email, password);
      }
      navigate("/reciept-review");
    } catch (requestError) {
      setError(requestError?.response?.data?.error || requestError?.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto mt-8 max-w-md p-4 md:mt-16">
      <div className="rounded bg-white p-6 shadow">
        <h2 className="mb-2 text-xl font-semibold md:text-2xl">
          {isSignup ? "Create volunteer account" : "Volunteer login"}
        </h2>
        <p className="mb-6 text-sm text-gray-600">
          {isSignup
            ? "Only emails approved by the registration team can sign up."
            : "Sign in to review payment receipts."}
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          {isSignup && (
            <>
              <label className="block text-sm font-medium text-gray-700">
                Full name
                <input
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  className="mt-1 w-full rounded border p-2 font-normal"
                />
              </label>
              <label className="block text-sm font-medium text-gray-700">
                Department <span className="font-normal text-gray-400">(optional)</span>
                <input
                  value={dept}
                  onChange={(event) => setDept(event.target.value)}
                  className="mt-1 w-full rounded border p-2 font-normal"
                />
              </label>
            </>
          )}

          <label className="block text-sm font-medium text-gray-700">
            Email
            <input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              className="mt-1 w-full rounded border p-2 font-normal"
            />
          </label>

          <label className="block text-sm font-medium text-gray-700">
            Password
            <input
              required
              type="password"
              minLength={isSignup ? 8 : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isSignup ? "new-password" : "current-password"}
              className="mt-1 w-full rounded border p-2 font-normal"
            />
            {isSignup && <span className="mt-1 block text-xs font-normal text-gray-500">Use at least 8 characters.</span>}
          </label>

          {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Please wait…" : isSignup ? "Create account" : "Login"}
          </button>
        </form>

        <div className="mt-5 text-center text-sm text-gray-600">
          {isSignup ? "Already have an account?" : "Need to register as a volunteer?"}{" "}
          <button
            type="button"
            onClick={() => switchMode(isSignup ? "login" : "signup")}
            className="font-semibold text-blue-600 hover:underline"
          >
            {isSignup ? "Login" : "Sign up"}
          </button>
        </div>
      </div>
    </div>
  );
}
