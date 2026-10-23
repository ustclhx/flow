export interface ManagedBlockInput {
  workspace: { id: string; name: string; kind: 'product' | 'function' }
  projectCardId: string | null
  resources: Array<{ id: string; type: string; title: string; summary: string }>
}

export interface SyncTarget {
  workspaceId: string
  repoPath: string
  input: ManagedBlockInput
}

export type SyncRepositoryResult = {
  workspaceId: string
  repoPath: string
} & (
  | { status: 'updated' | 'unchanged' | 'stale' | 'created' }
  | { status: 'corrupt'; reason: string }
)

export interface SyncReport {
  repositories: SyncRepositoryResult[]
}
