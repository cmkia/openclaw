import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { HUMAN_END_MARKER, renderWikiMarkdown } from "./markdown.js";
import { importMemoryWikiOkfBundle } from "./okf.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

it("keeps local marked Notes when their concept disappears from a reimported OKF bundle", async () => {
  const rootDir = await createTempDir("memory-wiki-okf-stale-notes-");
  const bundlePath = path.join(rootDir, "bundle");
  await fs.mkdir(bundlePath);
  for (const name of ["retained", "removed"]) {
    await fs.writeFile(
      path.join(bundlePath, `${name}.md`),
      renderWikiMarkdown({
        frontmatter: { type: "documentation", title: name },
        body: `Producer content for ${name}.`,
      }),
    );
  }
  const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
  const run = () => importMemoryWikiOkfBundle({ config, bundlePath });
  const first = await run();
  expect(first.importedCount).toBe(2);
  const removedPagePath = first.pagePaths.find((pagePath) => pagePath.includes("removed"));
  if (!removedPagePath) {
    throw new Error("Expected the imported concept that will disappear from the bundle");
  }
  const vaultPage = path.join(config.vault.path, removedPagePath);
  const original = await fs.readFile(vaultPage, "utf8");
  const note = "Handwritten context must survive a producer removing this concept.";
  expect(original).toContain(HUMAN_END_MARKER);
  await fs.writeFile(vaultPage, original.replace(HUMAN_END_MARKER, `${note}\n${HUMAN_END_MARKER}`));
  await fs.rm(path.join(bundlePath, "removed.md"));

  const second = await run();

  expect(second.importedCount).toBe(1);
  await expect(fs.readFile(vaultPage, "utf8")).resolves.toContain(note);
  expect(second.removedPagePaths).not.toContain(removedPagePath);
});
