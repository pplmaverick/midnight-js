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

import {
  type ContractEvent,
  type ContractEventCursor,
  type ContractEventQueryFilter,
  type FinalizedTxData
} from '@midnight-ntwrk/midnight-js-types';
import { createLogger } from '@midnight-ntwrk/testkit-js';
import path from 'path';
import * as Rx from 'rxjs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { VERY_SLOW_TEST_TIMEOUT } from '@/constants';
import * as api from '@/events-api';

import {
  assertBaseEvent,
  COMMITMENT,
  COMMITMENT_HEX,
  createIdMonotonicityCheck,
  deployEventsEnvironment,
  type EventsEnvironment,
  findEvent,
  NULLIFIER,
  NULLIFIER_HEX,
  teardownEventsEnvironment
} from './utils/events-test-utils';

const logger = createLogger(
  path.resolve(`${process.cwd()}`, 'logs', 'tests', `contracts-events-provider_${new Date().toISOString()}.log`)
);

/**
 * MIP-0002 events via the `PublicDataProvider` read surface: query filtering (spec §3) and
 * subscription streaming (spec §5.6). Both live in one file because CI runs one Docker environment
 * per test file, and these are cheap query/WebSocket tests over a shared corpus — unlike the
 * per-family emission suites, there is no per-test proof worth isolating.
 *
 * The corpus is emitted once in `beforeAll`: two transactions finalized sequentially, so their
 * block heights are strictly increasing (asserted there, since the block-window and toBlock tests
 * depend on it). The filter describe must run before the subscription describe — the live-delivery
 * test appends a ShieldedReceive to the corpus, and the filter tests assert the full corpus.
 */
describe('Contract events — provider read surface (E2E)', () => {
  let env: EventsEnvironment;
  let lifecycleTx: FinalizedTxData;
  let spendTx: FinalizedTxData;

  const query = (filter: Omit<ContractEventQueryFilter, 'contractAddress'> = {}): Promise<ContractEvent[]> =>
    env.publicDataProvider.queryContractEvents({ contractAddress: env.contractAddress, ...filter });

  const eventTypes = (events: ContractEvent[]): string[] => events.map((e) => e.eventType).sort();

  const subscribe = ({ toBlock, startAt }: { toBlock?: number; startAt?: ContractEventCursor } = {}): Rx.Observable<ContractEvent> =>
    env.publicDataProvider.contractEventsObservable(
      { contractAddress: env.contractAddress, ...(toBlock === undefined ? {} : { toBlock }) },
      startAt === undefined ? undefined : { startAt }
    );

  beforeAll(async () => {
    env = await deployEventsEnvironment(logger);
    lifecycleTx = await api.emitLifecycle(env.deployedContract);
    spendTx = await api.emitShieldedSpend(env.deployedContract, NULLIFIER);
    expect(lifecycleTx.blockHeight).toBeGreaterThan(env.deployBlockHeight);
    expect(spendTx.blockHeight).toBeGreaterThan(lifecycleTx.blockHeight);
  }, VERY_SLOW_TEST_TIMEOUT);

  afterAll(async () => {
    await teardownEventsEnvironment(env);
  });

  describe('query filters', () => {
    test('omitted types returns the full corpus', async () => {
      expect(eventTypes(await query())).toEqual(['Paused', 'ShieldedSpend', 'Unpaused']);
    });

    test('a single-type filter returns exactly that type', async () => {
      expect(eventTypes(await query({ types: ['Paused'] }))).toEqual(['Paused']);
    });

    test('a multi-type filter returns exactly the requested types', async () => {
      expect(eventTypes(await query({ types: ['Unpaused', 'ShieldedSpend'] }))).toEqual(['ShieldedSpend', 'Unpaused']);
    });

    test('a matching fieldPrefix returns the event with the full field value', async () => {
      const events = await query({
        types: ['ShieldedSpend'],
        fieldPrefixes: [{ fieldName: 'nullifier', prefix: NULLIFIER_HEX.slice(0, 8) }]
      });
      expect(events).toHaveLength(1);
      const [event] = events;
      if (event.eventType !== 'ShieldedSpend') throw new Error('unreachable');
      expect(event.nullifier).toBe(NULLIFIER_HEX);
    });

    test('a non-matching fieldPrefix returns an empty array, not an error', async () => {
      const events = await query({
        types: ['ShieldedSpend'],
        fieldPrefixes: [{ fieldName: 'nullifier', prefix: 'ff' }]
      });
      expect(events).toEqual([]);
    });

    test('an empty-string prefix matches every event of the filtered type', async () => {
      const events = await query({
        types: ['ShieldedSpend'],
        fieldPrefixes: [{ fieldName: 'nullifier', prefix: '' }]
      });
      expect(eventTypes(events)).toEqual(['ShieldedSpend']);
    });

    test('toBlock before the first emission returns an empty array', async () => {
      expect(await query({ toBlock: env.deployBlockHeight })).toEqual([]);
    });

    test('fromBlock excludes events emitted in earlier blocks', async () => {
      expect(eventTypes(await query({ fromBlock: spendTx.blockHeight }))).toEqual(['ShieldedSpend']);
    });

    test('an inclusive fromBlock/toBlock window returns exactly the events inside it', async () => {
      expect(
        eventTypes(await query({ fromBlock: lifecycleTx.blockHeight, toBlock: lifecycleTx.blockHeight }))
      ).toEqual(['Paused', 'Unpaused']);
    });
  });

  describe('subscription', () => {
    test('replays historical events in emission order', async () => {
      const events = await Rx.firstValueFrom(subscribe().pipe(Rx.take(3), Rx.toArray()));

      expect(events.map((e) => e.eventType)).toEqual(['Paused', 'Unpaused', 'ShieldedSpend']);
      const checkId = createIdMonotonicityCheck();
      for (const event of events) {
        assertBaseEvent(event, env.contractAddress);
        checkId(event);
      }
    });

    test('delivers an event emitted after the subscription opened', async () => {
      const replayed = await query();
      const nextId = replayed[replayed.length - 1].id + 1;
      const pendingEvent = Rx.firstValueFrom(subscribe({ startAt: { fromId: nextId } }));
      // If the emission below fails, the test ends without awaiting pendingEvent; pre-attach a
      // handler so the subscription's eventual teardown error cannot become an unhandled rejection.
      pendingEvent.catch(() => undefined);

      await api.emitShieldedReceive(env.deployedContract, COMMITMENT);

      const event = await pendingEvent;
      assertBaseEvent(event, env.contractAddress);
      if (event.eventType !== 'ShieldedReceive') throw new Error('unreachable');
      expect(event.commitment).toBe(COMMITMENT_HEX);
    });

    test('startAt { fromId } resumes inclusively at that event', async () => {
      const unpaused = findEvent(await query(), 'Unpaused');

      const event = await Rx.firstValueFrom(subscribe({ startAt: { fromId: unpaused.id } }));

      expect(event.id).toBe(unpaused.id);
      expect(event.eventType).toBe('Unpaused');
    });

    test('toBlock bounds the stream and completes it server-side', async () => {
      // The ShieldedSpend from beforeAll sits in a later block, so this asserts both the bound and,
      // via toArray() (which only emits on completion), that the indexer closes the stream.
      const events = await Rx.firstValueFrom(subscribe({ toBlock: lifecycleTx.blockHeight }).pipe(Rx.toArray()));

      expect(events.map((e) => e.eventType)).toEqual(['Paused', 'Unpaused']);
    });
  });
});
