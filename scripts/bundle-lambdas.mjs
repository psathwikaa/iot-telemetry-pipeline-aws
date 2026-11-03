import * as path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

await build({
  entryPoints: [
    path.join(rootDir, 'src/handlers/ingest-telemetry.ts'),
    path.join(rootDir, 'src/handlers/silence-watchdog.ts'),
    path.join(rootDir, 'src/handlers/alert-processor.ts')
  ],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outdir: path.join(rootDir, 'dist/lambda/handlers'),
  sourcemap: true,
  external: ['@aws-sdk/*'],
  logLevel: 'info'
});
