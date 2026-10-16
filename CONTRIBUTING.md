# Contributing

## Reporting a problem

Open an issue with the **Bug report** or **Feature request** form; blank issues are turned off.
The bug form asks for the awaydesk and Claude Code versions, what you did, what you expected
and what happened. Leave out tokens, real Slack ids, paths from your machine and excerpts of real
sessions. A vulnerability goes to the **Security** tab, never to an issue (see
[SECURITY.md](SECURITY.md)).

## Sending a change

1. Fork, branch, and keep one subject per pull request.
2. Run the checks below; CI runs the same ones.
3. Update the doc a change makes false in the same commit, and add a line under `## Unreleased`
   in [docs/CHANGELOG.md](docs/CHANGELOG.md) for a change in behaviour. `test/docs.test.ts`
   fails on a name a doc cites that the source no longer defines (`sinks.ReplySink`,
   `ThreadSession.mode`), and on a variable, a Slack scope or a word that
   [docs/setup.md](docs/setup.md) does not name.
4. A new `!word` of the daemon is a member of the `Word` union of `src/core/commands.ts` with its
   entry in `WORD`, and needs a line in the `!guide` text (the `GUIDE_` parts of `src/core/texts.ts`, which
   `src/core/guide.ts` assembles) and in `texts.HELP_WORDS`: `test/core/commands.test.ts` fails until both explain it. Change the guide
   whenever a behaviour it describes changes. The word also needs a row in the Commands table of
   [README.md](README.md), which `test/docs.test.ts` checks against `WORD`.
5. The README is the landing page and has a word limit (`README_WORD_LIMIT` in
   `test/docs.test.ts`): describe a feature in [docs/setup.md](docs/setup.md), and change the
   README only when one of its lines stops being true.

## Adding an agent or a chat

An agent and a chat are modules, chosen by name in the configuration ("Modules" in
[docs/architecture.md](docs/architecture.md)). No second real agent or chat ships. The seams were
shaped on the Claude back end, the Slack provider and two test modules, so the first real module
may find a seam that needs a change: open an issue before writing one.

1. Implement the seam: `AgentBackend` and `AgentSession` of `src/agent/seam.ts`, or `ChatProvider`,
   `ThreadChat` and `ChannelChat` of `src/chat/seam.ts`. A chat provider checks that it was the
   owner on every inbound path before it calls `ChatInbound`, and reaches the core through
   `src/core/port.ts` alone. An agent also gives its words (`AgentWords`): what it is called,
   and the names of its own commands that start a new session, log in and log out, which the core
   answers itself. The rules the core relies on beside the types, and which of them a conformance
   check holds, are in [docs/architecture.md](docs/architecture.md), under "What an agent must do
   that the types do not say" and "What a chat must do that the types do not say".
2. Declare the capabilities truthfully (`Capabilities`, `ChatCapabilities`). A capability left
   false means the feature is not offered; the conformance suite checks the declarations it can
   against what the module does (a member present exactly when it is declared, a list that matches
   the capabilities) and runs the checks of a capability only for a module that declares it.
3. Export an entry (`AgentEntry` or `ChatEntry`): the variables the module reads, `required` and
   `optional`, and `build`. `src/agent/claude/module.ts` and `src/chat/slack/module.ts` are the two
   that exist.
4. Run the conformance suite against it. In `test/conformance/agent.test.ts`, call
   `agentConformance` with a harness (`AgentHarness` in `test/conformance/agent.ts`) that creates
   an instance of the agent in a world of its own (`AgentWorld`) and plays it: the suite asks it to
   say a text, call a tool, ask a question, run its effort command or die, and reads the events. In
   `test/conformance/chat.test.ts`, call `chatConformance` with a function (`MakeRig` in
   `test/conformance/chat.ts`) that builds a rig (`ChatRig`): the provider, a channel and a thread,
   the owner and somebody else as people who write and click, whether the chat can show a line to
   the owner alone, and a way to read what the chat shows. A check that needs a capability the module does not declare
   is skipped by name. A session is named by `session_started` only once a start that resumes its
   id would succeed (the core stores the id at once, and the setup's Start resumes it before any
   prompt); the suite checks that for a harness whose world refuses a resume of an id the agent
   has no record of (`AgentHarness.refusesUnrecordedResume`). `node --test
   test/conformance/agent.test.ts` runs one file.
5. Add the entry to `REGISTRY` in `src/registry.ts`.
6. Name its variables in [docs/setup.md](docs/setup.md); `test/docs.test.ts` fails on a variable
   of any entry that the page does not name.

`test/support/plain-agent.ts` and `test/support/memory-chat.ts` are the worked examples: each is
written against its seam and `src/core/port.ts` alone and declares few capabilities, and the
scenario under `test/scenario/` runs the daemon with the two selected by name. The memory chat
shows the part of a chat that the port carries: it keeps the order of its own messages and asks
`tails`, `isLast` and `isOvertaken` which reply shows the list of what still runs and which reply
is last or overtaken. The footer goes under the reply the session names.

