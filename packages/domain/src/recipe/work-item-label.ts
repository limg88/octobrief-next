import type { Lang } from '../language/index.ts'
import type { WorkItem } from '../tracker.ts'
import { recipeText } from './messages/index.ts'

/**
 * How a work item another one names (its feature, its parent) is shown in a document: its title
 * with its id; its id and that the title was not read when the tracker gave none, or the item was
 * not read. A title is never made up.
 */
export function workItemLabel(
  id: string,
  item: Pick<WorkItem, 'summary'> | undefined,
  lang: Lang,
): string {
  const title = item?.summary?.trim() ?? ''
  return title === ''
    ? recipeText('gathering', 'work_item_title_not_read', { id }, lang)
    : recipeText('gathering', 'work_item_title', { title, id }, lang)
}
