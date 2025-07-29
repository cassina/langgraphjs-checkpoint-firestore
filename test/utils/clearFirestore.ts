import {Firestore} from '@google-cloud/firestore';

export async function clearFirestore(db: Firestore) {
    const cols = await db.listCollections();
    const batch = db.batch();
    for await (const col of cols) {
        const snap = await col.get();
        for await (const doc of snap.docs) {
            batch.delete(doc.ref);
        }
    }
    await batch.commit();
}
