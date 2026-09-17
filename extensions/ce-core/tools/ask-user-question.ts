import { readFileSync } from "node:fs"
import path from "node:path"
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent"

export type QuestionOption = string | { label: string; description?: string }

export interface SingleQuestionInput {
  question: string
  options?: QuestionOption[]
  allowCustom?: boolean
  header?: string
}

export interface AskUserQuestionInput {
  question?: string
  options?: QuestionOption[]
  allowCustom?: boolean
  questions?: SingleQuestionInput[]
}

export interface AskUserQuestionUi {
  input(question: string): Promise<string | null>
  select(question: string, options: string[]): Promise<string | null>
}

export interface AskUserQuestionResult {
  answer: string | null
  mode: "input" | "select" | "custom" | "cancelled"
}

/** Sentinel label used to offer a free-text custom answer. */
export const CUSTOM_SENTINEL = "Other"

/**
 * Maximum display width for a normalized option label. Long labels overflow the
 * selector row in the built-in `ctx.ui.select()` renderer (see
 * `docs/bug/ask-user-question-long-options-truncated.md`), so labels are kept
 * to a single line and truncated to this width.
 */
export const MAX_OPTION_LABEL_WIDTH = 60

/**
 * Build the single-line display label for one option.
 * Supports string options and structured { label, description } objects.
 *
 * Rules:
 * - Take only the first line (drop embedded `\n`).
 * - Trim surrounding whitespace.
 * - Truncate to {@link MAX_OPTION_LABEL_WIDTH} with an ellipsis when needed.
 */
export function toOptionDisplayLabel(option: QuestionOption): string {
  if (typeof option === "object" && option !== null && "label" in option) {
    const label = option.label.trim()
    const desc = option.description?.trim()
    const combined = desc ? `${label} — ${desc}` : label
    const firstLine = combined.split("\n", 1)[0] ?? ""
    const trimmed = firstLine.trim()
    if (trimmed.length <= MAX_OPTION_LABEL_WIDTH) {
      return trimmed
    }
    return trimmed.slice(0, MAX_OPTION_LABEL_WIDTH - 1) + "…"
  }
  const str = String(option)
  const firstLine = str.split("\n", 1)[0] ?? ""
  const trimmed = firstLine.trim()
  if (trimmed.length <= MAX_OPTION_LABEL_WIDTH) {
    return trimmed
  }
  return trimmed.slice(0, MAX_OPTION_LABEL_WIDTH - 1) + "…"
}

/**
 * Build display labels for all options, disambiguating collisions with a
 * numeric suffix so the selector never shows two identical rows.
 *
 * @returns A map from display label back to the original full option string.
 *          When collisions exist, labels become `<label> (#<n>)`.
 */
export function normalizeQuestionOptions(options: QuestionOption[]): Map<string, string> {
  const labelToOriginal = new Map<string, string>()
  const labelCounts = new Map<string, number>()

  for (const original of options) {
    const baseLabel = toOptionDisplayLabel(original)
    const count = (labelCounts.get(baseLabel) ?? 0) + 1
    labelCounts.set(baseLabel, count)

    // Start from the count-based suffix, then keep appending (#n) until we find
    // a label that is truly unused. This handles pathological inputs where an
    // option's own text already ends in `(#k)` and would otherwise collide.
    let label = count === 1 ? baseLabel : `${baseLabel} (#${count})`
    let dedup = count
    while (labelToOriginal.has(label)) {
      dedup += 1
      label = `${baseLabel} (#${dedup})`
    }

    const resolvedValue = typeof original === "object" && original !== null && "label" in original
      ? original.label
      : String(original)
    labelToOriginal.set(label, resolvedValue)
  }

  return labelToOriginal
}

/** Choose a display label for the custom-answer sentinel that never collides. */
export function resolveCustomSentinelLabel(labelToOriginal: Map<string, string>): string {
  if (!labelToOriginal.has(CUSTOM_SENTINEL)) {
    return CUSTOM_SENTINEL
  }
  let index = 2
  while (labelToOriginal.has(`${CUSTOM_SENTINEL} (#${index})`)) {
    index += 1
  }
  return `${CUSTOM_SENTINEL} (#${index})`
}

/**
 * Determine whether the built-in ask_user_question tool should be disabled,
 * e.g. to coexist with third-party extensions like @juicesharp/rpiv-ask-user-question.
 */
export function isAskUserQuestionDisabled(cwd: string = process.cwd()): boolean {
  if (process.env.SUPER_PI_DISABLE_ASK_USER_QUESTION === "1") {
    return true
  }
  const configDir = CONFIG_DIR_NAME || ".pi"
  const projectPath = path.join(cwd, configDir, "settings.json")
  try {
    const raw = readFileSync(projectPath, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed.disableBuiltinAskUserQuestion === true || parsed.externalAskUserQuestion === true) {
      return true
    }
  } catch {}

  const home = process.env.HOME || process.env.USERPROFILE || "~"
  const globalPath = path.join(home, configDir, "agent", "settings.json")
  try {
    const raw = readFileSync(globalPath, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed.disableBuiltinAskUserQuestion === true || parsed.externalAskUserQuestion === true) {
      return true
    }
  } catch {}

  const altGlobalPath = path.join(home, configDir, "settings.json")
  try {
    const raw = readFileSync(altGlobalPath, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed.disableBuiltinAskUserQuestion === true || parsed.externalAskUserQuestion === true) {
      return true
    }
  } catch {}

  return false
}

export function createAskUserQuestionTool() {
  return {
    name: "ask_user_question",
    async execute(
      input: AskUserQuestionInput,
      ui: AskUserQuestionUi,
    ): Promise<AskUserQuestionResult> {
      // Support batch/canonical questions array
      if (input.questions && input.questions.length > 0) {
        const answers: string[] = []
        for (const q of input.questions) {
          const singleResult = await this.execute(
            {
              question: q.question,
              options: q.options,
              allowCustom: q.allowCustom,
            },
            ui,
          )
          if (singleResult.answer === null) {
            return { answer: null, mode: "cancelled" }
          }
          answers.push(`${q.question}: ${singleResult.answer}`)
        }
        return {
          answer: answers.join("\n"),
          mode: "select",
        }
      }

      const questionText = input.question ?? ""
      const options = input.options ?? []

      if (options.length === 0) {
        const answer = await ui.input(questionText)
        return answer === null
          ? { answer: null, mode: "cancelled" }
          : { answer, mode: "input" }
      }

      const allowCustom = input.allowCustom ?? true
      const labelToOriginal = normalizeQuestionOptions(options)
      const customLabel = allowCustom
        ? resolveCustomSentinelLabel(labelToOriginal)
        : null
      const displayOptions = customLabel
        ? [...labelToOriginal.keys(), customLabel]
        : [...labelToOriginal.keys()]

      const selected = await ui.select(questionText, displayOptions)

      if (selected === null) {
        return { answer: null, mode: "cancelled" }
      }

      if (allowCustom && customLabel && selected === customLabel) {
        const customAnswer = await ui.input("Your answer")
        return customAnswer === null
          ? { answer: null, mode: "cancelled" }
          : { answer: customAnswer, mode: "custom" }
      }

      return {
        answer: labelToOriginal.get(selected) ?? selected,
        mode: "select",
      }
    },
  }
}
