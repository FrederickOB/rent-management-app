import { fileURLToPath } from 'node:url';
import { createConfig } from '@rent/config/eslint';

export default createConfig({ repoRoot: fileURLToPath(new URL('.', import.meta.url)) });
