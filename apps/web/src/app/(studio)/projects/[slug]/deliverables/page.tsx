import { DeliverablesView } from '@/components/deliverables/DeliverablesView'

export default async function DeliverablesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <DeliverablesView slug={decodeURIComponent(slug)} />
}
