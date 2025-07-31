import {Annotation, START, StateGraph} from '@langchain/langgraph';
import {BaseMessage, HumanMessage} from '@langchain/core/messages';

import {environmentFactory} from './utils/environmentFactory';

// Import Test Subject
import {FirestoreSaver} from '../src';
// import {clearFirestore} from './utils/clearFirestore';

const { db, model } = environmentFactory();

// Clear DB before each test
// beforeEach(async () => clearFirestore(db));

/**
 * Fetch both the checkpoints and checkpoint_writes snapshots
 * for a given threadId.
 */
async function getThreadDocs(threadId: string): Promise<{
    cpSnap: FirebaseFirestore.QuerySnapshot;
    writesSnap: FirebaseFirestore.QuerySnapshot;
}> {
    const cpSnap = await db
        .collection('checkpoints')
        .where('thread_id', '==', threadId)
        .get();

    const writesSnap = await db
        .collection('checkpoint_writes')
        .where('thread_id', '==', threadId)
        .get();

    return { cpSnap, writesSnap };
}

it('should persist conversation state with FirestoreSaver', async () => {
    // SUB
    const saver = new FirestoreSaver({ firestore: db })
    const threadId = 'demo-thread';

    // Define a new graph
    const StateAnnotation = Annotation.Root({
        sentiment: Annotation<string>,
        messages: Annotation<BaseMessage[]>({
            reducer: (left: BaseMessage[], right: BaseMessage | BaseMessage[]) => {
                if (Array.isArray(right)) {
                    return left.concat(right);
                }
                return left.concat([right]);
            },
            default: () => [],
        }),
    });

    async function callModel(state: typeof StateAnnotation.State) {
        const response = await model.invoke(state.messages);
        // We return an object, because this will get merged with the existing state
        return { messages: [response] };
    }

    const workflow = new StateGraph(StateAnnotation)
        .addNode("agent", callModel)
        .addEdge(START, "agent");

    const app = workflow.compile({
        checkpointer: saver,
    });

    // Send messages
    const cfg = { configurable: { thread_id: threadId } };
    let inputMessage = new HumanMessage("My name is Heisenberg.");
    await app.invoke({ messages: [inputMessage]}, cfg);

    inputMessage = new HumanMessage('What is my name?');
    const response = await app.invoke({ messages: [inputMessage]}, cfg);

    // Assert that the last message should remember the user's name
    expect(response.messages.slice(-1)[0].content).toContain('Heisenberg');

    // Assert that the state should be persisted
    const stateSnap = await app.getState(cfg);
    expect(stateSnap).toBeDefined();

    // Before deletion, we should have at least one doc in each collection
    const { cpSnap: beforeCp, writesSnap: beforeWrites } = await getThreadDocs(threadId);
    expect(beforeCp.empty).toBe(false);
    expect(beforeWrites.empty).toBe(false);

    // Perform the deletion
    await saver.deleteThread(threadId);

    // After deletion, both collections must be empty for this thread
    const { cpSnap: afterCp, writesSnap: afterWrites } = await getThreadDocs(threadId);
    expect(afterCp.empty).toBe(true);
    expect(afterWrites.empty).toBe(true);

}, 15000);
