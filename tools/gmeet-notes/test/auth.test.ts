import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAuth, resolveDirs, type Dirs } from "../src/config.js";

interface Ctx {
  home: string;
  dirs: Dirs;
}

function tempHome(file?: Record<string, unknown>): Ctx {
  const home = mkdtempSync(join(tmpdir(), "gn-auth-"));
  const dirs = resolveDirs({ MEETNOTES_HOME: home });
  if (file) {
    mkdirSync(dirs.configDir, { recursive: true });
    writeFileSync(join(dirs.configDir, "oauth.json"), JSON.stringify(file));
  }
  return { home, dirs };
}

const FILE = {
  client_id: "file-id",
  client_secret: "file-secret",
  refresh_token: "file-rt",
  email: "file@co.com",
};

test("credential precedence: flags > env > file", () => {
  const { home, dirs } = tempHome(FILE);
  try {
    const env = { GMEET_CLIENT_ID: "env-id" } as NodeJS.ProcessEnv;
    const r = resolveAuth(dirs, { clientId: "flag-id" }, env);
    assert.equal(r.cfg.client_id, "flag-id"); // flag wins
    assert.equal(r.cfg.client_secret, "file-secret"); // no flag/env -> file
    assert.equal(r.cfg.refresh_token, "file-rt");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("env beats file when no flag is given", () => {
  const { home, dirs } = tempHome(FILE);
  try {
    const env = { GMEET_CLIENT_ID: "env-id" } as NodeJS.ProcessEnv;
    const r = resolveAuth(dirs, {}, env);
    assert.equal(r.cfg.client_id, "env-id");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("file-only credentials are persistable (secretsFromFile=true)", () => {
  const { home, dirs } = tempHome(FILE);
  try {
    const r = resolveAuth(dirs, {}, {});
    assert.equal(r.secretsFromFile, true);
    assert.equal(r.cfg.email, "file@co.com");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime-injected refresh creds are stateless (secretsFromFile=false)", () => {
  const { home, dirs } = tempHome(); // no file
  try {
    const env = {
      GMEET_CLIENT_ID: "cid",
      GMEET_CLIENT_SECRET: "csecret",
      GMEET_REFRESH_TOKEN: "rt",
      GMEET_EMAIL: "agent@co.com",
    } as NodeJS.ProcessEnv;
    const r = resolveAuth(dirs, {}, env);
    assert.equal(r.secretsFromFile, false);
    assert.equal(r.cfg.refresh_token, "rt");
    assert.equal(r.cfg.email, "agent@co.com");
    assert.equal(r.cfg.calendar_id, "agent@co.com"); // defaults to email
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("any runtime secret override disables persistence even with a file present", () => {
  const { home, dirs } = tempHome(FILE);
  try {
    const r = resolveAuth(dirs, {}, { GMEET_REFRESH_TOKEN: "injected" } as NodeJS.ProcessEnv);
    assert.equal(r.secretsFromFile, false);
    assert.equal(r.cfg.refresh_token, "injected");
    assert.equal(r.cfg.client_id, "file-id"); // non-secret fields still merge from file
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("access-token-only mode is usable without refresh creds", () => {
  const { home, dirs } = tempHome();
  try {
    const r = resolveAuth(dirs, { accessToken: "ya29.shortlived" }, {});
    assert.equal(r.cfg.access_token, "ya29.shortlived");
    assert.equal(r.cfg.refresh_token, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("throws when no credentials can be assembled", () => {
  const { home, dirs } = tempHome();
  try {
    assert.throws(() => resolveAuth(dirs, {}, {}), /no credentials/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
