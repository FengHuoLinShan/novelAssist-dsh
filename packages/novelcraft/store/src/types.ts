// 共享类型(零依赖、零 DSH、零 LLM)

export type AssetKind =
  | 'book'
  | 'object'
  | 'pending'
  | 'scene'
  | 'chapter'
  | 'chapter_candidate'
  | 'thread'
  | 'arc'
  | 'foreshadowing'
  | 'reveal'
  | 'outline'
  | 'bible_page'
  | 'imported_chapter';

export type Frontmatter = Record<string, unknown>;

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}
