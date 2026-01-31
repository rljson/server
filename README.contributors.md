<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Contributors Guide

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Everyday development](#everyday-development)
- [Publishing](#publishing)
- [More docs](#more-docs)

## Prerequisites

- Node.js v22.14.0+
- pnpm v10 (see [install-node-mac.md](doc/install-node-mac.md) or [install-node-win.md](doc/install-node-win.md))
- Optional: sibling repos `rljson-io`, `rljson-bs`, `rljson-db`, `rljson` if you prefer linking for local development

## Setup

```sh
pnpm install
```

By default we consume published npm versions. If you want to work against local packages instead, `pnpm link` them in sibling folders and add temporary overrides as needed.

## Everyday development

- Run tests + lint (default CI path):

  ```sh
  pnpm test
  ```

- Lint only:

  ```sh
  pnpm lint
  ```

- Build the package (emits dist, copies README):

  ```sh
  pnpm build
  ```

- Update goldens for snapshot-like tests:

  ```sh
  pnpm updateGoldens
  ```

## Publishing

`pnpm build` runs `pnpm test` via `prebuild`. `pnpm publish` (or npm publish) will trigger `prepublishOnly` and uses the built `dist` folder. Keep the changelog and versioning in sync with repo guidelines.

## More docs

- [doc/prepare.md](doc/prepare.md)
- [doc/develop.md](doc/develop.md)
- [doc/create-new-repo.md](doc/create-new-repo.md)
- [doc/fast-coding-guide.md](doc/fast-coding-guide.md)
