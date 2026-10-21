// @vitest-environment node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { controlUiE2eBuiltModuleRequest } from "../e2e/control-ui-built-module.test-support.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), readdirSync: vi.fn(fs.readdirSync) };
});

describe("built Control UI module requests", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => vi.clearAllMocks());

  function build(maps: Record<string, string[]>) {
    const root = tempDirs.make("control-ui-module-maps-");
    mkdirSync(path.join(root, "assets"));
    for (const [file, sources] of Object.entries(maps)) {
      writeFileSync(path.join(root, "assets", file), JSON.stringify({ sources }));
    }
    return root;
  }

  it("reads each map once across different module lookups in the same build", () => {
    const root = build({
      "shared-[hash].js.map": ["../../ui/src/first.ts", "..\\..\\ui\\src\\second.ts"],
      "other.js.map": ["../../ui/src/other.ts"],
    });
    const first = controlUiE2eBuiltModuleRequest("ui/src/first.ts", root);
    const second = controlUiE2eBuiltModuleRequest("ui\\src\\second.ts", root);

    expect(first.test("https://example.test/assets/shared-[hash].js")).toBe(true);
    expect(second.test("https://example.test/assets/shared-[hash].js?version=1")).toBe(true);
    expect(first.test("https://example.test/assets/shared-h.js")).toBe(false);
    expect(readFileSync).toHaveBeenCalledTimes(2);
    expect(readdirSync).toHaveBeenCalledTimes(1);
  });

  it("keeps the same source isolated between distinct build roots", () => {
    const first = build({ "first.js.map": ["../../ui/src/shared.ts"] });
    const second = build({ "second.js.map": ["../../ui/src/shared.ts"] });

    expect(controlUiE2eBuiltModuleRequest("ui/src/shared.ts", first).source).toContain("first");
    expect(controlUiE2eBuiltModuleRequest("ui/src/shared.ts", second).source).toContain("second");
    expect(controlUiE2eBuiltModuleRequest("ui/src/shared.ts", first).source).toContain("first");
    expect(readFileSync).toHaveBeenCalledTimes(2);
    expect(readdirSync).toHaveBeenCalledTimes(2);
  });

  it("counts matching chunks rather than duplicate source entries and rejects ambiguous lookups", () => {
    const root = build({
      "first.js.map": ["../../ui/src/shared.ts", "../../ui/src/shared.ts"],
      "second.js.map": ["../../ui/src/ambiguous.ts"],
      "third.js.map": ["../../ui/src/ambiguous.ts"],
    });

    expect(controlUiE2eBuiltModuleRequest("ui/src/shared.ts", root).source).toContain("first");
    expect(() => controlUiE2eBuiltModuleRequest("ui/src/missing.ts", root)).toThrow(
      "Expected one built chunk for ui/src/missing.ts, found 0",
    );
    expect(() => controlUiE2eBuiltModuleRequest("ui/src/ambiguous.ts", root)).toThrow(
      "Expected one built chunk for ui/src/ambiguous.ts, found 2",
    );
  });
});
