# Security

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, **Report a
vulnerability**. Do not open a public issue.

## Scope

awaydesk runs Claude Code on the owner's machine on behalf of one Slack user. In scope:

- any path by which someone other than the configured owner, or an event from another workspace,
  reaches a Claude Code session, an approval, or a command;
- output reaching a channel that is public, shared, or has a member other than the owner and the
  bot;
- secrets (`.env` tokens) written anywhere other than the instance's `.env`
  (`~/.config/awaydesk/.env`, or `~/.config/awaydesk-<name>/.env` for a named instance), or
  message content written to a log;
- two instances served by one Slack app, which the daemon refuses at startup;
- an approval request that shows the owner something other than what Approve lets run;
- a session started in a folder the owner has not trusted in Claude Code;
- the daemon's own git (the footer, `!status`, `!open`) run in a repository the owner has not
  trusted in Claude Code.
- a version of the npm package `awaydesk` that the Release workflow
  (`.github/workflows/release.yml`) did not publish from a tag of this repository, apart from the
  first, published by hand (see CONTRIBUTING.md, Releases), or a way to publish one without the
  workflow's own OIDC token.

Out of scope: what Claude Code does once the owner approves it, and whoever controls the owner's
Slack account, who controls the machine by design. [docs/setup.md](docs/setup.md) lists the
settings that protect against that.
