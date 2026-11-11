import { Suspense } from 'react'
import { ProjectsView } from '@/components/projects/ProjectsView'

export default function HomePage() {
  return (
    <Suspense>
      <ProjectsView />
    </Suspense>
  )
}
