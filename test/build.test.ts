import {readdir} from 'fs/promises';
import {existsSync} from 'fs';

const expectedFiles = [
    'index.cjs',
    'index.cjs.map',
    'index.d.cts',
    'index.d.ts',
    'index.js',
    'index.js.map'
];

if (!existsSync('./dist')) throw new Error('Directory dist not built – run npm run build first!');

it('should have cjs and esm files', async () => {
    if (!existsSync('./dist')) throw new Error('dist not built – run npm run build first!');

    const distDir = await readdir('./dist', { withFileTypes: true });
    const files = distDir.map(f => f.name);
    expect(new Set(files)).toEqual(new Set(expectedFiles));
});
