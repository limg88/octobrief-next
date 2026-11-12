import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryRecipe, RecipeLibrary, Template, TemplateStore } from '@octobrief/application'
import {
  recipeHash,
  TEMPLATE_FORMATS,
  type TemplateFormat,
  validateRecipe,
} from '@octobrief/domain/recipe'

/** Thrown at start when a recipe file of the library is not a valid recipe. */
export class InvalidRecipeFileError extends Error {
  constructor(file: string, codes: readonly string[]) {
    super(`recipe file ${file} is not valid: ${codes.join(', ')}`)
    this.name = 'InvalidRecipeFileError'
  }
}

/**
 * The recipes of an installation: the JSON files of a folder (`{ "recipe": … }`), validated once
 * when the process starts. A file that is not a valid recipe stops the start: a broken recipe is
 * never offered to a PM.
 */
export function createFileRecipeLibrary(directory: string): RecipeLibrary {
  const recipes = new Map<string, LibraryRecipe>()
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(directory, file), 'utf8')) as { recipe?: unknown }
    const checked = validateRecipe(parsed.recipe)
    if (!checked.ok) {
      throw new InvalidRecipeFileError(
        file,
        checked.errors.map((error) => error.code),
      )
    }
    recipes.set(checked.recipe.slug, { recipe: checked.recipe, hash: recipeHash(checked.recipe) })
  }
  const listed = [...recipes.values()].sort((a, b) => a.recipe.title.localeCompare(b.recipe.title))
  return {
    list: () => listed,
    get: (slug) => recipes.get(slug) ?? null,
  }
}

const FORMAT_OF_EXTENSION = new Map<string, TemplateFormat>(
  TEMPLATE_FORMATS.map((format) => [`.${format}`, format]),
)
/** A template is named by its slug: letters, digits and hyphens, never a path. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The templates of an installation: `<slug>.docx|pptx|xlsx` files of a folder. */
export function createFileTemplateStore(directory: string): TemplateStore {
  return {
    async find(slug): Promise<Template | null> {
      if (!SLUG.test(slug)) return null
      for (const [extension, format] of FORMAT_OF_EXTENSION) {
        try {
          const bytes = new Uint8Array(await readFile(join(directory, `${slug}${extension}`)))
          const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
          return { slug, format, bytes, contentHash }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      return null
    },
  }
}
