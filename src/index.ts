import {
    BaseCheckpointSaver,
    Checkpoint,
    CheckpointListOptions,
    CheckpointTuple,
    SerializerProtocol,
    PendingWrite,
    CheckpointMetadata,
    CheckpointPendingWrite
} from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import { Firestore, CollectionReference } from '@google-cloud/firestore'


export type FirestoreSaverParams = {
    firestore: Firestore
    checkpointCollectionName?: string
    checkpointWritesCollectionName?: string
}

/**
 * A LangGraph checkpoint saver backed by Firestore.
 */
export class FirestoreSaver extends BaseCheckpointSaver {
    protected firestore: Firestore;
    protected checkpointCollection: CollectionReference;
    protected checkpointWritesCollection: CollectionReference;
    checkpointCollectionName = 'checkpoints'
    checkpointWritesCollectionName = 'checkpoint_writes';
    private static readonly LIST_PAGE_SIZE = 100;

    constructor(
        {
            firestore,
            checkpointCollectionName,
            checkpointWritesCollectionName
        }: FirestoreSaverParams,
        serde?: SerializerProtocol
    ) {
        super(serde)
        this.firestore = firestore
        this.checkpointCollectionName =
            checkpointCollectionName ?? this.checkpointCollectionName
        this.checkpointWritesCollectionName =
            checkpointWritesCollectionName ?? this.checkpointWritesCollectionName
        this.checkpointCollection = this.firestore.collection(
            this.checkpointCollectionName
        )
        this.checkpointWritesCollection = this.firestore.collection(
            this.checkpointWritesCollectionName
        )
    }

    // PRIVATE: turns object → {typeTag, base64Payload}
    private serialize(obj: unknown): { typeTag: string; payload: string } {
        const [typeTag, rawBytes] = this.serde.dumpsTyped(obj)
        const payload = Buffer.from(rawBytes).toString('base64')
        return { typeTag, payload }
    }

    // PRIVATE: turns base64Payload + typeTag → original object
    private async deserialize<T>(payload: string, typeTag: string): Promise<T> {
        const rawBytes = Buffer.from(payload, 'base64')
        // JSON serializer expects a string, so decode bytes → utf8 text
        const text = rawBytes.toString('utf-8')
        return this.serde.loadsTyped(typeTag, text) as Promise<T>
    }

    /** Fetch one checkpoint + its pending writes */
    async getTuple(
        runnableConfig: RunnableConfig
    ): Promise<CheckpointTuple | undefined> {
        const { thread_id, checkpoint_ns = '', checkpoint_id } =
        runnableConfig.configurable ?? {}
        if (!thread_id) return undefined

        let q = this.checkpointCollection
            .where('thread_id', '==', thread_id)
            .where('checkpoint_ns', '==', checkpoint_ns)

        if (checkpoint_id !== undefined) {
            q = q.where('checkpoint_id', '==', checkpoint_id)
        }

        let checkpointsSnap
        try {
            checkpointsSnap = await q
                .orderBy('checkpoint_id', 'desc')
                .limit(1)
                .get()
        } catch (err) {
            throw new Error(`Failed to fetch checkpoint: ${String(err)}`)
        }
        if (checkpointsSnap.empty) return undefined

        const firstDoc = checkpointsSnap.docs[0].data()
        const config = {
            configurable: {
                thread_id,
                checkpoint_ns,
                checkpoint_id: firstDoc.checkpoint_id,
            }
        }

        // main checkpoint + metadata
        const checkpoint = await this.deserialize<Checkpoint>(
            firstDoc.checkpoint as string,
            firstDoc.type
        )
        const metadata = await this.deserialize<CheckpointMetadata>(
            firstDoc.metadata as string,
            firstDoc.type
        )

        // pending writes
        let pendingWritesSnap
        try {
            pendingWritesSnap = await this.checkpointWritesCollection
                .where('thread_id', '==', thread_id)
                .where('checkpoint_ns', '==', checkpoint_ns)
                .where('checkpoint_id', '==', firstDoc.checkpoint_id)
                .get()
        } catch (err) {
            throw new Error(`Failed to fetch pending writes: ${String(err)}`)
        }

        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
            pendingWritesSnap.docs.map(async (snap) => {
                const w = snap.data()
                const val = await this.deserialize(
                    w.value as string,
                    w.type as string
                )
                return [
                    w.task_id,
                    w.channel,
                    val
                ] as CheckpointPendingWrite
            })
        )

        const parentConfig = firstDoc.parent_checkpoint_id
            ? {
                configurable: {
                    thread_id,
                    checkpoint_ns,
                    checkpoint_id: firstDoc.parent_checkpoint_id,
                }
            }
            : undefined

