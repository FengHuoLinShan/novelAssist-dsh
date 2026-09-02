import { Children, isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ActionDockProps } from '../src/client/ActionDock.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: () => null,
  StateDot: () => null,
}))

const { ActionDock } = await import('../src/client/ActionDock.tsx')

const props = {
  t: (key: string) => key,
  session: { blank: true },
} as unknown as ActionDockProps

describe('ActionDock', () => {
  it('shows all author actions only while the session is blank', () => {
    const dock = ActionDock(props)
    expect(isValidElement(dock)).toBe(true)
    expect(Children.count(dock?.props.children)).toBe(8)
    expect(ActionDock({ ...props, session: { ...props.session, blank: false } })).toBeNull()
  })
})
