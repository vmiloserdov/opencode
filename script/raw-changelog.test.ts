import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { commits } from "./raw-changelog"



/**
 * commits(from, to) has two dependencies:
 *   1. the GitHub CLI (`gh api .../compare/...`), used to look up each
 *      commit's author username and full message
 *   2. the local git repo (`git log`, `git diff-tree`), used to figure out
 *      which commits touched which package paths
 *
 * Bun's `$` shell tag can't be intercepted with `mock.module("bun", ...)`
 * (it isn't resolved through the normal module registry), so instead of
 * mocking, this test builds a real temporary git repo and shims a fake `gh`
 * executable onto PATH that returns fixed data for the one API call
 * commits() actually makes. 
 * 
 * I have used Claude to write these tests and help me come up with a working mechanism. 
 */

let repoDir: string
let binDir: string
let originalCwd: string
let originalPath: string | undefined

let baseSha = ""
let coreFeatSha = ""
let tuiFixSha = ""
let choreSha = ""
let tempAddSha = ""
let tempRevertSha = ""
let mysterySha = ""

async function commit(message: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(repoDir, file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
    await $`git -C ${repoDir} add ${file}`.quiet()
  }
  await $`git -C ${repoDir} commit -m ${message} --allow-empty`.quiet()
  return (await $`git -C ${repoDir} rev-parse HEAD`.text()).trim()
}

beforeAll(async () => {
  originalCwd = process.cwd()
  originalPath = process.env.PATH

  repoDir = mkdtempSync(path.join(tmpdir(), "raw-changelog-repo-"))
  binDir = mkdtempSync(path.join(tmpdir(), "raw-changelog-bin-"))

  await $`git -C ${repoDir} init -q -b main`
  await $`git -C ${repoDir} config user.email test@example.com`
  await $`git -C ${repoDir} config user.name "Test Bot"`

  // 1. baseline commit -- this is the "from" ref
  baseSha = await commit("chore: init", {
    "packages/opencode/src/init.ts": "// init\n",
  })

  // 2. a feature touching core (packages/opencode/**, outside cli/cmd) -- should appear, Core/Improvements
  coreFeatSha = await commit("feat: add opencode feature", {
    "packages/opencode/src/foo.ts": "export const foo = 1\n",
  })

  // 3. a fix touching the TUI area (packages/opencode/src/cli/cmd/**) -- should appear, TUI/Bugfixes
  tuiFixSha = await commit("fix: tui rendering bug", {
    "packages/opencode/src/cli/cmd/bar.ts": "export const bar = 1\n",
  })

  // 4. a chore -- present in the gh data and touches a tracked path, but must be
  //    filtered out by the `chore:` message-prefix check
  choreSha = await commit("chore: bump deps", {
    "packages/opencode/package.json": "{}\n",
  })

  // 5. a docs commit touching only an untracked path (repo root) -- git log's
  //    pathspec should exclude it entirely, so it never reaches the gh lookup
  await commit("docs: update readme", {
    "README.md": "hello\n",
  })

  // 6/7. a commit and its exact revert (packages/sdk/**) -- both should cancel out
  tempAddSha = await commit("feat: add temp thing", {
    "packages/sdk/temp.ts": "export const temp = 1\n",
  })
  tempRevertSha = await commit('Revert "feat: add temp thing"', {
    "packages/sdk/temp.ts": "// reverted\n",
  })

  // 8. touches a tracked path, but deliberately left OUT of the fake gh response
  //    below -- exercises the `if (!item) continue` branch when a commit hash
  //    from `git log` has no matching entry from the GitHub API
  mysterySha = await commit("feat: mystery commit missing from gh data", {
    "packages/opencode/src/mystery.ts": "export const mystery = 1\n",
  })

  const ghData: Record<string, { login: string | null; message: string }> = {
    [coreFeatSha]: { login: "alice-dev", message: "feat: add opencode feature" },
    [tuiFixSha]: { login: "bob-dev", message: "fix: tui rendering bug" },
    [choreSha]: { login: "carol-dev", message: "chore: bump deps" },
    [tempAddSha]: { login: "erin-dev", message: "feat: add temp thing" },
    [tempRevertSha]: { login: "erin-dev", message: 'Revert "feat: add temp thing"' },
    // mysterySha intentionally omitted
  }

  const jsonl =
    Object.entries(ghData)
      .map(([sha, v]) => JSON.stringify({ sha, login: v.login, message: v.message }))
      .join("\n") + "\n"

  const ghScript = `#!/usr/bin/env bash
cat <<'GHDATA'
${jsonl}GHDATA
`
  writeFileSync(path.join(binDir, "gh"), ghScript)
  chmodSync(path.join(binDir, "gh"), 0o755)

  process.env.PATH = `${binDir}:${originalPath}`
  process.chdir(repoDir)
})

afterAll(() => {
  process.chdir(originalCwd)
  process.env.PATH = originalPath
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
})

describe("commits", () => {
  test("includes commits that touch tracked package paths, with correct hash/author/message", async () => {
    const list = await commits(baseSha, "HEAD")
    const feat = list.find((c) => c.message === "feat: add opencode feature")
    expect(feat).toBeDefined()
    expect(feat!.hash).toBe(coreFeatSha.slice(0, 7))
    expect(feat!.author).toBe("alice-dev")
    expect(feat!.areas).toEqual(new Set(["core"]))
  })

  test("assigns the tui area to files under packages/opencode/src/cli/cmd/", async () => {
    const list = await commits(baseSha, "HEAD")
    const fix = list.find((c) => c.message === "fix: tui rendering bug")
    expect(fix).toBeDefined()
    expect(fix!.author).toBe("bob-dev")
    expect(fix!.areas).toEqual(new Set(["tui"]))
  })

  test("excludes commits whose message starts with an ignored prefix (chore:)", async () => {
    const list = await commits(baseSha, "HEAD")
    expect(list.find((c) => c.message === "chore: bump deps")).toBeUndefined()
  })

  test("excludes commits that never touch a tracked package path", async () => {
    const list = await commits(baseSha, "HEAD")
    expect(list.find((c) => c.message === "docs: update readme")).toBeUndefined()
  })

  test("cancels out a commit and its exact revert", async () => {
    const list = await commits(baseSha, "HEAD")
    expect(list.find((c) => c.message === "feat: add temp thing")).toBeUndefined()
    expect(list.find((c) => c.message.startsWith("Revert "))).toBeUndefined()
  })

  test("skips commits present in git log but missing from the gh API data", async () => {
    const list = await commits(baseSha, "HEAD")
    // check by hash, not message: if the `!item` guard is dropped, the commit
    // still gets added (with an empty message), so a message-based assertion
    // would miss the regression entirely
    expect(list.find((c) => c.hash === mysterySha.slice(0, 7))).toBeUndefined()
  })

  test("returns nothing for an empty range", async () => {
    const list = await commits(baseSha, baseSha)
    expect(list).toEqual([])
  })
})