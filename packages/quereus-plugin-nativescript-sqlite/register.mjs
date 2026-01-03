import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Set ts-node configuration via environment variables
process.env.TS_NODE_PROJECT = './packages/quereus-plugin-nativescript-sqlite/tsconfig.test.json';
process.env.TS_NODE_ESM = 'true';

// Register ts-node for ES modules
register('ts-node/esm', pathToFileURL('./'));

