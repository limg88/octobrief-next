// Owner-side database setup, run by `pnpm db:migrate`; never with the app or worker role.
// Migrations are imported by path: they are not part of the bundled runtime API.

import { runMigrations } from '../packages/infrastructure/src/postgres/migrations.ts'
import { installQueue } from '../packages/infrastructure/src/queue/install-queue.ts'

const ownerUrl = process.env.DATABASE_OWNER_URL
if (!ownerUrl) {
  console.error('DATABASE_OWNER_URL is not set (run pnpm db:setup)')
  process.exit(1)
}

await installQueue(ownerUrl)
console.log('Job queue installed')
const applied = await runMigrations(ownerUrl)
console.log(applied.length > 0 ? `Migrations applied: ${applied.join(', ')}` : 'Schema up to date')
