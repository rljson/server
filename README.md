<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/server

Local-first, pull-by-reference server layer for Rljson:

- Writes stay local; reads walk priorities (local first, then peers via server proxy)
- References (hashes) are broadcast; data is pulled on-demand through Io/Bs multis
- Server aggregates and multicasts refs without duplicating client data by default

## Users

| File                                 | Purpose                     |
| ------------------------------------ | --------------------------- |
| [README.public.md](README.public.md) | Install and use the package |

## Contributors

| File                                             | Purpose                       |
| ------------------------------------------------ | ----------------------------- |
| [README.contributors.md](README.contributors.md) | Run, debug, build and publish |
| [README.architecture.md](README.architecture.md) | Software architecture guide   |
| [README.trouble.md](README.trouble.md)           | Errors & solutions            |
| [README.blog.md](README.blog.md)                 | Blog                          |
