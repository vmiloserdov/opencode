#!/usr/bin/env bun

import { $ } from "bun"
import { parseArgs } from "util"

type Release = {
  tag_name: string
  draft: boolean
}

type Commit = {
  hash: string
  author: string | null
  message: string
  areas: Set<string>
}

type User = Map<string, Set<string>>

// This is the shape returned by the GitHub API
type Diff = {
  sha: string
  login: string | null
  message: string
}

const repo = process.env.GH_REPO ?? "anomalyco/opencode"
const bot = ["actions-user", "github-actions[bot]", "opencode", "opencode-agent[bot]"]
const team = [
  ...(await Bun.file(new URL("../.github/TEAM_MEMBERS", import.meta.url))
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]
const order = ["Core", "TUI", "Desktop", "SDK", "Extensions"] as const
const sections = {
  core: "Core",
  tui: "TUI",
  app: "Desktop",
  tauri: "Desktop",
  sdk: "SDK",
  plugin: "SDK",
  "extensions/vscode": "Extensions",
  github: "Extensions",
} as const

function ref(input: string) {
  if (input === "HEAD") return input
  if (input.startsWith("v")) return input
  if (input.match(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)) return `v${input}`
  return input
}

async function latest() {
  const data = await $`gh api "/repos/${repo}/releases?per_page=100"`.json()
  const release = (data as Release[]).find((item) => !item.draft)
  if (!release) throw new Error("No releases found")
  return release.tag_name.replace(/^v/, "")
}

/**
 * Outputs which commits exist on head that do not exist on base
 * @param base Base ref (could be commit or branch)
 * @param head End ref (could be commit or branch)
 * @returns List of Diff objects (representing commits? )
 */
async function diff(base: string, head: string) {
  const list: Diff[] = []
  // loop forever or until we actually page
  for (let page = 1; ; page++) {
    // get the diff using github api, will be formatted in json
    const text =
      await $`gh api "/repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}" --jq '.commits[] | {sha: .sha, login: .author.login, message: .commit.message}'`.text()

    // convert text to a list of Diff type json objects
    const batch = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Diff)

    // if this is the last page and it's empty, return the list
    if (batch.length === 0) break

    // append every item in batch to the list variable
    list.push(...batch)

    // if there is less than 100 elements, then it is the last page, so break and return list
    if (batch.length < 100) break
  }
  return list
}

function section(areas: Set<string>) {
  const priority = ["core", "tui", "app", "tauri", "sdk", "plugin", "extensions/vscode", "github"]
  for (const area of priority) {
    if (areas.has(area)) return sections[area as keyof typeof sections]
  }
  return "Core"
}

function type(message: string) {
  if (message.match(/fix/i)) return "Bugfixes"
  return "Improvements"
}

function reverted(commits: Commit[]) {
  const seen = new Map<string, Commit>()
  // map of message -> commit containing the message

  for (const commit of commits) {
    const match = commit.message.match(/^Revert "(.+)"$/)
    if (match) {
      const msg = match[1]!

      // if this commit reverts some previous commit, remove that previous commit
      if (seen.has(msg)) seen.delete(msg)

      // else add that commit to the seen map
      else seen.set(commit.message, commit)
      continue
    }

    const revert = `Revert "${commit.message}"`
    if (seen.has(revert)) {
      seen.delete(revert)
      continue
    }

    seen.set(commit.message, commit)
  }

  return [...seen.values()]
}


function find_areas(diff: string){
  const areas = new Set<string>()
  for (const file of diff.split("\n").filter(Boolean)) {
      if (file.startsWith("packages/opencode/src/cli/cmd/")) areas.add("tui")
      else if (file.startsWith("packages/opencode/")) areas.add("core")
      else if (file.startsWith("packages/desktop/src-tauri/")) areas.add("tauri")
      else if (file.startsWith("packages/desktop/") || file.startsWith("packages/app/")) areas.add("app")
      else if (file.startsWith("packages/sdk/") || file.startsWith("packages/plugin/")) areas.add("sdk")
      else if (file.startsWith("sdks/vscode/") || file.startsWith("github/")) areas.add("extensions/vscode")
  }

  return areas;
}


/**
 * Most common use of this is to get all the commits starting from a certain 
 * release (in which case v is appended) to the HEAD, which would be the latest
 * commit on the branch. 
 * 
 * @param from Base ref
 * @param to End ref
 * @returns List of commits
 */
