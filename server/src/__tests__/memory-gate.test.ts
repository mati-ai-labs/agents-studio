import { describe, expect, it } from "vitest";
import { decideMemoryGate, parseMeminfo, RUN_MEMORY_ESTIMATE_MB } from "../services/memory-gate.ts";

describe("parseMeminfo", () => {
  it("reads MemAvailable and MemTotal in MB", () => {
    const text = [
      "MemTotal:        7962240 kB",
      "MemFree:          612000 kB",
      "MemAvailable:    2486272 kB",
      "Buffers:           12345 kB",
    ].join("\n");
    expect(parseMeminfo(text)).toEqual({ availableMb: 2428, totalMb: 7775 });
  });

  it("returns nulls when the fields are missing", () => {
    expect(parseMeminfo("garbage")).toEqual({ availableMb: null, totalMb: null });
  });
});

describe("decideMemoryGate", () => {
  const per = RUN_MEMORY_ESTIMATE_MB;

  it("allows one run per estimate of headroom above the floor", () => {
    expect(decideMemoryGate({ wanted: 5, availableMb: 1536 + per * 3 + 10, minFreeMb: 1536, recentStarts: 0 }))
      .toMatchObject({ allowed: 3, blocked: true });
  });

  it("allows everything when headroom is plentiful", () => {
    expect(decideMemoryGate({ wanted: 2, availableMb: 100_000, minFreeMb: 1536, recentStarts: 0 }))
      .toMatchObject({ allowed: 2, blocked: false });
  });

  it("holds everything below the floor", () => {
    expect(decideMemoryGate({ wanted: 3, availableMb: 1000, minFreeMb: 1536, recentStarts: 0 }))
      .toMatchObject({ allowed: 0, blocked: true });
  });

  it("counts runs that just started but have not grown yet", () => {
    // Room for 3 by MemAvailable, but 2 were started seconds ago.
    expect(decideMemoryGate({ wanted: 3, availableMb: 1536 + per * 3, minFreeMb: 1536, recentStarts: 2 }))
      .toMatchObject({ allowed: 1, blocked: true });
  });

  it("is off when the floor is 0 or memory is unknown", () => {
    expect(decideMemoryGate({ wanted: 4, availableMb: 10, minFreeMb: 0, recentStarts: 0 }))
      .toMatchObject({ allowed: 4, blocked: false });
    expect(decideMemoryGate({ wanted: 4, availableMb: null, minFreeMb: 1536, recentStarts: 0 }))
      .toMatchObject({ allowed: 4, blocked: false });
  });
});
