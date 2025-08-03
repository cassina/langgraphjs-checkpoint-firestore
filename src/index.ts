import {
    BaseCheckpointSaver,
    Checkpoint,
    CheckpointListOptions,
    CheckpointTuple,
    SerializerProtocol,
    PendingWrite,
    CheckpointMetadata,
    CheckpointPendingWrite
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Firestore, CollectionReference} from '@google-cloud/firestore';


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
    checkpointCollectionName = 'checkpoints';
    checkpointWritesCollectionName = 'checkpoint_writes';

    constructor(
        {
            firestore,
            checkpointCollectionName,
            checkpointWritesCollectionName
        }: FirestoreSaverParams,
        serde?: SerializerProtocol
    ) {
        super(serde);
        this.firestore = firestore;
        this.checkpointCollectionName =
            checkpointCollectionName ?? this.checkpointCollectionName;
        this.checkpointWritesCollectionName =
            checkpointWritesCollectionName ?? this.checkpointWritesCollectionName;
        this.checkpointCollection = this.firestore.collection(
            this.checkpointCollectionName
        );
        this.checkpointWritesCollection = this.firestore.collection(
            this.checkpointWritesCollectionName
        );
    }

    // PRIVATE: turns object → {typeTag, base64Payload}
    private async serialize(obj: unknown): Promise<{ typeTag: string; payload: string }> {
        const [typeTag, rawBytes] = await this.serde.dumpsTyped(obj);
        const payload = Buffer.from(rawBytes).toString('base64');
        return { typeTag, payload };
    }

    // PRIVATE: turns base64Payload + typeTag → original object
    private async deserialize<T>(payload: string, typeTag: string): Promise<T> {
        const rawBytes = Buffer.from(payload, 'base64');
        // JSON serializer expects a string, so decode bytes → utf8 text
        const text = rawBytes.toString('utf-8');
        return await this.serde.loadsTyped(typeTag, text) as Promise<T>;
    }

    /** Fetch one checkpoint + its pending writes */
    async getTuple(
        runnableConfig: RunnableConfig
    ): Promise<CheckpointTuple | undefined> {
        const { thread_id, checkpoint_ns = '', checkpoint_id } =
        runnableConfig.configurable ?? {};
        if (!thread_id) return undefined;

        let query = this.checkpointCollection
            .where('thread_id', '==', thread_id)
            .where('checkpoint_ns', '==', checkpoint_ns);

        if (checkpoint_id !== undefined) {
            query = query.where('checkpoint_id', '==', checkpoint_id);
        }

        let checkpointsSnap;
        try {
            checkpointsSnap = await query
                .orderBy('checkpoint_id', 'desc')
                .limit(1)
                .get();
        } catch (err) {
            throw new Error('Failed to fetch checkpoint: ' + (err as Error).message);
        }
        if (checkpointsSnap.empty) return undefined;

        const checkpointDocData = checkpointsSnap.docs[0].data();
        const config = {
            configurable: {
                thread_id,
                checkpoint_ns,
                checkpoint_id: checkpointDocData.checkpoint_id,
            }
        };

        // main checkpoint + metadata
        const checkpoint = await this.deserialize<Checkpoint>(
            checkpointDocData.checkpoint as string,
            checkpointDocData.type
        );
        const metadata = await this.deserialize<CheckpointMetadata>(
            checkpointDocData.metadata as string,
            checkpointDocData.type
        );

        // pending writes
        let pendingWritesSnap;
        try {
            pendingWritesSnap = await this.checkpointWritesCollection
                .where('thread_id', '==', thread_id)
                .where('checkpoint_ns', '==', checkpoint_ns)
                .where('checkpoint_id', '==', checkpointDocData.checkpoint_id)
                .get();
        } catch (err) {
            throw new Error('Failed to fetch pending writes: ' + (err as Error).message);
        }

        const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
            pendingWritesSnap.docs.map(async (writeSnap) => {
                const writeData = writeSnap.data();
                const deserializedValue = await this.deserialize(
                    writeData.value as string,
                    writeData.type as string
                );
                return [
                    writeData.task_id,
                    writeData.channel,
                    deserializedValue
                ] as CheckpointPendingWrite;
            })
        );

        const parentConfig = checkpointDocData.parent_checkpoint_id
            ? {
                configurable: {
                    thread_id,
                    checkpoint_ns,
                    checkpoint_id: checkpointDocData.parent_checkpoint_id,
                }
            }
            : undefined;

        return {
            config,
            checkpoint,
            metadata,
            pendingWrites,
            parentConfig,
        };
    }

    /** Stream a bunch of checkpoints */
    async *list(
        config: RunnableConfig,
        options?: CheckpointListOptions
    ): AsyncGenerator<CheckpointTuple> {
        const { limit, before, filter } = options ?? {};
        let query: FirebaseFirestore.Query = this.checkpointCollection;

        if (config.configurable?.thread_id) {
            query = query.where('thread_id', '==', config.configurable.thread_id);
        }
        if (config.configurable?.checkpoint_ns) {
            query = query.where('checkpoint_ns', '==', config.configurable.checkpoint_ns);
        }
        if (filter) {
            for (const [k, v] of Object.entries(filter)) {
                query = query.where(`metadata.${k}`, '==', v);
            }
        }
        if (before?.configurable?.checkpoint_id != null) {
            query = query.where(
                'checkpoint_id',
                '<',
                before.configurable.checkpoint_id
            );
        }

        query = query.orderBy('checkpoint_id', 'desc');
        if (limit != null) query = query.limit(limit);

        let snap;
        try {
            snap = await query.get();
        } catch (err) {
            throw new Error('Failed to list checkpoints: ' + (err as Error).message);
        }
        for (const doc of snap.docs) {
            const docData = doc.data();
            const checkpoint = await this.deserialize<Checkpoint>(
                docData.checkpoint as string,
                docData.type
            );
            const metadata = await this.deserialize<CheckpointMetadata>(
                docData.metadata as string,
                docData.type
            );

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
            };
        }
    }

    /** Save a checkpoint (upsert) */
    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata
    ): Promise<RunnableConfig> {
        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
        const checkpoint_id = checkpoint.id;
        if (!thread_id) {
            throw new Error(
                'Config needs a configurable.thread_id'
            );
        }

        const { typeTag: typeTag, payload: cpPayload } = await this.serialize(checkpoint);
        const { typeTag: metaType, payload: mdPayload } = await this.serialize(metadata);
        if (typeTag !== metaType) {
            throw new Error('Mismatched checkpoint & metadata types');
        }

        const docData = {
            thread_id,
            checkpoint_ns,
            checkpoint_id,
            parent_checkpoint_id: config.configurable?.checkpoint_id ?? null,
            type: typeTag,
            checkpoint: cpPayload,
            metadata: mdPayload
        };
        try {
            await this.checkpointCollection.doc().set(docData, { merge: true });
        } catch (err) {
            throw new Error('Failed to save checkpoint: ' + (err as Error).message);
        }

        return {
            configurable: { thread_id, checkpoint_ns, checkpoint_id }
        };
    }

    /** Save intermediate writes */
    async putWrites(
        config: RunnableConfig,
        writes: PendingWrite[],
        taskId: string
    ): Promise<void> {
        const thread_id = config.configurable?.thread_id;
        const checkpoint_ns = config.configurable?.checkpoint_ns;
        const checkpoint_id = config.configurable?.checkpoint_id;
        if (!thread_id || checkpoint_ns == null || checkpoint_id == null) {
            throw new Error('Config needs thread_id, checkpoint_ns & checkpoint_id');
        }

        const batch = this.firestore.batch();

        for (let idx = 0; idx < writes.length; idx++) {
            const [channel, value] = writes[idx];
            // await the serialize call
            const { typeTag, payload } = await this.serialize(value);

            const ref = this.checkpointWritesCollection.doc();

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
                    value: payload,
                },
                { merge: true }
            );
        }

        try {
            await batch.commit();
        } catch (err) {
            throw new Error('Failed to save writes: ' + (err as Error).message);
        }
    }

    /** Delete all checkpoints and pending writes for a thread */
    async deleteThread(threadId: string): Promise<void> {
        // Fetch and delete all checkpoint docs
        const snap = await this.checkpointCollection
            .where('thread_id', '==', threadId)
            .get();

        if (!snap.empty) {
            const batch = this.firestore.batch();
            snap.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
        }

        // Fetch and delete all pending-write docs
        const writesSnap = await this.checkpointWritesCollection
            .where('thread_id', '==', threadId)
            .get();

        if (!writesSnap.empty) {
            const batch2 = this.firestore.batch();
            writesSnap.docs.forEach(doc => batch2.delete(doc.ref));
            await batch2.commit();
        }
    }

}
