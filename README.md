# LangGraphJS Firestore Checkpoint

[![npm version](https://img.shields.io/npm/v/@cassina/langgraphjs-checkpoint-firestore)](https://www.npmjs.com/package/@cassina/langgraphjs-checkpoint-firestore)
[![CI](https://github.com/cassina/langgraphjs-checkpoint-firestore/actions/workflows/ci.yml/badge.svg)](https://github.com/cassina/langgraphjs-checkpoint-firestore/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE.md)

## Introduction

**LangGraphJS Firestore Checkpoint** is a Firestore backed checkpoint saver for [LangGraphJS](https://github.com/langchain-ai/langgraphjs). It allows you to persist and restore LangChain workflow state in Google Firestore, making it easy to resume executions or share state between processes.

## Installation

```bash
npm install @cassina/langgraphjs-checkpoint-firestore
```

## Usage

1. **Initialize Firebase Admin and Firestore**
   ```typescript
   import { initializeApp, cert } from 'firebase-admin/app';
   import { getFirestore } from 'firebase-admin/firestore';
   import { FirestoreSaver } from '@cassina/langgraphjs-checkpoint-firestore';

   initializeApp();

   const firestore = getFirestore();
   const saver = new FirestoreSaver({ firestore });
   ```

2. **Save and retrieve a checkpoint**
   ```typescript
   const config = { configurable: { thread_id: 'my-thread' } };

   // Save workflow state
   await saver.put(config, checkpointData, metadata);

   // Later restore
   const tuple = await saver.getTuple(config);
   if (tuple) {
     console.log('Restored checkpoint', tuple.checkpoint);
   }
   ```

`FirestoreSaver` uses two collections by default: `checkpoints` and `checkpoint_writes`. You can override them:

```typescript
const saver = new FirestoreSaver({
  firestore,
  checkpointCollectionName: 'my_checkpoints',
  checkpointWritesCollectionName: 'my_writes',
});
```

The saver can be plugged directly into a LangGraph/LangChain workflow or used on its own to persist state between runs like so:

```typescript
const workflow = new StateGraph(StateAnnotation)
        .addNode('agent', callModel)
        .addEdge(START, 'agent');

const app = workflow.compile({
   checkpointer: saver,
});
```

- Please see `test/FirestoreSaver.e2e.test.ts` for a full example.

| Method           | Purpose                                                              | Signature(key params only)                                                                               | Return                                                     |
|------------------|----------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|------------------------------------------------------------|
| **constructor**  | Create a saver bound to Firestore collections.                       | `new FirestoreSaver({ firestore, checkpointCollectionName? , checkpointWritesCollectionName? }, serde?)` | `FirestoreSaver`                                           |
| **put**          | Persist a checkpoint and its metadata.                               | `put(config, checkpoint, metadata)`                                                                      | `Promise<RunnableConfig>` (points at the saved checkpoint) |
| **getTuple**     | Fetch the latest (or specific) checkpoint plus its pending writes.   | `getTuple(config)`                                                                                       | `Promise<CheckpointTuple \| undefined>`                    |
| **list**         | Stream checkpoints that match a config, optionally filtered/limited. | `list(config, options?)`                                                                                 | `AsyncGenerator<CheckpointTuple>`                          |
| **putWrites**    | Record pending-write entries for a task.                             | `putWrites(config, writes, taskId)`                                                                      | `Promise<void>`                                            |
| **deleteThread** | Remove every checkpoint and write belonging to a thread.             | `deleteThread(threadId)`                                                                                 | `Promise<void>`                                            |


## License

This project is licensed under the MIT License. See [LICENSE.md](LICENSE.md) for the full text.
