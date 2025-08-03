import * as admin from 'firebase-admin';
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
import {environmentFactory} from './utils/environmentFactory';
import {clearFirestore} from './utils/clearFirestore';

const { db } = environmentFactory();
let saver: FirestoreSaver;

beforeAll(async () => {
    await ensureFirestoreEmulator();
});

beforeEach(async () => {
    await clearFirestore(db);
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
    const colRef = db.collection('checkpoints');
    const q = await colRef.where('thread_id', '==', mockThreadId).get();
    const firstDoc = q.docs[0];
    
    await colRef.doc(firstDoc.id).update({ checkpoint: 'INVALID' });
    
    await expect(
        saver.getTuple({ configurable: { thread_id: mockThreadId } })
    ).rejects.toThrow();
});


test('deleteThread removes all docs for thread', async () => {
    const otherId = 'other-thread';

    // create documents for target thread
    await saver.put({ configurable: { thread_id: mockThreadId } }, mockCheckpoint, mockCheckpointMetadata);
    await saver.putWrites({ configurable: { thread_id: mockThreadId, checkpoint_ns: '', checkpoint_id: mockCheckpointId } }, [['chan', 1]], 'task');

    // docs for another thread should remain untouched
    await saver.put({ configurable: { thread_id: otherId } }, mockCheckpoint2, mockCheckpointMetadata);
    await saver.putWrites({ configurable: { thread_id: otherId, checkpoint_ns: '', checkpoint_id: mockCheckpointId } }, [['chan', 2]], 'task2');

    await saver.deleteThread(mockThreadId);

    const cpSnap = await db.collection('checkpoints').where('thread_id', '==', mockThreadId).get();
    expect(cpSnap.empty).toBe(true);
    const writeSnap = await db.collection('checkpoint_writes').where('thread_id', '==', mockThreadId).get();
    expect(writeSnap.empty).toBe(true);

    const otherCpSnap = await db.collection('checkpoints').where('thread_id', '==', otherId).get();
    expect(otherCpSnap.empty).toBe(false);
    const otherWriteSnap = await db.collection('checkpoint_writes').where('thread_id', '==', otherId).get();
    expect(otherWriteSnap.empty).toBe(false);
});

test('deleteThread is a no-op when no docs exist', async () => {
    await expect(saver.deleteThread('missing-thread')).resolves.toBeUndefined();
});

test('deleteThread handles mixed presence', async () => {
    // only checkpoints
    await saver.put({ configurable: { thread_id: 'only-cp' } }, mockCheckpoint, mockCheckpointMetadata);
    await saver.deleteThread('only-cp');
    const cpSnap = await db.collection('checkpoints').where('thread_id', '==', 'only-cp').get();
    expect(cpSnap.empty).toBe(true);

    // only writes
    await saver.put({ configurable: { thread_id: 'only-writes' } }, mockCheckpoint, mockCheckpointMetadata);
    await saver.putWrites({ configurable: { thread_id: 'only-writes', checkpoint_ns: '', checkpoint_id: mockCheckpointId } }, [['c', 'v']], 't');
    // manually remove checkpoints so only writes remain
    const delSnap = await db.collection('checkpoints').where('thread_id', '==', 'only-writes').get();
    for (const doc of delSnap.docs) {
        await doc.ref.delete();
    }

    await saver.deleteThread('only-writes');
    const writeSnap = await db.collection('checkpoint_writes').where('thread_id', '==', 'only-writes').get();
    expect(writeSnap.empty).toBe(true);
});

test('deleteThread cleans up large numbers of docs', async () => {
    const bigId = 'big-thread';
    const total = 520; // exceed Firestore batch limit
    const BATCH_SIZE = 500;
    const checkpointsRef = db.collection('checkpoints');

    // --- Bulk-insert setup via batched writes ---
    let batch = db.batch();
    for (let i = 0; i < total; i++) {
        // Use a simple doc with just the thread_id field, since deleteThread only cares about that
        const docRef = checkpointsRef.doc(`cp-${i}`);
        batch.set(docRef, { thread_id: bigId });

        // Once we hit 500 ops, commit and start a fresh batch
        if ((i + 1) % BATCH_SIZE === 0) {
            await batch.commit();
            batch = db.batch();
        }
    }
    // Commit any remaining writes (here: the last 20)
    if (total % BATCH_SIZE !== 0) {
        await batch.commit();
    }

    // --- Exercise deleteThread ---
    await saver.deleteThread(bigId);

    // --- Verify all were removed ---
    const snap = await checkpointsRef.where('thread_id', '==', bigId).get();
    expect(snap.empty).toBe(true);
});
