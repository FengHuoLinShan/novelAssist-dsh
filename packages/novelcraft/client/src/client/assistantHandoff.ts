/** Submit one user-visible assistant request without overwriting an existing draft. */
export function handoffToAssistant(input: {
  draft: string
  prompt: string
  setDraft: (text: string) => void
  submit: () => void
  close: () => void
}): boolean {
  if (input.draft.trim()) return false
  input.setDraft(input.prompt)
  input.submit()
  input.close()
  return true
}
