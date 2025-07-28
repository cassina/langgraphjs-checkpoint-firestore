import {RunnableConfig} from '@langchain/core/runnables';
import type { Firestore, CollectionReference, DocumentData } from '@google-cloud/firestore'
import {Checkpoint, CheckpointMetadata, PendingWrite, SerializerProtocol} from '@langchain/langgraph-checkpoint';

// Import Subject
import { FirestoreSaver } from '../src';

describe('FirestoreSaver Initialization', () => {
    let mockFirestore: jest.Mocked<Firestore>
    let mockCheckpointCollection: jest.Mocked<CollectionReference<DocumentData>>
    let mockWritesCollection: jest.Mocked<CollectionReference<DocumentData>>

    beforeEach(() => {
        mockCheckpointCollection = {} as any
        mockWritesCollection   = {} as any

        mockFirestore = {
            collection: jest
                .fn()
                // first call → checkpointCollection
                .mockReturnValueOnce(mockCheckpointCollection)
                // second call → checkpointWritesCollection
                .mockReturnValueOnce(mockWritesCollection),
        } as unknown as jest.Mocked<Firestore>
    })

    it('should default to "checkpoints" and "checkpoint_writes" collections', () => {
        const saver = new FirestoreSaver({ firestore: mockFirestore })

        expect(mockFirestore.collection).toHaveBeenCalledTimes(2)
        expect(mockFirestore.collection).toHaveBeenNthCalledWith(1, 'checkpoints')
        expect(mockFirestore.collection).toHaveBeenNthCalledWith(2, 'checkpoint_writes')

        // ensure the instance fields are set correctly
        // @ts-expect-error accessing protected for test
        expect(saver.checkpointCollection).toBe(mockCheckpointCollection)
        // @ts-expect-error accessing protected for test
        expect(saver.checkpointWritesCollection).toBe(mockWritesCollection)
    })

    it('should respect custom collection names', () => {
        const saver = new FirestoreSaver({
            firestore: mockFirestore,
            checkpointCollectionName: 'my_cp',
            checkpointWritesCollectionName: 'my_writes',
        })

        expect(mockFirestore.collection).toHaveBeenCalledTimes(2)
        expect(mockFirestore.collection).toHaveBeenNthCalledWith(1, 'my_cp')
        expect(mockFirestore.collection).toHaveBeenNthCalledWith(2, 'my_writes')

        // @ts-expect-error accessing protected for test
        expect(saver.checkpointCollection).toBe(mockCheckpointCollection)
        // @ts-expect-error accessing protected for test
        expect(saver.checkpointWritesCollection).toBe(mockWritesCollection)
    })
});

describe('FirestoreSaver.put()', () => {
    let mockFirestore: jest.Mocked<Firestore>
    let mockCheckpointCollection: jest.Mocked<CollectionReference<DocumentData>>
    let mockWritesCollection: jest.Mocked<CollectionReference<DocumentData>>
    let mockDocRef: { set: jest.Mock }
    let mockSerde: jest.Mocked<SerializerProtocol>
    let saver: FirestoreSaver

    const mockCheckpoint: Checkpoint = {
        v: 1,
        id: 'test-1',
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
        pending_sends: [],
    }
    const mockMetadata: CheckpointMetadata = {
        source: 'input',
        step: 0,
        writes: null,
        parents: {},
    }

    beforeEach(() => {
        mockDocRef = { set: jest.fn() }
        mockCheckpointCollection = ({
            doc: jest.fn().mockReturnValue(mockDocRef),
        } as unknown) as jest.Mocked<CollectionReference<DocumentData>>
        mockWritesCollection = {} as any
        mockFirestore = ({
            collection: jest
                .fn()
                .mockReturnValueOnce(mockCheckpointCollection)
                .mockReturnValueOnce(mockWritesCollection),
        } as unknown) as jest.Mocked<Firestore>

        mockSerde = ({
            dumpsTyped: jest
                .fn()
                .mockReturnValueOnce(['json', Uint8Array.from([1,2,3])])
                .mockReturnValueOnce(['json', Uint8Array.from([4,5,6])]),
            loadsTyped: jest.fn(),
        } as unknown) as jest.Mocked<SerializerProtocol>

        saver = new FirestoreSaver({ firestore: mockFirestore }, mockSerde)
    })

    it('throws if no thread_id', async () => {
        await expect(() =>
            saver.put({ configurable: {} } as RunnableConfig, mockCheckpoint, mockMetadata)
        ).rejects.toThrow('configurable.thread_id')
    })

    it('writes proper doc and returns updated config', async () => {
        const cfg: RunnableConfig = { configurable: { thread_id: 'T1' } }

        const result = await saver.put(cfg, mockCheckpoint, mockMetadata)

        // docId = 'T1__test-1' since checkpoint_ns is ''
        expect(mockCheckpointCollection.doc).toHaveBeenCalledWith('T1__test-1')

        expect(mockDocRef.set).toHaveBeenCalledWith(
            {
                thread_id: 'T1',
                checkpoint_ns: '',
                checkpoint_id: 'test-1',
                parent_checkpoint_id: null,
                type: 'json',
                checkpoint: Buffer.from(Uint8Array.from([1,2,3])).toString('base64'),
                metadata: Buffer.from(Uint8Array.from([4,5,6])).toString('base64'),
            },
            { merge: true }
        )

        expect(result).toEqual({
            configurable: { thread_id: 'T1', checkpoint_ns: '', checkpoint_id: 'test-1' }
        })
    })
});

