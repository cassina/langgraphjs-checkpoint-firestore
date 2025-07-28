// test/utils/ensureEmulator.ts
import net from 'net';

/**
 * Verifies FIRESTORE_EMULATOR_HOST is set and accepting connections.
 * Exits the process with code 5 if env isn’t set, or code 6 if connect fails.
 */
export function ensureFirestoreEmulator(): Promise<void> {
    const host = process.env.FIRESTORE_EMULATOR_HOST;
    if (!host) {
        console.error(
            'FIRESTORE_EMULATOR_HOST not set — Firestore emulator is required for integration tests.'
        );
        process.exit(5);
    }
    const [hostname, portStr] = host.split(':');
    const port = parseInt(portStr, 10);
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.once('error', (err) => {
            console.error(
                `Could not connect to Firestore emulator at ${host} — is it running?\nError: ${err}`
            );
            process.exit(6);
        });
        sock.once('timeout', () => {
            console.error(
                `Connection to Firestore emulator at ${host} timed out.`
            );
            process.exit(6);
        });
        sock.connect(port, hostname, () => {
            sock.end();
            resolve();
        });
    });
}
