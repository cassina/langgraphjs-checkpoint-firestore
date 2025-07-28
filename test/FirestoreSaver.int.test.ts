import * as admin from 'firebase-admin';
import {getFirestore} from 'firebase-admin/firestore';
import type { RunnableConfig } from '@langchain/core/runnables';
import {CheckpointTuple} from '@langchain/langgraph-checkpoint';

import {ensureFirestoreEmulator} from './utils/ensureEmulator';
import {
    mockCheckpoint,
    mockCheckpoint2,
    mockCheckpointId,
    mockCheckpointMetadata,
    mockThreadId,
} from './utils/int-mocks';

// Import Subject
import { FirestoreSaver } from '../src';

/**
 *
 **/
admin.initializeApp();
let saver: FirestoreSaver;
const db = getFirestore();
/**
 *
 **/

beforeAll(async () => {
    await ensureFirestoreEmulator();

    saver = new FirestoreSaver({ firestore: db });
    const cols = await db.listCollections();

    const batch = db.batch();

    for await (const col of cols) {
        const colSnap = await  col.get();

        for await (const docSnap of colSnap.docs) {
            batch.delete(docSnap.ref);
        }
    }

    await batch.commit();
});

test('put & getTuple round‑trip', async () => {
    const undefined_config: RunnableConfig = { configurable: { thread_id: 'undefined' } };

    const undefined_checkpoint = await saver.getTuple(undefined_config);
    expect(undefined_checkpoint).toBeUndefined();

    // Save first checkpoint
    const firstRunnableConfig: RunnableConfig = await saver.put(
        {
            configurable: {
                thread_id: mockThreadId,
            }
        },
        mockCheckpoint,
        mockCheckpointMetadata
    );
    expect(firstRunnableConfig).toEqual({
        configurable: {
            thread_id: mockThreadId,
            checkpoint_ns: '',
            checkpoint_id: mockCheckpointId,
        }
    });

    // 👀 verify Firestore stored base64 strings
    const rawSnap = await db
        .collection('checkpoints')
        .where('thread_id', '==', mockThreadId)
        .where('checkpoint_id', '==', mockCheckpointId)
        .get();
    expect(rawSnap.docs).toHaveLength(1);
    const rawData = rawSnap.docs[0].data();
    expect(rawData.checkpoint).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(rawData.metadata).toMatch(/^[A-Za-z0-9+/]+=*$/);

    // Add some writes and search the previous saved checkpoint
    await saver.putWrites(
        {
            configurable: {
                checkpoint_id: mockCheckpointId,
                thread_id: mockThreadId,
                checkpoint_ns: '', // Root graph, see: https://github.com/langchain-ai/langgraph/discussions/1326#discussioncomment-10325943
            },
        },
        [['bar', 'baz']],
        'foo'
    );

    // Get first checkpoint tuple
    const firstCheckpointTuple = await saver.getTuple({
        configurable: { thread_id: mockThreadId },
    });

    expect(firstCheckpointTuple?.config).toEqual({
        configurable: {
            thread_id: mockThreadId,
            checkpoint_ns: '',
            checkpoint_id: mockCheckpointId,
        },
    });
    expect(firstCheckpointTuple?.checkpoint).toEqual(mockCheckpoint);
    expect(firstCheckpointTuple?.parentConfig).toBeUndefined();
    expect(firstCheckpointTuple?.pendingWrites).toEqual([
        ['foo', 'bar', 'baz'],
    ]);

    // Persist a 2nd Checkpoint
    await saver.put(
        {
            configurable: {
                thread_id: mockThreadId,
                // The parent checkpoint_id
                checkpoint_id: mockCheckpointId
            }
        },
        mockCheckpoint2,
        mockCheckpointMetadata,
    );

    // Verify that parent is set and retrieved correctly
    const secondCheckpointTuple = await saver.getTuple({
        configurable: { thread_id: mockThreadId },
    });

    expect(secondCheckpointTuple?.parentConfig).toEqual({
        // The parent is checkpoint 1
        configurable: {
            checkpoint_id: mockCheckpointId,
            checkpoint_ns: '',
            thread_id: mockThreadId,
        }
    });

    // Test list should return expected length
    const checkpointTupleGenerator: AsyncGenerator<CheckpointTuple> = saver.list({
        configurable: {
            thread_id: mockThreadId,
        }
    });
    const checkpointTuples: CheckpointTuple[] = [];

    for await (const checkpoint of checkpointTupleGenerator) {
        checkpointTuples.push(checkpoint);
    }

    expect(checkpointTuples.length).toEqual(2);

    // Verify returns ordered by checkpoint_id in desc order
    expect(checkpointTuples[1].checkpoint).toEqual(mockCheckpoint);
    expect(checkpointTuples[0].checkpoint).toEqual(mockCheckpoint2);
});

test.skip('putWrites & pendingWrites show up', async () => null);
