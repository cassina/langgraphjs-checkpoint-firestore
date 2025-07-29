import * as admin from 'firebase-admin';
import {getFirestore} from 'firebase-admin/firestore';
import {ChatOpenAI} from '@langchain/openai';

export const environmentFactory = () => {
    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID,
    });
    const db = getFirestore();
    const model = new ChatOpenAI({ model: 'gpt-4o-mini' });

    return {
        db,
        model,
    }
};
