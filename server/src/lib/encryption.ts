/**
 * @fileoverview Lightweight AES-256-GCM encryption utilities for connector
 * credentials. Uses the same master-key mechanism as the local encrypted
 * secrets provider.
 *
 * Tokens and secrets stored in `company_connectors.credentials_encrypted`
 * are encrypted with this module so they are never stored as plaintext.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { resolveDefaultSecretsKeyFilePath } from "../home-paths.js";
import { existsSync, readFileSync, statSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { badRequest } from "../errors.js";

export interface EncryptedMaterial {
  iv: string;
  tag: string;
  ciphertext: string;
}

function resolveMasterKeyFilePath(): string {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return resolveDefaultSecretsKeyFilePath();
}

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch { /* */ }
  if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  return null;
}

function loadMasterKey(): Buffer {
  const envKeyRaw = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envKeyRaw && envKeyRaw.trim().length > 0) {
    const decoded = decodeMasterKey(envKeyRaw);
    if (!decoded) throw badRequest("Invalid PAPERCLIP_SECRETS_MASTER_KEY");
    return decoded;
  }
  const keyPath = resolveMasterKeyFilePath();
  if (existsSync(keyPath)) {
    try {
      const mode = statSync(keyPath).mode & 0o777;
      if ((mode & 0o077) !== 0) chmodSync(keyPath, 0o600);
    } catch { /* best effort */ }
    const raw = readFileSync(keyPath, "utf8");
    const decoded = decodeMasterKey(raw);
    if (!decoded) throw badRequest(`Invalid secrets master key at ${keyPath}`);
    return decoded;
  }
  const dir = path.dirname(keyPath);
  mkdirSync(dir, { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  return generated;
}

/** Encrypt a string value. Returns base64-encoded JSON (iv + tag + ciphertext). */
export function encryptValue(value: string): string {
  const masterKey = loadMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const material: EncryptedMaterial = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(material)).toString("base64");
}

/** Decrypt a base64-encoded ciphertext produced by encryptValue(). */
export function decryptValue(encrypted: string): string {
  const masterKey = loadMasterKey();
  let material: EncryptedMaterial;
  try {
    material = JSON.parse(Buffer.from(encrypted, "base64").toString("utf8")) as EncryptedMaterial;
  } catch {
    throw badRequest("Invalid encrypted value format");
  }
  if (!material.iv || !material.tag || !material.ciphertext) {
    throw badRequest("Invalid encrypted value structure");
  }
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}