Two tests refuse what a module must not do, by layer, so that they hold for a module that is not
there yet. `test/imports.test.ts` fails when the core imports a module, when a module imports
another module (of its layer or the other), when anything but `src/main.ts` imports
`src/registry.ts`, when anything imports `src/main.ts`, when a chat provider imports anything of
the core but its port, when the host layer (`src/host/`) and the three layers import each other,
and when a package is imported by a module that does not list it; it also
fails on an `import()` whose specifier is not a literal and on `createRequire`, which it cannot
read. A new module adds its package to `LIBRARIES` in that test. `test/vocabulary.test.ts` fails on
an identifier or a string outside the module directories under `src/agent/` and `src/chat/` and
`src/registry.ts` that names an agent or a chat: the name of each module directory is one of the
words, read from the disk, so a module's own words stay in its directory and a text of the core
takes the module's name from `AgentBackend.name` or `ChatProvider.name`. A new module adds the
words only it has (its library, what it calls things) to `MODULE_WORDS` in that test.

## Checks

The daemon is TypeScript on Node 22.18 or later, in three layers: `src/agent/` (the Claude back
end), `src/core/` and `src/chat/` (the Slack provider), with `src/registry.ts` and `src/main.ts`
joining them. `test/imports.test.ts` fails when a layer imports what it must not. Run from the
repository root:

```bash
npm ci
npm run check
```

`npm run check` runs Biome (`biome check .`), `tsc --noEmit` and the tests. Node runs the tests
from the sources, with the types stripped, so they need no build; they start no Claude Code process
and open no connection. One file: `node --test test/core/config.test.ts`. `npm run format` applies
Biome's fixes, and `npm run build` compiles `src/` to `dist/`.

Test fixtures are synthetic in content (ids such as `U000ALICE`) and recorded in shape, under
`test/fixtures/`, which `test/support/fixtures.ts` reads. Never write the shape of an SDK message
or a Slack payload by hand.

`test/golden/` holds snapshots: for every recording under `test/fixtures/sdk/`, the calls the
renderer makes on its sink and the Slack calls the reply sink makes for them. Two tests fail when
the code produces anything else. `npm run golden` writes the files again from the code as it is,
so a change to a reply shows as a diff under `test/golden/`: read that diff before committing it,
since the tests pass on whatever was written last.

## SDK releases

awaydesk pins `@anthropic-ai/claude-agent-sdk` to an exact version in `package.json` and runs the
Claude Code CLI that package bundles. The suite replays recorded streams, so it cannot see what a
new Claude Code CLI does differently. The **probe** can. It runs the daemon's own session code
against the real CLI the SDK bundles, with Slack faked, and uses your Claude Code login and Haiku
tokens from your plan, so it runs on your machine and is not part of `npm test`:

```
node probe/main.ts            # the pinned SDK, if it is not certified yet
node probe/main.ts --latest   # the newest release on npm, in a temporary git worktree
node probe/main.ts --force    # run even if already certified
```

`--latest` works on a worktree of `HEAD`, so commit a change to the probe before using it. Each
claim in `probe/claims.ts` ends in one of four outcomes:

| Outcome | Meaning |
|---|---|
| HOLDS | the probe caused the event and the behaviour was there |
| BROKEN | the probe caused the event itself and the behaviour was missing: do not pin the release |
| UNPROVEN | the event did not happen, so nothing was learned |
| RETIRED | Claude Code no longer offers the event |

