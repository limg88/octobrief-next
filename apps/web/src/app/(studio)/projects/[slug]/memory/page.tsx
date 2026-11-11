import { MemoryView } from '@/components/memory/MemoryView'

export default async function MemoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <MemoryView slug={decodeURIComponent(slug)} />
}
