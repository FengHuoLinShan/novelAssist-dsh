import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
import { BookLibraryAction } from './BookLibraryAction.tsx'
import { MapAtlasAction } from './MapAtlasAction.tsx'
import { ModelPresetsAction } from './ModelPresetsAction.tsx'
import { NS } from './locales.ts'
import { StoryMapAction } from './StoryMapAction.tsx'
import { WorkflowAction } from './WorkflowAction.tsx'
import { WorldBibleAction } from './WorldBibleAction.tsx'
import { WritingDeskAction } from './WritingDeskAction.tsx'
import css from './novelcraft.module.css'

export type ActionLauncherProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

/** Compact navigation for the existing author actions; each action keeps its own workflow modal. */
export function ActionLauncher(props: ActionLauncherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        root.current?.querySelector<HTMLElement>('button[aria-expanded]')?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div ref={root} className={css.actionLauncher}>
      <button type="button" className={css.petTrigger} aria-expanded={open}
        aria-label={props.t('actions.title')} title={props.t('actions.title')}
        onClick={() => setOpen((current) => !current)}>
        <span className={css.petLabel}>{props.t('actions.open')}</span>
        <span className={css.compactLabel} aria-hidden="true">•••</span>
      </button>
      <nav className={css.launcherMenu} aria-label={props.t('actions.title')} hidden={!open}
        onClick={(event) => {
          if ((event.target as Element).closest('button')) {
            setOpen(false)
          }
        }}>
        <BookLibraryAction {...props} />
        <WritingDeskAction {...props} />
        <StoryMapAction {...props} />
        <WorldBibleAction {...props} />
        <MapAtlasAction {...props} />
        <WorkflowAction {...props} />
        <ModelPresetsAction {...props} />
      </nav>
    </div>
  )
}
