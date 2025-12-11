// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { Server } from '../src/server';


describe('Server', () => {
  it('should validate a template', () => {
    const server = Server.example;
    expect(server).toBeDefined();
  });
});
