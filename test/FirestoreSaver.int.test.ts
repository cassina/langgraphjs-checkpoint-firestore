import * as admin from 'firebase-admin';
import {getFirestore} from 'firebase-admin/firestore';
import type { RunnableConfig } from '@langchain/core/runnables';
import {CheckpointTuple} from '@langchain/langgraph-checkpoint';

import { ensureFirestoreEmulator } from './utils/ensureEmulator';
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
const db = getFirestore();
let saver: FirestoreSaver;

async function clearFirestore() {
    const cols = await db.listCollections();
    const batch = db.batch();
    for await (const col of cols) {
        const snap = await col.get();
        for await (const doc of snap.docs) {
            batch.delete(doc.ref);
        }
    }
    await batch.commit();
}
/**
 *
 **/

beforeAll(async () => {
    await ensureFirestoreEmulator();
});

beforeEach(async () => {
    await clearFirestore();
    saver = new FirestoreSaver({ firestore: db });
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

test('write and retrieve pending writes', async () => {
    await saver.put(
        { configurable: { thread_id: mockThreadId } },
        mockCheckpoint,
        mockCheckpointMetadata
    );

    await saver.putWrites(
        { configurable: { thread_id: mockThreadId, checkpoint_ns: '', checkpoint_id: mockCheckpointId } },
        [['chan1', 1], ['chan2', { a: 'b' }]],
        'task1'
    );

    const tuple = await saver.getTuple({ configurable: { thread_id: mockThreadId } });
    expect(tuple?.pendingWrites).toEqual([
        ['task1', 'chan1', 1],
        ['task1', 'chan2', { a: 'b' }],
    ]);
});

test('parent and child checkpoints link correctly', async () => {
    await saver.put({ configurable: { thread_id: mockThreadId } }, mockCheckpoint, mockCheckpointMetadata);
    await saver.put(
        { configurable: { thread_id: mockThreadId, checkpoint_id: mockCheckpointId } },
        mockCheckpoint2,
        mockCheckpointMetadata
    );

    const latest = await saver.getTuple({ configurable: { thread_id: mockThreadId } });
    expect(latest?.parentConfig).toEqual({
        configurable: {
            thread_id: mockThreadId,
            checkpoint_ns: '',
            checkpoint_id: mockCheckpointId,
        }
    });

    const parent = await saver.getTuple({ configurable: { thread_id: mockThreadId, checkpoint_id: mockCheckpointId } });
    expect(parent?.parentConfig).toBeUndefined();
});

test('overwrite checkpoint merges fields', async () => {
    await saver.put({ configurable: { thread_id: mockThreadId } }, mockCheckpoint, mockCheckpointMetadata);
    const docId = `${mockThreadId}__${mockCheckpointId}`;
    await db.collection('checkpoints').doc(docId).set({ extra: 'keep' }, { merge: true });

    const newMeta = { ...mockCheckpointMetadata, step: 99 };
    await saver.put({ configurable: { thread_id: mockThreadId } }, mockCheckpoint, newMeta);

    const snap = await db.collection('checkpoints').doc(docId).get();
    expect(snap.data()?.extra).toBe('keep');

    const tuple = await saver.getTuple({ configurable: { thread_id: mockThreadId } });
    expect(tuple?.metadata?.step).toBe(99);
});

test('list returns checkpoints filtered by namespace', async () => {
    const cpA = { ...mockCheckpoint, id: 'a' };
    const cpB = { ...mockCheckpoint2, id: 'b' };
    const cpC = { ...mockCheckpoint2, id: 'c' };

    await saver.put({ configurable: { thread_id: mockThreadId, checkpoint_ns: 'ns1' } }, cpA, mockCheckpointMetadata);
    await saver.put({ configurable: { thread_id: mockThreadId, checkpoint_ns: 'ns2' } }, cpB, mockCheckpointMetadata);
    await saver.put({ configurable: { thread_id: 'other', checkpoint_ns: 'ns1' } }, cpC, mockCheckpointMetadata);

    const all: CheckpointTuple[] = [];
    for await (const t of saver.list({ configurable: { thread_id: mockThreadId } })) {
        all.push(t);
    }
    expect(all).toHaveLength(2);

    const ns1: CheckpointTuple[] = [];
    for await (const t of saver.list({ configurable: { thread_id: mockThreadId, checkpoint_ns: 'ns1' } })) {
        ns1.push(t);
    }
    expect(ns1).toHaveLength(1);
    expect(ns1[0].config.configurable?.checkpoint_id).toBe('a');
});

test('throws when firestore client terminated', async () => {
    const app2 = admin.initializeApp({}, 'tmp');
    const badDb = app2.firestore();
    const badSaver = new FirestoreSaver({ firestore: badDb });
    await badDb.terminate();

    await expect(
        badSaver.put({ configurable: { thread_id: 't' } }, mockCheckpoint, mockCheckpointMetadata)
    ).rejects.toThrow('Failed to save checkpoint');

    await app2.delete();
});

test('throws on corrupted checkpoint data', async () => {
    await saver.put({ configurable: { thread_id: mockThreadId } }, mockCheckpoint, mockCheckpointMetadata);
    const docId = `${mockThreadId}__${mockCheckpointId}`;
    await db.collection('checkpoints').doc(docId).update({ checkpoint: 'INVALID' });
    await expect(
        saver.getTuple({ configurable: { thread_id: mockThreadId } })
    ).rejects.toThrow();
});
