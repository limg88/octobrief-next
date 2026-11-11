import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: [
    '@octobrief/api',
    '@octobrief/application',
    '@octobrief/domain',
    '@octobrief/infrastructure',
  ],
  // Native/driver packages stay on the Node side, unbundled.
  serverExternalPackages: ['pg', 'pg-boss', 'openid-client'],
  poweredByHeader: false,
  agentRules: false,
  // The demo and docs use 127.0.0.1, which Next treats as cross-origin for dev resources.
  allowedDevOrigins: ['127.0.0.1'],
}

export default withNextIntl(nextConfig)
