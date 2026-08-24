/** Resolve the externally reachable URL used in OAuth redirects and links. */
export function getPublicBaseUrl(): string {
  return (
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.PAPERCLIP_RUNTIME_API_URL?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    `http://127.0.0.1:${process.env.PORT ?? 3100}`
  ).replace(/\/+$/, "");
}
