import {Checkpoint, CheckpointMetadata} from '@langchain/langgraph-checkpoint';

export const mockCheckpointId = 'test-1';
export const mockCheckpointId2 = 'test-2';
export const mockThreadId = 'thread-123';

export const mockCheckpointMetadata: CheckpointMetadata = {
    source: 'update',
    step: -1,
    parents: { },
};

export const mockCheckpoint: Checkpoint = {
    v: 1,
    id: mockCheckpointId,
    ts: new Date().toISOString(),
    channel_values: { A: 1, B: 'foo' },
    channel_versions: { A: 1, B: 2 },
    versions_seen: { A: { A1: 1, B2: 2 } },
};

export const mockCheckpoint2: Checkpoint = {
    v: 1,
    id: mockCheckpointId2,
    ts: new Date().toISOString(),
    channel_values: { A: 1, B: 'foo' },
    channel_versions: { A: 1, B: 2 },
    versions_seen: { A: { A1: 1, B2: 2 } },
};
