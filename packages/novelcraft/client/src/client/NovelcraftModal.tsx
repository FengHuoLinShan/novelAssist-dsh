import { useEffect, useRef, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

interface NovelcraftModalProps {
  open: boolean
  onClose: () => void
  title: string
  closeLabel: string
  className?: string
  contentClassName?: string
  description?: string
  footer?: ReactNode
  children?: ReactNode
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** DSH Modal with the focus entry, trap, and opener return required by author workflows. */
export function NovelcraftModal(props: NovelcraftModalProps): JSX.Element {
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!props.open) {
      const target = opener.current
      opener.current = null
      queueMicrotask(() => {
        if (!target?.isConnected) return
        const details = target.closest('details')
        const hidden = target.closest<HTMLElement>('[hidden]')
        const restore = hidden
          ? hidden.parentElement?.querySelector<HTMLElement>(':scope > button[aria-expanded]')
          : details && !details.open
          ? details.querySelector<HTMLElement>(':scope > summary')
          : target
        restore?.focus()
      })
      return
    }

    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
    const dialog = dialogs.item(dialogs.length - 1)
    if (!dialog) return
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    ;(focusable()[0] ?? dialog).focus()

    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog.addEventListener('keydown', trap)
    return () => dialog.removeEventListener('keydown', trap)
  }, [props.open, props.title])

  return <Modal {...props} />
}
