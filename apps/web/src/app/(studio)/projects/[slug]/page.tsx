import { ProjectOverview } from '@/components/projects/ProjectOverview'

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <ProjectOverview slug={decodeURIComponent(slug)} />
}
