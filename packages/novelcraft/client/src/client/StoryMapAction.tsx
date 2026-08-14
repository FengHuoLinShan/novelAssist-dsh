// 剧情地图(StoryMapAction): 会话头动作, 打开剧情地图 Modal(结构资产 + Scene/章节覆盖)。
// 数据源 = /novelcraft story/map(宿主读 store.storyMap, 文件真相)。纯读, 无动作。
import { useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { useStoryMap } from './useWatch.ts'
import css from './novelcraft.module.css'

export type StoryMapActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

function Section(props: { title: string; lines: string[] }): JSX.Element {
  if (props.lines.length === 0) return <></>
  return (
    <>
      <div className={css.sectionTitle}>{props.title}</div>
      {props.lines.map((line, i) => <div key={i} className={css.itemLine}>{line}</div>)}
    </>
  )
}

export function StoryMapAction(props: StoryMapActionProps): JSX.Element {
  const { t, connection, sessionId } = props
  const [open, setOpen] = useState(false)
  const { data } = useStoryMap(connection, sessionId)

  const bound = data?.bound != null
  const chapters = data?.chapters ?? []
  const scenes = data?.scenes ?? []
  const threads = data?.threads ?? []
  const arcs = data?.arcs ?? []
  const foreshadowing = data?.foreshadowing ?? []
  const reveals = data?.reveals ?? []

  return (
    <>
      <button
        type="button"
        className={css.petTrigger}
        title={t('story.title')}
        aria-label={t('story.title')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={css.petLabel}>{t('story.title')}</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('story.title')}
        closeLabel={t('inbox.close')}
        contentClassName={css.modalContent}
      >
        {!bound ? (
          <div className={css.empty}>{t('story.unbound')}</div>
        ) : chapters.length + scenes.length + threads.length + arcs.length + foreshadowing.length + reveals.length === 0 ? (
          <div className={css.empty}>{t('story.empty')}</div>
        ) : (
          <div>
            <Section title={t('story.threads')} lines={threads.map((x) => {
              const range = x.start_chapter != null ? `ch${x.start_chapter}${x.end_chapter != null ? '-' + x.end_chapter : ''}` : ''
              return `${x.name}${x.thread_type ? ' · ' + x.thread_type : ''}${range ? ' · ' + range : ''}`
            })} />
            <Section title={t('story.arcs')} lines={arcs.map((x) => {
              const range = x.chapter_range?.length ? `ch${x.chapter_range[0]}-${x.chapter_range[x.chapter_range.length - 1]}` : ''
              return `${x.name}${range ? ' · ' + range : ''}`
            })} />
            <Section title={t('story.foreshadowing')} lines={foreshadowing.map((x) => x.name)} />
            <Section title={t('story.reveals')} lines={reveals.map((x) => {
              const target = x.target_id ? ' → ' + x.target_id : ''
              const secret = x.secret_summary ? ' · ' + x.secret_summary : ''
              return `${x.name}${target}${secret}`
            })} />
            <Section title={t('story.scenes')} lines={scenes.map((x) => {
              const ch = x.chapters?.length ? ' · ch' + x.chapters.join(',') : ''
              return `${x.title ?? x.slug}${ch}`
            })} />
          </div>
        )}
      </Modal>
    </>
  )
}
