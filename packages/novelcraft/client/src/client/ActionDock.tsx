import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcCaller } from './index.ts'
import { BookLibraryAction } from './BookLibraryAction.tsx'
import { MapAtlasAction } from './MapAtlasAction.tsx'
import { ModelPresetsAction } from './ModelPresetsAction.tsx'
import { NS } from './locales.ts'
import { PetAction } from './PetAction.tsx'
import { StoryMapAction } from './StoryMapAction.tsx'
import { WorkflowAction } from './WorkflowAction.tsx'
import { WorldBibleAction } from './WorldBibleAction.tsx'
import { WritingDeskAction } from './WritingDeskAction.tsx'
import css from './novelcraft.module.css'

export type ActionDockProps =
  PropsRuntime<'conversation.input.dock'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

/** Show the existing author actions while the blank-session header is absent. */
export function ActionDock(props: ActionDockProps): JSX.Element | null {
  if (!props.session.blank) return null
  return (
    <nav className={css.actionDock} aria-label={props.t('actions.title')}>
      <BookLibraryAction {...props} />
      <PetAction {...props} />
      <WorkflowAction {...props} />
      <StoryMapAction {...props} />
      <WritingDeskAction {...props} />
      <ModelPresetsAction {...props} />
      <MapAtlasAction {...props} />
      <WorldBibleAction {...props} />
    </nav>
  )
}
