import { useEffect } from "react";

/**
 * After signing in for a preview link, the login page lands here. Continue
 * the server-side preview sign-in (a full page load, not a client route).
 */
export function PreviewAuthResumePage() {
  useEffect(() => {
    window.location.replace(`/api/preview-auth/start${window.location.search}`);
  }, []);
  return <div className="p-6 text-sm text-muted-foreground">Opening preview…</div>;
}
