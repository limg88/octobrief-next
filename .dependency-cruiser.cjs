// Clean architecture boundaries: dependencies point inward only.
//   domain <- application <- (infrastructure | api) <- apps (composition roots)
//   domain <- connectors <- (infrastructure | apps/feeder): read-only adapters to source systems
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
      to: { path: '^(packages/(infrastructure|api|connectors)|apps)/' },
    },
    {
      name: 'connectors-depend-on-domain-only',
      comment: 'connectors read source systems; they know the domain and nothing else of ours.',
      severity: 'error',
      from: { path: '^packages/connectors/src' },
      to: { path: '^(packages/(application|infrastructure|api)|apps)/' },
    },
    {
      name: 'feeder-stays-light',
      comment: 'the feeder runs on a PM computer: no server code, only connectors and the domain.',
      severity: 'error',
      from: { path: '^apps/feeder/src' },
      to: { path: '^(packages/(application|infrastructure|api)|apps/(web|worker))/' },
    },
    {
      name: 'api-does-not-know-infrastructure',
      comment: 'the HTTP interface talks to use cases and ports, never to adapters.',
      severity: 'error',
      from: { path: '^packages/api/src' },
      to: { path: '^(packages/(infrastructure|connectors)|apps)/' },
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
