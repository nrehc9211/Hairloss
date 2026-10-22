'use strict';
// Load .env with Node's built-in loader (Node 20.12+), no dotenv needed.
try {
  process.loadEnvFile();
} catch {
  // no .env file: fine for keyword-only mode and tests
}
