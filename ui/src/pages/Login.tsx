import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { Zap, Lock, Eye, EyeOff, AlertCircle } from "lucide-react";

type AuthMode = "signin" | "register";

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);

  const nextPath = useMemo(
    () => searchParams.get("next") || getRememberedInvitePath() || "/",
    [searchParams],
  );

  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  if (session) {
    navigate(nextPath, { replace: true });
    return null;
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "signin") {
        await authApi.signInEmail({ email: email.trim(), password });
      } else {
        await authApi.signUpEmail({
          name: name.trim(),
          email: email.trim(),
          password,
        });
      }
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Please fill in all fields.");
      return;
    }

    if (mode === "register") {
      if (password !== confirmPw) {
        setError("Passwords do not match.");
        return;
      }
      if (password.length < 8) {
        setError("Password must be at least 8 characters.");
        return;
      }
      if (!name.trim()) {
        setError("Please enter your name.");
        return;
      }
    }

    if (mutation.isPending) return;
    mutation.mutate();
  };

  const switchMode = (m: AuthMode) => {
    setMode(m);
    setError(null);
    setConfirmPw("");
  };

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #0F172A 0%, #1E293B 50%, #0F172A 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* Decorative background circles */}
      <div
        style={{
          position: "fixed",
          top: -120,
          right: -120,
          width: 400,
          height: 400,
          borderRadius: "50%",
          background: "radial-gradient(circle, #6366F120 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "fixed",
          bottom: -80,
          left: -80,
          width: 320,
          height: 320,
          borderRadius: "50%",
          background: "radial-gradient(circle, #8B5CF620 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          display: "flex",
          gap: 0,
          width: "100%",
          maxWidth: 900,
          borderRadius: 28,
          overflow: "hidden",
          boxShadow: "0 25px 60px -12px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255,255,255,0.05)",
        }}
      >
        {/* ── Left Card: Branding ── */}
        <div
          style={{
            flex: 1,
            background: "#1E293B",
            padding: "52px 48px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            borderRadius: "28px 0 0 28px",
          }}
        >
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 40 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 4px 14px rgba(99, 102, 241, 0.4)",
              }}
            >
              <Zap size={22} color="#FFFFFF" fill="#FFFFFF" />
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#94A3B8",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                }}
              >
                Paperclip
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: "#F1F5F9",
                  letterSpacing: "-0.02em",
                  marginTop: 1,
                }}
              >
                AI Agent Platform
              </div>
            </div>
          </div>

          <h1
            style={{
              fontSize: 26,
              fontWeight: 800,
              color: "#F1F5F9",
              letterSpacing: "-0.03em",
              lineHeight: 1.2,
              marginBottom: 16,
            }}
          >
            Your AI-powered<br />
            agent workspace
          </h1>
          <p style={{ fontSize: 14, color: "#94A3B8", lineHeight: 1.6, marginBottom: 36 }}>
            Deploy autonomous agents that research, code, and execute — all while you focus on what matters.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              ["🎯", "Autonomous agent pipelines"],
              ["📊", "Real-time project intelligence"],
              ["🤖", "Multi-agent orchestration"],
            ].map(([icon, text]) => (
              <div key={text} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 16 }}>{icon}</div>
                <div style={{ fontSize: 13, color: "#CBD5E1", fontWeight: 500 }}>{text}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right Card: Login Form ── */}
        <div
          style={{
            flex: 1,
            background: "#FFFFFF",
            padding: "52px 48px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            borderRadius: "0 28px 28px 0",
          }}
        >
          <div style={{ marginBottom: 32 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <Lock size={16} color="#6366F1" />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#6366F1",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                Secure Login
              </span>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: "#0F172A", letterSpacing: "-0.02em", margin: 0 }}>
              {mode === "signin" ? "Sign in" : "Create account"}
            </h2>
          </div>

          {/* Mode toggle tabs */}
          <div
            style={{
              display: "flex",
              gap: 0,
              marginBottom: 28,
              background: "#E2E8F0",
              borderRadius: 10,
              padding: 4,
            }}
          >
            {[
              ["signin", "Sign in"],
              ["register", "Create account"],
            ].map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m as AuthMode)}
                style={{
                  flex: 1,
                  padding: "9px 12px",
                  borderRadius: 8,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  background: mode === m ? "#FFFFFF" : "transparent",
                  color: mode === m ? "#6366F1" : "#64748B",
                  boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
                  transition: "all 0.15s",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {mode === "register" && (
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#334155",
                    marginBottom: 6,
                  }}
                >
                  Full name
                </label>
                <input
                  type="text"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  style={{
                    width: "100%",
                    padding: "11px 14px",
                    borderRadius: 10,
                    border: "1.5px solid #E2E8F0",
                    fontSize: 14,
                    color: "#0F172A",
                    outline: "none",
                    transition: "border-color 0.15s",
                    boxSizing: "border-box",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#6366F1")}
                  onBlur={(e) => (e.target.style.borderColor = "#E2E8F0")}
                />
              </div>
            )}

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#334155",
                  marginBottom: 6,
                }}
              >
                Email address
              </label>
              <input
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus={mode === "signin"}
                style={{
                  width: "100%",
                  padding: "11px 14px",
                  borderRadius: 10,
                  border: "1.5px solid #E2E8F0",
                  fontSize: 14,
                  color: "#0F172A",
                  outline: "none",
                  transition: "border-color 0.15s",
                  boxSizing: "border-box",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#6366F1")}
                onBlur={(e) => (e.target.style.borderColor = "#E2E8F0")}
              />
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#334155",
                  marginBottom: 6,
                }}
              >
                Password
              </label>
              <div style={{ position: "relative" }}>
                <input
                  type={showPw ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  style={{
                    width: "100%",
                    padding: "11px 42px 11px 14px",
                    borderRadius: 10,
                    border: "1.5px solid #E2E8F0",
                    fontSize: 14,
                    color: "#0F172A",
                    outline: "none",
                    transition: "border-color 0.15s",
                    boxSizing: "border-box",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#6366F1")}
                  onBlur={(e) => (e.target.style.borderColor = "#E2E8F0")}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  style={{
                    position: "absolute",
                    right: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#94A3B8",
                    padding: 4,
                    display: "flex",
                  }}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {mode === "register" && (
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#334155",
                    marginBottom: 6,
                  }}
                >
                  Confirm password
                </label>
                <input
                  type={showPw ? "text" : "password"}
                  placeholder="••••••••"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                  style={{
                    width: "100%",
                    padding: "11px 14px",
                    borderRadius: 10,
                    border: "1.5px solid #E2E8F0",
                    fontSize: 14,
                    color: "#0F172A",
                    outline: "none",
                    transition: "border-color 0.15s",
                    boxSizing: "border-box",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#6366F1")}
                  onBlur={(e) => (e.target.style.borderColor = "#E2E8F0")}
                />
              </div>
            )}

            {error && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "#FEF2F2",
                  border: "1px solid #FECACA",
                  borderRadius: 8,
                  padding: "10px 12px",
                  color: "#DC2626",
                  fontSize: 13,
                }}
              >
                <AlertCircle size={14} style={{ flexShrink: 0 }} />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={mutation.isPending}
              style={{
                marginTop: 4,
                padding: "13px",
                borderRadius: 10,
                background: mutation.isPending
                  ? "#A5B4FC"
                  : "linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)",
                color: "#FFFFFF",
                fontSize: 14,
                fontWeight: 600,
                border: "none",
                cursor: mutation.isPending ? "not-allowed" : "pointer",
                transition: "opacity 0.15s",
                boxShadow: mutation.isPending ? "none" : "0 4px 14px rgba(99, 102, 241, 0.4)",
              }}
            >
              {mutation.isPending
                ? mode === "register"
                  ? "Creating account…"
                  : "Signing in…"
                : mode === "register"
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>

          {mode === "signin" && (
            <p style={{ marginTop: 20, fontSize: 12, color: "#94A3B8", textAlign: "center" }}>
              No account?{" "}
              <button
                type="button"
                onClick={() => switchMode("register")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#6366F1",
                  fontWeight: 600,
                  fontSize: 12,
                  padding: 0,
                }}
              >
                Create one
              </button>
            </p>
          )}
          {mode === "register" && (
            <p style={{ marginTop: 20, fontSize: 12, color: "#94A3B8", textAlign: "center" }}>
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => switchMode("signin")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#6366F1",
                  fontWeight: 600,
                  fontSize: 12,
                  padding: 0,
                }}
              >
                Sign in
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
