import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');

export const pool = new pg.Pool({ connectionString: url });
export const db = drizzle(pool, { schema, casing: 'snake_case' });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
