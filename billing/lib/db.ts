import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export async function getDb() {
  const dbPath = process.env.DATABASE_PATH || '/var/lib/immutable-health/billing.db';
  
  // Always open a fresh connection (no caching)
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  return db;
}
