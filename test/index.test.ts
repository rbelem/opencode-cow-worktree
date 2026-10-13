import { expect, test } from "bun:test";

// `src/index.ts` is the package entry point and was never exercised: every
// other test imports a module directly. Importing it here proves the barrel
// resolves and pins the published surface — slimmed to the plugin default on
// the publish-time checklist before the first tarball shipped.
const mod = await import("../src/index");

test("the default export is the plugin with its id and setup", () => {
  expect(mod.default.id).toBe("opencode-cow-worktree");
  expect(typeof mod.default.setup).toBe("function");
});

test("the barrel exports the plugin default and nothing else", () => {
  // A literal keys pin, not a membership check: a future export must land
  // here as a deliberate API decision, never by accumulating silently.
  expect(Object.keys(mod).sort()).toEqual(["default"]);
});
