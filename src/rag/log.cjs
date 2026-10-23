'use strict';
// Every answered question is stored as one JSON line, for the audit trail and the report.

const fs = require('node:fs');
const path = require('node:path');

function appendLog(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

module.exports = { appendLog, readLog };