describe('FirestoreSaver.putWrites()', () => {
    let mockFirestore: jest.Mocked<Firestore>
    let mockWritesCollection: jest.Mocked<CollectionReference<DocumentData>>
    let mockDocRef: { set: jest.Mock }
    let mockBatch: { set: jest.Mock; commit: jest.Mock }
    let mockSerde: jest.Mocked<SerializerProtocol>
    let saver: FirestoreSaver

    beforeEach(() => {
        mockDocRef = { set: jest.fn() }
        mockBatch = { set: jest.fn(), commit: jest.fn() }
        mockWritesCollection = ({
            doc: jest.fn().mockReturnValue(mockDocRef),
        } as unknown) as jest.Mocked<CollectionReference<DocumentData>>

        mockFirestore = ({
            collection: jest.fn()
                // first call for checkpointCollection, unused here
                .mockReturnValueOnce({} as any)
                // second call → writesCollection
                .mockReturnValueOnce(mockWritesCollection),
            batch: jest.fn().mockReturnValue(mockBatch),
        } as unknown) as jest.Mocked<Firestore>

        mockSerde = ({
            dumpsTyped: jest.fn(),
            loadsTyped: jest.fn(),
        } as unknown) as jest.Mocked<SerializerProtocol>

        saver = new FirestoreSaver({ firestore: mockFirestore }, mockSerde)
    })

    it('throws if missing config fields', async () => {
        await expect(
            saver.putWrites({ configurable: {} } as RunnableConfig, [['c','v']], 'task')
        ).rejects.toThrow('Config needs thread_id')
    })

    it('writes correct docs for each write', async () => {
        const cfg = { configurable: { thread_id: 'T1', checkpoint_ns: 'ns', checkpoint_id: 'cp1' } } as RunnableConfig
        const writes: PendingWrite[] = [['chan1', { foo: 'bar' }], ['chan2', 123]]

            // stub dumpsTyped twice
        ;(mockSerde.dumpsTyped as jest.Mock)
            .mockReturnValueOnce(['json', Uint8Array.from([1])])
            .mockReturnValueOnce(['json', Uint8Array.from([2])])

        await saver.putWrites(cfg, writes, 'taskA')

        expect(mockFirestore.batch).toHaveBeenCalledTimes(1)
        expect(mockWritesCollection.doc).toHaveBeenCalledTimes(2)
        expect(mockWritesCollection.doc).toHaveBeenNthCalledWith(1, 'T1_ns_cp1_taskA_0')
        expect(mockWritesCollection.doc).toHaveBeenNthCalledWith(2, 'T1_ns_cp1_taskA_1')

        expect(mockBatch.set).toHaveBeenCalledWith(
            mockDocRef,
            {
                thread_id: 'T1',
                checkpoint_ns: 'ns',
                checkpoint_id: 'cp1',
                task_id: 'taskA',
                idx: 0,
                channel: 'chan1',
                type: 'json',
                value: Buffer.from(Uint8Array.from([1])).toString('base64'),
            },
            { merge: true }
        )

        expect(mockBatch.set).toHaveBeenCalledWith(
            mockDocRef,
            {
                thread_id: 'T1',
                checkpoint_ns: 'ns',
                checkpoint_id: 'cp1',
                task_id: 'taskA',
                idx: 1,
                channel: 'chan2',
                type: 'json',
                value: Buffer.from(Uint8Array.from([2])).toString('base64'),
            },
            { merge: true }
        )

        expect(mockBatch.commit).toHaveBeenCalledTimes(1)
    })
});