export async function commits(from: string, to: string) {
  // append v or return HEAD
  const base = ref(from)
  const head = ref(to)

  // data: {sha: string -> {login: string, message: string}}
  const data = new Map<string, { login: string | null; message: string }>()

  // for each Diff object in from the base to the head
  for (const item of await diff(base, head)) {
    data.set(item.sha, { login: item.login, message: item.message.split("\n")[0] ?? "" })
  }

  const log =
    await $`git log ${base}..${head} --format=%H -- packages/opencode packages/sdk packages/plugin packages/desktop packages/app sdks/vscode packages/extensions github`.text()
  // log is a string that lists all the commit hashes from base to head


  const list: Commit[] = []

  // for all non-empty and non-chore commit hashes 
  for (const hash of log.split("\n").filter(Boolean)) {
    const item = data.get(hash)
    if (!item) continue
    if (item.message.match(/^(ignore:|test:|chore:|ci:|release:)/i)) continue

    // which files were changed by a specific commit
    const diff = await $`git diff-tree --no-commit-id --name-only -r ${hash}`.text()
    const areas: Set<string> = find_areas(diff)

    // if the commit did not have any changed files then skip the entire for loop
    // although why would it be a commit at all then?
    if (areas.size === 0) continue

    // create a commit-like object; areas - which abstract areas of the codebase were changed
    list.push({
      hash: hash.slice(0, 7),
      author: item.login,
      message: item.message,
      areas,
    })
  }

  // return a clean list excluding 1) commits that were reverted 2) commits that revert those
  return reverted(list)
}

async function contributors(from: string, to: string) {
  const base = ref(from)
  const head = ref(to)

  const users: User = new Map()
  for (const item of await diff(base, head)) {
    const title = item.message.split("\n")[0] ?? ""
    if (!item.login || team.includes(item.login)) continue
    if (title.match(/^(ignore:|test:|chore:|ci:|release:)/i)) continue
    if (!users.has(item.login)) users.set(item.login, new Set())
    users.get(item.login)!.add(title)
  }

  return users
}

async function published(to: string) {
  if (to === "HEAD") return
  const body = await $`gh release view ${ref(to)} --repo ${repo} --json body --jq .body`.text().catch(() => "")
  if (!body) return

  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith("**Thank you to "))
  if (start < 0) return
  return lines.slice(start).join("\n").trim()
}

async function thanks(from: string, to: string, reuse: boolean) {
  const release = reuse ? await published(to) : undefined
  if (release) return release.split(/\r?\n/)

  const users = await contributors(from, to)
  if (users.size === 0) return []

  const lines = [`**Thank you to ${users.size} community contributor${users.size > 1 ? "s" : ""}:**`]
  for (const [name, commits] of users) {
    lines.push(`- @${name}:`)
    for (const commit of commits) lines.push(`  - ${commit}`)
  }
  return lines
}

function format(from: string, to: string, list: Commit[], thanks: string[]) {
  const grouped = new Map<string, Map<string, string[]>>()
  for (const title of order) {
    grouped.set(
      title,
      new Map([
        ["Improvements", []],
        ["Bugfixes", []],
      ]),
    )
  }

  for (const commit of list) {
    const attr = commit.author && !team.includes(commit.author) ? ` (@${commit.author})` : ""
    grouped.get(section(commit.areas))!.get(type(commit.message))!.push(`- \`${commit.hash}\` ${commit.message}${attr}`)
  }

  const lines = [`Last release: ${ref(from)}`, `Target ref: ${to}`, ""]

  if (list.length === 0) {
    lines.push("No notable changes.")
  }

  for (const title of order) {
    const groups = grouped.get(title)
    if (!groups || [...groups.values()].every((entries) => entries.length === 0)) continue
    lines.push(`## ${title}`)
    const improvements = groups.get("Improvements")!
    const bugfixes = groups.get("Bugfixes")!
    if (bugfixes.length === 0) {
      lines.push(...improvements)
      lines.push("")
      continue
    }

    for (const [subtitle, entries] of groups) {
      if (entries.length === 0) continue
      lines.push(`### ${subtitle}`)
      lines.push(...entries)
      lines.push("")
    }
  }

  if (thanks.length > 0) {
    if (lines.at(-1) !== "") lines.push("")
    lines.push("## Community Contributors Input")
    lines.push("")
    lines.push(...thanks)
  }

  if (lines.at(-1) === "") lines.pop()
  return lines.join("\n")
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      from: { type: "string", short: "f" },
      to: { type: "string", short: "t", default: "HEAD" },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  if (values.help) {
    console.log(`
Usage: bun script/raw-changelog.ts [options]

Options:
  -f, --from <version>   Starting version (default: latest non-draft GitHub release)
  -t, --to <ref>         Ending ref (default: HEAD)
  -h, --help             Show this help message

Examples:
  bun script/raw-changelog.ts
  bun script/raw-changelog.ts --from 1.0.200
  bun script/raw-changelog.ts -f 1.0.200 -t 1.0.205
`)
    process.exit(0)
  }

  const to = values.to!
  const from = values.from ?? (await latest())
  const list = await commits(from, to)
  console.log(format(from, to, list, await thanks(from, to, !values.from)))
}
