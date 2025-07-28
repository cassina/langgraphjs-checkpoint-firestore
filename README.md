# LangGraphJS Firestore Checkpoint

[![npm version](https://img.shields.io/npm/v/@cassina/firestore-checkpoint-ts)](https://www.npmjs.com/package/@cassina/firestore-checkpoint-ts)
[![CI](https://github.com/cassina/langgraphjs-checkpoint-firestore/actions/workflows/ci.yml/badge.svg)](https://github.com/cassina/langgraphjs-checkpoint-firestore/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE.md)

## Introduction

**LangGraphJS Firestore Checkpoint** is a Firestore backed checkpoint saver for [LangGraphJS](https://github.com/langchain-ai/langgraphjs). It allows you to persist and restore LangChain workflow state in Google Firestore, making it easy to resume executions or share state between processes.

## Installation

```bash
npm install @cassina/firestore-checkpoint-ts
```

## Usage

1. **Initialize Firebase Admin and Firestore**
   ```typescript
   import { initializeApp, cert } from 'firebase-admin/app';
   import { getFirestore } from 'firebase-admin/firestore';
   import { FirestoreSaver } from '@cassina/firestore-checkpoint-ts';

   initializeApp({
     credential: cert(serviceAccountJson),
   });

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

The saver can be plugged directly into a LangGraph/LangChain workflow or used on its own to persist state between runs.

## API Overview

- **constructor(params, serializer?)** – create a new saver with a Firestore instance and optional collection names.
- **`put(config, checkpoint, metadata)`** – store a checkpoint and metadata. Returns a new runnable config pointing to the saved checkpoint.
- **`getTuple(config)`** – fetch the latest checkpoint for a thread or namespace along with any pending writes.
- **`list(config, options)`** – asynchronously iterate through checkpoints matching the given configuration.
- **`putWrites(config, writes, taskId)`** – record intermediate writes for a task.

## License

This project is licensed under the MIT License. See [LICENSE.md](LICENSE.md) for the full text.
