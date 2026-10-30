# CLAUDE.md — @rljson/server

Server layer for the RLJSON ecosystem. Depends on `@rljson/rljson`, `@rljson/io`, `@rljson/bs`, `@rljson/db`, `@rljson/network`.

## Hub announcements (ONE-446)

- **The bootstrap payload carries `p`** (the producer's predecessors) and
  `@rljson/fs-agent`'s anti-entropy decides with it who is behind. Never drop
  or rewrite it: without it a client cannot tell "the hub is ahead" from "the
  hub holds a state I left", and guessing wrong resurrects deleted files.
- **The state beacon is not the heartbeat, and must not become one.** It goes
  on `stateBeaconEvent(route)` = `${route}:state`, which the connector does
  not listen to. Never send it on `events.bootstrap` or `events.ref`: a
  periodic announcement that enters the apply path was measured net-harmful.
- **`stateBeaconEvent` comes from `@rljson/db`**, next to the Connector that
  deliberately ignores it. Never spell the event name out here.

<!-- helix:claude_md:start -->

# gg workflow

This repo is developed ticket by ticket with the `gg` CLI. Follow the
development guide, it tells you when to ask the user and which command
comes next:

@doc/guides/for-ai/ai-dev-guide.md

The steps are also available as skills: `/gg-ticket`, `/gg-commit`,
`/gg-push`, `/gg-review`, `/gg-publish`, `/gg-cleanup`. `/gg` lists them
and says which one comes next.

# rljson additions to the gg workflow

- **Pull requests:** CI on a pull request checks that every commit went
  through gg's local checks (`gg one did commit`). The full tests run on
  `main` after the merge: watch them after every publish.

<!-- helix:claude_md:end -->
