// SPDX-License-Identifier: Apache-2.0

const ALL_PROJECTS_DRAFT_SCOPE = '__all__'

export function agentChatNewDraftKey(projectId: string | null | undefined): string {
  return `agent-chat:new:${projectId ?? ALL_PROJECTS_DRAFT_SCOPE}`
}

export function managedSessionDraftKey(sessionId: string): string {
  return `managed-session:${sessionId}`
}

export function issueSessionDraftKey(issueId: string): string {
  return `issue-session:${issueId}`
}
