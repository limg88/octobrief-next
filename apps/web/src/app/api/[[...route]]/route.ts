import { getContainer } from '../../../server/container.ts'

// Every /api request goes to the framework-independent Hono app.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  const { api } = await getContainer()
  return api.fetch(request)
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT }
