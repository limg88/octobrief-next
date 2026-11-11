/** Where the bytes of uploaded files live. Keys are opaque to callers. */
export interface BlobStore {
  /** Stores the bytes of a project's file; the same content gets the same key. */
  put(projectId: string, bytes: Uint8Array): Promise<{ key: string; sha256: string }>
  get(key: string): Promise<Uint8Array>
  /** Removes the bytes; a missing key is not an error. */
  delete(key: string): Promise<void>
}
