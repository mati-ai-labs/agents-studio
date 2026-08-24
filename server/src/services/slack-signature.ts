import crypto from "node:crypto";

export interface SlackSignatureHeaders {
  timestamp: string | undefined;
  signature: string | undefined;
}

export function verifySlackSignature(
  rawBody: Buffer | string | undefined,
  headers: SlackSignatureHeaders,
  signingSecret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!rawBody || !signingSecret || !headers.timestamp || !headers.signature) return false;
  if (!/^\d+$/.test(headers.timestamp)) return false;
  const timestamp = Number(headers.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;
  if (!/^v0=[0-9a-f]{64}$/i.test(headers.signature)) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const base = `v0:${headers.timestamp}:${body}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  const actualBuffer = Buffer.from(headers.signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
