/*
 * This file is part of midnight-js.
 * Copyright (C) 2025-2026 Midnight Foundation
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0 (the "License");
 * You may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { type ContractEvent } from '@midnight-ntwrk/midnight-js-types';
import { createLogger } from '@midnight-ntwrk/testkit-js';
import path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { VERY_SLOW_TEST_TIMEOUT } from '@/constants';
import * as api from '@/events-api';

import {
  assertBaseEvent,
  createIdMonotonicityCheck,
  deployEventsEnvironment,
  type EventsEnvironment,
  findEvent,
  NAME,
  NAME_HEX,
  PAYLOAD,
  PAYLOAD_HEX,
  teardownEventsEnvironment
} from './utils/events-test-utils';

const logger = createLogger(
  path.resolve(`${process.cwd()}`, 'logs', 'tests', `contracts-events-core_${new Date().toISOString()}.log`)
);

/**
 * MIP-0002 contract events (spec §5.6) — the non-token event families (Misc and the Paused/Unpaused
 * lifecycle pair). Each circuit call lives in its own test (emission outside `beforeAll`) so a single
 * stalled proof fails only that test. Token events live in the sibling shielded/unshielded suites;
 * the provider read surface (query filtering and contractEventsObservable streaming) lives in
 * contracts.events.provider.it.test.ts, and getAllContractEvents pagination stays covered by the
 * provider package's unit suites.
 */
describe('Contract events — core (E2E)', () => {
  let env: EventsEnvironment;
  const checkId = createIdMonotonicityCheck();

  const query = (): Promise<ContractEvent[]> =>
    env.publicDataProvider.queryContractEvents({ contractAddress: env.contractAddress });

  beforeAll(async () => {
    env = await deployEventsEnvironment(logger);
  }, VERY_SLOW_TEST_TIMEOUT);

  afterAll(async () => {
    await teardownEventsEnvironment(env);
  });

  // SKIPPED: proving emitMisc (the heaviest circuit in the suite, ~5x the next-largest zkir) makes
  // the verbose proof server emit ~130MB of logs, which CI's per-line log processing cannot absorb
  // within the 30-minute job timeout — the job is cancelled after the tests have already passed.
  // Needs a proof-server-side fix (Ledger team). The test passes locally and Misc mapping stays
  // covered by the provider package unit suites.
  test.skip('emits a Misc event with the full structure and emitted values', async () => {
    await api.emitMisc(env.deployedContract, NAME, PAYLOAD);
    const event = findEvent(await query(), 'Misc');
    assertBaseEvent(event, env.contractAddress);
    checkId(event);
    if (event.eventType !== 'Misc') throw new Error('unreachable');
    expect(event.name).toBe(NAME_HEX);
    expect(event.payload).toBe(PAYLOAD_HEX);
  });

  test('emits Paused and Unpaused lifecycle events', async () => {
    await api.emitLifecycle(env.deployedContract);
    const events = await query();

    const paused = findEvent(events, 'Paused');
    assertBaseEvent(paused, env.contractAddress);
    checkId(paused);

    const unpaused = findEvent(events, 'Unpaused');
    assertBaseEvent(unpaused, env.contractAddress);
    checkId(unpaused);
  });
});
