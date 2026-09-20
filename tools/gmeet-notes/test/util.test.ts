import assert from "node:assert/strict";
import test from "node:test";
import {
  base64url,
  parseIso,
  pkcePair,
  safeArr,
  safeObj,
  safeStr,
  sanitizeForTerminal,
  sha256Hex,
} from "../src/util.js";

test("sanitizeForTerminal strips ANSI escapes and control chars, keeps text", () => {
  const evil = "\u001b[31mred\u001b[0m\u0007bell\u0000null\nline2\ttab";
  const clean = sanitizeForTerminal(evil);
  assert.ok(!clean.includes("\u001b"));
  assert.ok(!clean.includes("\u0007"));
  assert.ok(!clean.includes("\u0000"));
  assert.ok(clean.includes("red"));
  assert.ok(clean.includes("\n")); // newline preserved
  assert.ok(clean.includes("\t")); // tab preserved
});

test("pkcePair produces url-safe verifier and S256 challenge", () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(verifier, challenge);
});

test("base64url has no padding or unsafe chars", () => {
  const s = base64url(Buffer.from([251, 255, 191, 1, 2, 3]));
  assert.ok(!s.includes("="));
  assert.ok(!s.includes("+"));
  assert.ok(!s.includes("/"));
});

test("sha256Hex is stable", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("parseIso rejects garbage, accepts ISO", () => {
  assert.equal(parseIso("not-a-date"), null);
  assert.equal(parseIso(""), null);
  assert.ok(parseIso("2026-07-21T09:00:00Z") instanceof Date);
});

test("safe* coercions fail closed", () => {
  assert.equal(safeStr(42), undefined);
  assert.equal(safeStr(""), undefined);
  assert.equal(safeStr("ok"), "ok");
  assert.deepEqual(safeArr("nope"), []);
  assert.deepEqual(safeObj([1, 2]), {});
  assert.deepEqual(safeObj(null), {});
});
