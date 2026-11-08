import { afterEach, describe, expect, it } from "vitest";
import { getPublicBaseUrl } from "../lib/public-url.js";

const KEYS = [
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_RUNTIME_API_URL",
  "PORT",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("getPublicBaseUrl", () => {
  it("prefers the public URL over a loopback API URL", () => {
    setEnv({
      PAPERCLIP_PUBLIC_URL: "https://agentstudio.matilabs.com/",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
    });
    expect(getPublicBaseUrl()).toBe("https://agentstudio.matilabs.com");
  });

  it("uses the auth public base URL when no public URL is set", () => {
    setEnv({
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: "https://agentstudio.matilabs.com",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
    });
    expect(getPublicBaseUrl()).toBe("https://agentstudio.matilabs.com");
  });

  it("prefers the configured API URL over the loopback runtime URL", () => {
    setEnv({
      PAPERCLIP_API_URL: "https://agentstudio.matilabs.com",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
    });
    expect(getPublicBaseUrl()).toBe("https://agentstudio.matilabs.com");
  });

  it("falls back to loopback only when nothing is configured", () => {
    setEnv({ PORT: "3200" });
    expect(getPublicBaseUrl()).toBe("http://127.0.0.1:3200");
  });
});