        return {
            config,
            checkpoint,
            metadata,
            pendingWrites,
            parentConfig,
        }
    }

    /** Stream a bunch of checkpoints */
    async *list(
        config: RunnableConfig,
        options?: CheckpointListOptions
    ): AsyncGenerator<CheckpointTuple> {
        const { limit, before, filter } = options ?? {}
        let q: FirebaseFirestore.Query = this.checkpointCollection

        if (config.configurable?.thread_id) {
            q = q.where('thread_id', '==', config.configurable.thread_id)
        }
        if (config.configurable?.checkpoint_ns) {
            q = q.where('checkpoint_ns', '==', config.configurable.checkpoint_ns)
        }
        if (filter) {
            for (const [k, v] of Object.entries(filter)) {
                q = q.where(`metadata.${k}`, '==', v)
            }
        }
        if (before?.configurable?.checkpoint_id != null) {
            q = q.where(
                'checkpoint_id',
                '<',
                before.configurable.checkpoint_id
            )
        }

        q = q.orderBy('checkpoint_id', 'desc')

        let remaining = limit ?? Infinity
        let nextQuery = q

        while (remaining > 0) {
            const pageSize = Math.min(FirestoreSaver.LIST_PAGE_SIZE, remaining)
            let snap
            try {
                snap = await nextQuery.limit(pageSize).get()
            } catch (err) {
                throw new Error(`Failed to list checkpoints: ${String(err)}`)
            }

            if (snap.empty) break

            for (const doc of snap.docs) {
                const docData = doc.data()
                const checkpoint = await this.deserialize<Checkpoint>(
                    docData.checkpoint as string,
                    docData.type
                )
                const metadata = await this.deserialize<CheckpointMetadata>(
                    docData.metadata as string,
                    docData.type
                )

                yield {
                    config: {
                        configurable: {
                            thread_id: docData.thread_id as string,
                            checkpoint_ns: docData.checkpoint_ns as string,
                            checkpoint_id: docData.checkpoint_id as number
                        }
                    },
                    checkpoint,
                    metadata,
                    parentConfig: docData.parent_checkpoint_id
                        ? {
                            configurable: {
                                thread_id: docData.thread_id as string,
                                checkpoint_ns: docData.checkpoint_ns as string,
                                checkpoint_id: docData.parent_checkpoint_id as number
                            }
                        }
                        : undefined
                }

                remaining--
                if (remaining === 0) return
            }

            if (snap.docs.length < pageSize) break
            nextQuery = q.startAfter(snap.docs[snap.docs.length - 1])
        }
    }

    /** Save a checkpoint (upsert) */
    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata
    ): Promise<RunnableConfig> {
        const thread_id = config.configurable?.thread_id
        const checkpoint_ns = config.configurable?.checkpoint_ns ?? ''
        const checkpoint_id = checkpoint.id
        if (!thread_id) {
            throw new Error(
                'Config needs a configurable.thread_id'
            )
        }

        const { typeTag: typeTag, payload: cpPayload } = this.serialize(checkpoint)
        const { typeTag: metaType, payload: mdPayload } = this.serialize(metadata)
        if (typeTag !== metaType) {
            throw new Error('Mismatched checkpoint & metadata types')
        }

        const docId = `${thread_id}_${checkpoint_ns}_${checkpoint_id}`
        const docData = {
                thread_id,
                checkpoint_ns,
                checkpoint_id,
                parent_checkpoint_id:
                    config.configurable?.checkpoint_id ?? null,
                type: typeTag,
                checkpoint: cpPayload,
                metadata: mdPayload
        };
        try {
            await this.checkpointCollection.doc(docId).set(
                docData,
                { merge: true }
            )
        } catch (err) {
            throw new Error(`Failed to write checkpoint: ${String(err)}`)
        }

        return {
            configurable: { thread_id, checkpoint_ns, checkpoint_id }
        }
    }

    /** Save intermediate writes */
    async putWrites(
        config: RunnableConfig,
        writes: PendingWrite[],
        taskId: string
    ): Promise<void> {
        const thread_id = config.configurable?.thread_id
        const checkpoint_ns = config.configurable?.checkpoint_ns
        const checkpoint_id = config.configurable?.checkpoint_id
        if (!thread_id || checkpoint_ns == null || checkpoint_id == null) {
            throw new Error('Config needs thread_id, checkpoint_ns & checkpoint_id')
        }

        const batch = this.firestore.batch()
        writes.forEach(([channel, value], idx) => {
            const { typeTag, payload } = this.serialize(value)
            const docId = `${thread_id}_${checkpoint_ns}_${checkpoint_id}_${taskId}_${idx}`
            const ref = this.checkpointWritesCollection.doc(docId)
            batch.set(
                ref,
                {
                    thread_id,
                    checkpoint_ns,
                    checkpoint_id,
                    task_id: taskId,
                    idx,
                    channel,
                    type: typeTag,
                    value: payload
                },
                { merge: true }
            )
        })

        try {
            if (writes.length > 0) {
                await batch.commit()
            }
        } catch (err) {
            throw new Error(`Failed to write checkpoint writes: ${String(err)}`)
        }
    }
}
