// npm run reset -> wipe data/db.json and invoices, reload demo data from data/seed.json
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { initStore } from '../src/store.js';

fs.rmSync(path.join(config.dataDir, 'invoices'), { recursive: true, force: true });
initStore({ fresh: true });
console.log('Demo data reset from data/seed.json');
