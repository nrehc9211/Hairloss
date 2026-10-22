// Loads settings from a .env file in the project folder, if there is one
// (e.g. GEMINI_API_KEY=...). Real environment variables (like Replit Secrets) win.
try {
  process.loadEnvFile();
} catch {
  // no .env file: that's fine
}
