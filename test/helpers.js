import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data folder + simulator-only mode for every test run
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orderlah-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tmp;
process.env.AI_PROVIDER = 'none';
process.env.WHATSAPP_TOKEN = '';
process.env.BASE_URL = 'http://localhost:3999';
