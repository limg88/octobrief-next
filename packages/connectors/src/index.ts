// The connector port and the safe HTTP client. A connector reads a source system, never writes to
// it, reaches the network only through `createSafeHttp`, and fails with codes only.
export { type AdoConfig, type AdoEndpoint, type AdoHost, adoRules } from './ado/config.ts'
export {
  type AdoConnectorOptions,
  type AdoCursor,
  adoConnector,
  createAdoConnector,
} from './ado/connector.ts'
export { type ConnectorDelivery, toDelivery } from './delivery.ts'
export { type DwsiConfig, parseDwsiConfig, prjOption } from './dwsi/config.ts'
export {
  createDwsiConnector,
  type DwsiConnectorOptions,
  type DwsiCursor,
  dwsiConnector,
  MAX_ROWS_PER_QUERY,
} from './dwsi/connector.ts'
export { DWSI_VIEWS } from './dwsi/views.ts'
export {
  ConnectorError,
  failureReason,
  SYNC_ERROR_CODES,
  type SyncErrorCode,
  TRANSIENT_SYNC_ERRORS,
} from './errors.ts'
export * from './folder/sync-file.ts'
export * from './folder/sync-folder.ts'
export { type JiraConfig, type JiraEndpoint, jiraRules } from './jira/config.ts'
export {
  createJiraConnector,
  type JiraConnectorOptions,
  type JiraCursor,
  jiraConnector,
} from './jira/connector.ts'
export {
  createNetGuard,
  type NetGuard,
  type NetGuardOptions,
  type VettedHost,
} from './net-guard.ts'
export type {
  AnyConnector,
  Connector,
  ConnectorCheck,
  ConnectorContext,
  ConnectorKind,
  ConnectorRegistry,
  Delegation,
  ExternalItem,
  ExternalPerson,
  Json,
  ListedIds,
  PerimeterOption,
  SyncBatch,
  SyncLimits,
  SystemExtraction,
  SystemRow,
} from './port.ts'
export { CONNECTOR_KINDS, MAX_LISTED_IDS, MAX_REMOVED_PER_BATCH } from './port.ts'
export * from './private-hosts.ts'
export * from './reader.ts'
export {
  checkRule,
  type HttpRule,
  type PathPart,
  READ_METHODS,
  type ReadMethod,
  rulesAllow,
} from './rules.ts'
export {
  type BlockedCall,
  type BlockReason,
  createSafeHttp,
  type ResolvedAddress,
  type SafeHttp,
  type SafeHttpOptions,
  type SafeRequest,
  type SafeResponse,
  statusCode,
} from './safe-http.ts'
export { MAX_SECRET_LENGTH, SecretValue } from './secret-value.ts'
