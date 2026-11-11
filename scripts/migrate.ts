// Owner-side database setup, run by `pnpm db:migrate`; never with the app or worker role.
import { installQueue } from '../packages/infrastructure/src/queue/install-queue.ts'

const ownerUrl = process.env.DATABASE_OWNER_URL
if (!ownerUrl) {
  console.error('DATABASE_OWNER_URL is not set (run pnpm db:setup)')
  process.exit(1)
}

await installQueue(ownerUrl)
console.log('Job queue installed')
