import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { handoffToAssistant } from '../src/client/assistantHandoff.ts'

describe('assistant handoff', () => {
  it('submits and closes only when the conversation draft is empty', () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    const close = vi.fn()
    expect(handoffToAssistant({ draft: '', prompt: '请继续处理。', setDraft, submit, close })).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('请继续处理。')
    expect(submit).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()

    setDraft.mockClear(); submit.mockClear(); close.mockClear()
    expect(handoffToAssistant({ draft: '我的草稿', prompt: '不应提交', setDraft, submit, close })).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('keeps popup assistant requests free of tool names and JSON parameter syntax', () => {
    const root = resolve(import.meta.dirname, '../src/client')
    const files = [
      'BookLibraryAction.tsx', 'WorkflowAction.tsx', 'StoryMapAction.tsx',
      'WritingDeskAction.tsx', 'MapAtlasAction.tsx', 'WorldBibleAction.tsx',
    ]
    const source = files.map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n')
    expect(source).not.toMatch(/请调用\s+novelcraft_/)
    expect(source).not.toMatch(/(?:source_refs|receipt_id|expected_content_hash)=/)
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(executable).not.toMatch(/[一-鿿]/)
  })

  it('binds inbox actions to the expanded card instead of a shared selected index', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/client/InboxPanel.tsx'), 'utf8')
    expect(source).toContain('handleAct(card, action, reason, modified)')
    expect(source).not.toContain('const card = cards[selected]')
  })
})
