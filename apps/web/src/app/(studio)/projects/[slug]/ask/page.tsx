import { AskView } from '@/components/ask/AskView'

export default async function AskPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <AskView slug={decodeURIComponent(slug)} />
}
