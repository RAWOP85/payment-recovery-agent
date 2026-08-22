const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_PATH = path.join(__dirname, '..', 'data', 'audit-log.jsonl');

function startLog(filePath = DEFAULT_LOG_PATH) {
  fs.writeFileSync(filePath, '');
}

function appendEntry(entry, filePath = DEFAULT_LOG_PATH) {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

function readEntries(filePath = DEFAULT_LOG_PATH) {
  const contents = fs.readFileSync(filePath, 'utf8');
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

module.exports = { startLog, appendEntry, readEntries, DEFAULT_LOG_PATH };
