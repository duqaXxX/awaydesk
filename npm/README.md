# awaydesk

Drive the coding-agent sessions on your own computer from private Slack channels.

Each private channel is one project, bound to a folder on your computer, and each thread in it is
one agent session. awaydesk is a small daemon that runs on that computer and answers one Slack
user: you.

## Install

```sh
npm install -g awaydesk
```

The [setup guide](https://github.com/duqaXxX/awaydesk/blob/v{{VERSION}}/docs/setup.md) says which
systems and agents this version supports, and takes you through the Slack app, the settings, and
the service that starts awaydesk at login:

```sh
awaydesk service install
```

## Update

```sh
npm install -g awaydesk@latest
awaydesk service restart
```

The restart lets running turns finish first.

## More

- Documentation and source: [github.com/duqaXxX/awaydesk](https://github.com/duqaXxX/awaydesk)
- Security model: [SECURITY.md](https://github.com/duqaXxX/awaydesk/blob/v{{VERSION}}/SECURITY.md)
- License: MIT
