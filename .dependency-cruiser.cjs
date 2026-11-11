// Clean architecture boundaries: dependencies point inward only.
//   domain <- application <- (infrastructure | api) <- apps (composition roots)
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment: 'domain depends on nothing but itself (no npm packages, no node built-ins).',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { pathNot: '^packages/domain/src' },
    },
    {
      name: 'application-depends-on-domain-only',
      comment: 'application sees domain and zod; never infrastructure, api or apps.',
      severity: 'error',
      from: { path: '^packages/application/src' },
      to: { path: '^(packages/(infrastructure|api)|apps)/' },
    },
    {
      name: 'api-does-not-know-infrastructure',
      comment: 'the HTTP interface talks to use cases and ports, never to adapters.',
      severity: 'error',
      from: { path: '^packages/api/src' },
      to: { path: '^(packages/infrastructure|apps)/' },
    },
    {
      name: 'infrastructure-does-not-know-interfaces',
      severity: 'error',
      from: { path: '^packages/infrastructure/src' },
      to: { path: '^(packages/api|apps)/' },
    },
    {
      name: 'tools-stay-out-of-production',
      comment: 'development tools (fake issuer, generators) are never imported by shipped code.',
      severity: 'error',
      from: { path: '^(packages|apps)/[^/]+/src' },
      to: { path: '^tools/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|\\.next|coverage|/test/)' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'default'],
    },
  },
}
