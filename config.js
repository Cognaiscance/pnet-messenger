import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UUID_FILE       = join(__dirname, '.app_uuid');
const API_KEY_FILE    = join(__dirname, '.app_api_key');
const PNET_KEY_FILE   = join(__dirname, '.pnet_api_key');

function readOrCreate(file) {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const val = randomUUID();
  writeFileSync(file, val, 'utf8');
  return val;
}

function readOptional(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

function saveFile(file, value) {
  writeFileSync(file, value, 'utf8');
}

export default {
  PNET_URL:      process.env.PNET_URL  || 'http://localhost:3000',
  APP_PORT:      parseInt(process.env.APP_PORT || '4000', 10),
  APP_HOST:      process.env.APP_HOST  || 'localhost:4000',
  APP_UUID:      readOrCreate(UUID_FILE),
  APP_NAME:      'pnet-messenger',
  // Stable key persisted to disk so pnet can still reach us after restarts
  APP_API_KEY:   readOrCreate(API_KEY_FILE),
  // pnet's api key for us — persisted so it survives server restarts
  PNET_API_KEY:  readOptional(PNET_KEY_FILE),
  PNET_KEY_FILE,
  saveFile,
};
