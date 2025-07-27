import 'dotenv/config';                         // loads .env.test
import * as admin from 'firebase-admin';

import { ChatOpenAI } from '@langchain/openai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { FirestoreSaver } from '../src';

// ---------- dummy “weather” tool ----------
const getWeather = tool(
    async (input: { city: 'sf' | 'nyc' }) => {
        return input.city === 'sf'
            ? 'It’s always sunny in SF 😎'
            : 'Could be cloudy in NYC ☁️';
    },
    {
        name: 'get_weather',
        description: 'Use this to get weather information.',
        schema: z.object({ city: z.enum(['sf', 'nyc']) })
    }
);

// ---------- Firestore emulator + saver ----------
admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID  // set in .env.test
});

const checkpointer = new FirestoreSaver({ firestore: admin.firestore() });

// ---------- build the graph ----------
const graph = createReactAgent({
    tools: [getWeather],
    llm: new ChatOpenAI({ model: 'gpt-4o-mini' }), // stub or mock in CI if needed
    checkpointSaver: checkpointer
});

const cfg = { configurable: { thread_id: 'demo-thread' } };

// ---------- the actual test ----------
describe('React‑agent + Firestore checkpoint (E2E)', () => {
    it('runs and stores state', async () => {
        const res = await graph.invoke(
            {
                messages: [
                    { role: 'user', content: 'what’s the weather in sf' }
                ]
            },
            cfg
        );

        // sanity: LLM responded + tool executed
        expect(JSON.stringify(res)).toContain('sunny');

        // checkpoint exists
        const snapshot = await graph.getState(cfg);
        expect(snapshot).toBeDefined();
    });
});