describe('FirestoreSaver.getTuple()', () => {
    let mockFirestore: jest.Mocked<Firestore>
    let mockCheckpointCollection: any
    let mockWritesCollection: any
    let mockQuery: any
    let mockSnapshot: any
    let mockWritesSnapshot: any
    let mockDocSnap: any
    let mockSerde: jest.Mocked<SerializerProtocol>
    let saver: FirestoreSaver

    const mockThread = 'T1'
    const mockNs = 'ns'
    const mockCpId = 'cp1'
    const rawCheckpoint = { foo: 'bar' }
    const rawMetadata = { baz: 123 }
    const checkpointB64 = Buffer.from(JSON.stringify(rawCheckpoint)).toString('base64')
    const metadataB64 = Buffer.from(JSON.stringify(rawMetadata)).toString('base64')
    const storedDoc = {
        thread_id: mockThread,
        checkpoint_ns: mockNs,
        checkpoint_id: mockCpId,
        parent_checkpoint_id: undefined,
        type: 'json',
        checkpoint: checkpointB64,
        metadata: metadataB64,
    }

    beforeEach(() => {
        mockDocSnap = { data: () => storedDoc }
        mockSnapshot = { docs: [mockDocSnap], empty: false }
        mockWritesSnapshot = { docs: [], empty: false }

        mockQuery = {
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue(mockSnapshot),
        }
        mockCheckpointCollection = mockQuery
        mockWritesCollection = {
            where: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue(mockWritesSnapshot),
        }

        mockFirestore = {
            collection: jest.fn()
                .mockReturnValueOnce(mockCheckpointCollection)
                .mockReturnValueOnce(mockWritesCollection),
        } as unknown as jest.Mocked<Firestore>

        mockSerde = {
            dumpsTyped: jest.fn(),
            loadsTyped: jest.fn()
                .mockResolvedValueOnce(rawCheckpoint)
                .mockResolvedValueOnce(rawMetadata),
        } as unknown as jest.Mocked<SerializerProtocol>

        saver = new FirestoreSaver({ firestore: mockFirestore }, mockSerde)
    })

    it('returns undefined if thread_id missing', async () => {
        const result = await saver.getTuple({ configurable: {} } as RunnableConfig)
        expect(result).toBeUndefined()
    })

    it('returns undefined if no checkpoints found', async () => {
        mockSnapshot.empty = true
        const result = await saver.getTuple({ configurable: { thread_id: mockThread } } as RunnableConfig)
        expect(result).toBeUndefined()
    })

    it('fetches and deserializes checkpoint, metadata, no writes', async () => {
        const result = await saver.getTuple({ configurable: { thread_id: mockThread, checkpoint_ns: mockNs } } as RunnableConfig)

        expect(mockCheckpointCollection.where).toHaveBeenCalledWith('thread_id', '==', mockThread)
        expect(mockCheckpointCollection.where).toHaveBeenCalledWith('checkpoint_ns', '==', mockNs)
        expect(mockQuery.orderBy).toHaveBeenCalledWith('checkpoint_id', 'desc')
        expect(mockQuery.limit).toHaveBeenCalledWith(1)
        expect(mockSerde.loadsTyped).toHaveBeenNthCalledWith(1, 'json', JSON.stringify(rawCheckpoint))
        expect(mockSerde.loadsTyped).toHaveBeenNthCalledWith(2, 'json', JSON.stringify(rawMetadata))
        expect(result).toMatchObject({
            config: { configurable: { thread_id: mockThread, checkpoint_ns: mockNs, checkpoint_id: mockCpId } },
            checkpoint: rawCheckpoint,
            metadata: rawMetadata,
            pendingWrites: [],
            parentConfig: undefined,
        })
    })
});

describe('FirestoreSaver.list()', () => {
    let mockFirestore: jest.Mocked<Firestore>
    let mockCheckpointCollection: any
    let mockSerde: jest.Mocked<SerializerProtocol>
    let saver: FirestoreSaver

    const raw1 = { foo: 'a' }
    const raw2 = { foo: 'b' }
    const b64_1 = Buffer.from(JSON.stringify(raw1)).toString('base64')
    const b64_2 = Buffer.from(JSON.stringify(raw2)).toString('base64')

    beforeEach(() => {
        // two fake docs
        const docSnap1 = { data: () => ({ thread_id: 'T', checkpoint_ns: '', checkpoint_id: '1', parent_checkpoint_id: undefined, type: 'json', checkpoint: b64_1, metadata: b64_1 }) }
        const docSnap2 = { data: () => ({ thread_id: 'T', checkpoint_ns: '', checkpoint_id: '2', parent_checkpoint_id: '1', type: 'json', checkpoint: b64_2, metadata: b64_2 }) }
        const snap = { docs: [docSnap2, docSnap1] } // simulate descending order

        mockCheckpointCollection = {
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue(snap),
        }
        mockFirestore = {
            collection: jest.fn().mockReturnValue(mockCheckpointCollection),
        } as any
        mockSerde = {
            dumpsTyped: jest.fn(),
            loadsTyped: jest.fn()
                .mockResolvedValueOnce(raw1)
                .mockResolvedValueOnce(raw1)
                .mockResolvedValueOnce(raw2)
                .mockResolvedValueOnce(raw2),
        } as any

        saver = new FirestoreSaver({ firestore: mockFirestore }, mockSerde)
    })

    it('yields checkpoints in descending order', async () => {
        const tuples: any[] = []
        for await (const ct of saver.list({ configurable: { thread_id: 'T' } } as RunnableConfig)) {
            tuples.push(ct)
        }
        expect(mockCheckpointCollection.where).toHaveBeenCalledWith('thread_id', '==', 'T')
        expect(mockCheckpointCollection.orderBy).toHaveBeenCalledWith('checkpoint_id', 'desc')
        expect(mockSerde.loadsTyped).toHaveBeenCalledTimes(4)
        expect(tuples.map(t => t.checkpoint)).toEqual([raw1, raw2])
        // first checkpoint has no parentConfig
        expect(tuples[1].parentConfig).toBeUndefined()
        // second checkpoint's parentConfig points to the first checkpoint
        expect(tuples[0].parentConfig).toEqual({ configurable: { thread_id: 'T', checkpoint_ns: '', checkpoint_id: '1' } })
    })
})

