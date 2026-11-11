import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  addMember,
  createProject,
  getProject,
  listMembers,
  listProjects,
  type ProjectWithRole,
} from '@octobrief/application'
import {
  CLIENT_NAME_MAX_LENGTH,
  MEMBER_ROLES,
  PROJECT_NAME_MAX_LENGTH,
  type Project,
} from '@octobrief/domain'
import type { ApiDependencies } from '../dependencies.ts'
import type { ApiEnv } from '../env.ts'
import { requireSession } from '../middleware/session.ts'
import { ErrorSchema } from './schemas.ts'

const ProjectSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    client: z.string().nullable(),
    createdAt: z.iso.datetime(),
    memberRole: z.enum(MEMBER_ROLES).nullable(),
  })
  .openapi('Project')

const MemberSchema = z
  .object({
    userId: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
    role: z.enum(MEMBER_ROLES),
  })
  .openapi('ProjectMember')

const MembersSchema = z.object({ members: z.array(MemberSchema) }).openapi('ProjectMembers')
const SlugParams = z.object({ slug: z.string().min(1).max(80) })
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const errorResponse = (description: string) => ({ description, content: json(ErrorSchema) })

function toDto(
  project: Project | ProjectWithRole,
  memberRole = 'memberRole' in project ? project.memberRole : null,
) {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    client: project.client,
    createdAt: project.createdAt.toISOString(),
    memberRole,
  }
}

const listRoute = createRoute({
  method: 'get',
  path: '/projects',
  tags: ['projects'],
  summary: 'Projects visible to the signed-in user',
  responses: {
    200: {
      description: 'Projects',
      content: json(z.object({ projects: z.array(ProjectSchema) }).openapi('Projects')),
    },
  },
})

const createProjectRoute = createRoute({
  method: 'post',
  path: '/projects',
  tags: ['projects'],
  summary: 'Create a project owned by the signed-in user',
  request: {
    body: {
      content: json(
        z.object({
          name: z.string().max(PROJECT_NAME_MAX_LENGTH),
          client: z.string().max(CLIENT_NAME_MAX_LENGTH).nullable().optional(),
        }),
      ),
    },
  },
  responses: {
    201: { description: 'Project created', content: json(ProjectSchema) },
    400: errorResponse('Invalid project'),
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}',
  tags: ['projects'],
  summary: 'One project',
  request: { params: SlugParams },
  responses: {
    200: { description: 'Project', content: json(ProjectSchema) },
    404: errorResponse('Not found or not visible'),
  },
})

const membersRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/members',
  tags: ['projects'],
  summary: 'Members of a project',
  request: { params: SlugParams },
  responses: {
    200: { description: 'Members', content: json(MembersSchema) },
    404: errorResponse('Not found or not visible'),
  },
})

const addMemberRoute = createRoute({
  method: 'post',
  path: '/projects/{slug}/members',
  tags: ['projects'],
  summary: 'Add a person who has signed in at least once',
  request: { params: SlugParams, body: { content: json(z.object({ email: z.email() })) } },
  responses: {
    201: { description: 'Updated members', content: json(MembersSchema) },
    403: errorResponse('Only owners and admins'),
    404: errorResponse('Project or person not found'),
    409: errorResponse('Already a member'),
  },
})

export function registerProjectRoutes(app: OpenAPIHono<ApiEnv>, deps: ApiDependencies): void {
  app.use('/projects', requireSession(deps))
  app.use('/projects/*', requireSession(deps))

  app.openapi(listRoute, async (c) => {
    const projects = await listProjects(deps, c.get('session').user)
    return c.json({ projects: projects.map((p) => toDto(p)) }, 200)
  })

  app.openapi(createProjectRoute, async (c) => {
    const project = await createProject(deps, c.get('session').user, c.req.valid('json'))
    return c.json(toDto(project, 'owner'), 201)
  })

  app.openapi(getRoute, async (c) => {
    const project = await getProject(deps, c.get('session').user, c.req.valid('param').slug)
    return c.json(toDto(project), 200)
  })

  app.openapi(membersRoute, async (c) => {
    const members = await listMembers(deps, c.get('session').user, c.req.valid('param').slug)
    return c.json({ members }, 200)
  })

  app.openapi(addMemberRoute, async (c) => {
    const { slug } = c.req.valid('param')
    const members = await addMember(deps, c.get('session').user, slug, c.req.valid('json').email)
    return c.json({ members }, 201)
  })
}
