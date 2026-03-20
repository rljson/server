<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Blog

Add posts as Markdown entries in this file (newest last). Keep each post small and link to source code or PRs when helpful. Template:

```md
## YYYY-MM-DD — Title

- What changed (1–3 bullets)
- Why it matters
- Links: PRs, docs, demos
```

## 2026-03-20 — v0.0.14: Split-brain fix and hub-changed reconnect

- Node class now listens to `hub-changed` events from NetworkManager — clients reconnect when hub changes but role stays `client`
- `_tearDownCurrentRole()` explicitly disconnects sockets before clearing references — prevents orphaned connections
- Validated on 4-node Windows test lab: E2E Reports 18 & 19 both score **38/41 passed, 0 failures**
- Previous Report 17 showed split-brain (two simultaneous hubs, 23/41 passed) — now fully resolved
- PR: https://github.com/rljson/server/pull/14