A **gesture** claim is one the probe causes itself (a prompt, `!stop`, a resume). A **model**
claim needs Claude to act (call Bash, read a file), so when it fails it is UNPROVEN, never
BROKEN: Claude may simply have chosen otherwise. The release is certified, and its version
added to `probe/certified-versions.json`, only when every gesture claim holds or is retired. What
the run could not prove is printed as a checklist of things to try in Slack, followed by the By
hand column of [docs/features.md](docs/features.md), which maps every feature to its tests, its
probe claims and what nothing checks automatically; a new feature or claim adds its row there. A
failure of the machine rather than the SDK (a turn past its time limit, the network) leaves its
claims UNPROVEN. The design follows the upgrade guard of
[seedeep](https://github.com/duqaXxX/seedeep).

`node probe/live-agent.ts` is a second live run, of the Claude back end alone: 23 checks through
`ClaudeBackend` and `ClaudeSession` on Haiku, in fresh temporary folders with none of your
settings loaded, one `PASS` or `FAIL` line each. It spends a few cents of tokens, is not tied to a
release, and exits 1 when a check fails.

Before its scenes, the probe checks
[docs/sdk-surface.md](docs/sdk-surface.md), the table of every type, field,
value, method and option of the SDK the source depends on, against the release it runs on. A row
the package no longer defines is BROKEN and stops the run with exit status 3 before any token is
spent. A row marked `reference` that the published
[reference](https://code.claude.com/docs/en/agent-sdk/typescript) no longer names is UNPROVEN and
is listed to be read by hand. The rows the reference never named and no claim covers are counted;
`node probe/main.ts --surface` lists them and checks the table alone, with no token spent. A
change that reads a new field, key or value of the SDK adds its row there in the same pull
request; `test/agent/claude/sdk-surface.test.ts` fails on an imported SDK name with no row.

The probe also compares the commands a session is offered on the release with the list recorded
in `test/fixtures/sdk/server-info.json`, and prints the ones that are new or gone after the
claims. A new command is typed in Slack as `!name` from the day the release is pinned: try it in
a thread, decide what Slack shows for it, then record the list again. The comparison stops no
certificate. `node probe/main.ts --commands` runs it alone, with no token spent.

One claim sends every command that [docs/limits.md](docs/limits.md) lists as not offered to a
session. A command that no longer answers `isn't available in this environment` makes the claim
BROKEN: the limit is gone, and its row leaves the page before the release is pinned. Another
leaves a command running in the background and reads the turn Claude Code opens by itself when it
ends: it holds while nothing in the stream says what woke that turn. BROKEN there means the release
now sends that text: the row of `docs/limits.md` on such a turn leaves the page, and the thread can
show the text above Claude Code's reply.

The **SDK release watch** workflow (`.github/workflows/sdk-release-watch.yml`) reads, every day,
the latest `@anthropic-ai/claude-agent-sdk` release from the npm registry, runs `npm test` on it,
and keeps one issue labelled `sdk release` and `priority: high` with the versions, the outcome and
the checks left to do by hand (`.github/scripts/watch-sdk-release.sh`,
`.github/scripts/sdk-release-report.mjs`). The body is rewritten on each run; a comment is added
once per new version and whenever the suite does not pass. Close the issue once the release is checked: a closed issue with the same title is not
opened again.

## Releases

awaydesk is published to the npm registry as `awaydesk`, one package for every system, from a git
tag. The version follows semver within 0.x: a release that changes the pin of
`@anthropic-ai/claude-agent-sdk` or adds something the owner can see is a minor (`0.2.0`), a
release of fixes alone a patch (`0.1.1`). The pinned SDK is one the probe certified (see SDK
releases above).

1. A pull request sets `version` in `package.json` and moves what is under `## Unreleased` in
   `docs/CHANGELOG.md` into a section `## [x.y.z] - YYYY-MM-DD`, leaving `## Unreleased` empty
   above it.
2. Once it is merged, tag the merge commit and push the tag:

   ```bash
   git tag v0.2.0 <merge commit>
   git push origin v0.2.0
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) checks that the tag names
   `package.json`'s version and that the changelog has its dated section, which is not empty
   (`.github/scripts/release.mjs`), and that the tagged commit is on `main`. It then runs lint and types on Linux and the tests
   on Linux, macOS and Windows, publishes through npm's trusted publishing, and creates the GitHub
   Release with the version's section as its notes, or a link to that section when it is longer
   than GitHub takes. A version already on the
   registry is not published again, so a re-run only completes what is missing.

The package on npm has a README of its own, `npm/README.md`: short, with absolute links to GitHub
pinned to the version's tag through `{{VERSION}}`. npm always packs the README at the root of the
folder it publishes, so `npm run build:npm` assembles the package in `build/npm/awaydesk`
(`.github/scripts/npm-package.mjs`): the built `dist`, a `package.json` with what an install needs
and no scripts or devDependencies, `LICENSE`, `slack-app-manifest.json`, and that README. That
folder is what is published, by the workflow and by hand.

Trusted publishing has no npm token: npm exchanges the workflow's OIDC token for one publish, and
attaches provenance. It needs a package that already exists on the registry, so the first version
is published by hand, once, by the package's owner with 2FA: `npm run build:npm` then
`npm publish build/npm/awaydesk` from a clean checkout of the merge commit, and only then the
tag, whose workflow finds the version on the registry and creates the GitHub Release. Then, just before the next release (a new trusted publisher must
publish within 2 days), the owner links the package to the workflow, with npm 11.15 or later:

```bash
npm trust github awaydesk --file release.yml --repository duqaXxX/awaydesk --allow-publish
```

and sets "Require two-factor authentication and disallow tokens" in the package's settings on
npmjs.com.

The check that the tagged commit is on `main` catches a tag put on the wrong commit by mistake.
It runs from the workflow file of the tagged commit, so it does not stop someone who can push to
the repository and edits that file in the same commit. The repository's ruleset `release tags`
refuses to delete, move or force-push a tag `v*`, for everyone: a published version's tag never
changes.
