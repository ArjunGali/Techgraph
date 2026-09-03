import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Every value the server needs from the environment, validated once at boot.
 * A missing or malformed setting fails the process immediately rather than
 * surfacing as a confusing runtime error later.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('12h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  /** Where uploaded proofs and identity documents are written. */
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

  /** Comma-separated origins allowed to call the API. */
  CORS_ORIGINS: z.string().default('*'),

  /** Messaging adapter: `stub` logs locally, real providers send. */
  WHATSAPP_PROVIDER: z.string().default('stub'),
  WHATSAPP_API_URL: z.string().optional(),
  WHATSAPP_API_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),

  /** Set false to run the scheduler out-of-process instead. */
  AUTOMATION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
