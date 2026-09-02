// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/* v8 ignore file -- @preserve */
// Thin CLI shim (`pnpm start` / `vite-node src/start.ts`). All testable logic
// lives in server-bootstrap.ts; this file only wires env loading + execution.

import { main } from './server-bootstrap.ts';

try {
  process.loadEnvFile();
} catch {
  // No .env file present — fall back to already-exported environment variables.
}

main().catch((err) => {
  console.error('Failed to start rljson server', err);
  process.exitCode = 1;
});
