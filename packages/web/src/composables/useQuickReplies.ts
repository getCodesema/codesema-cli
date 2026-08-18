// Pure heuristic behind the quick-reply buttons under an active question:
// when the agent's question enumerates its options ("v2 or an optional
// field?", a bulleted list, "A, B ou C ?"), each option becomes a one-click
// answer. No option detected → no buttons, the plain reply field is enough.
// The reply sent IS the option text: the agent asked in those words.

/** Quick replies stop being quick past this many buttons. */
const MAX_OPTIONS = 4

/** An "option" longer than this is a sentence, not a choice. */
const MAX_OPTION_LENGTH = 60

/** Bulleted or numbered list item: "- x", "* x", "• x", "1. x", "2) x". */
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/

/**
 * Leading interrogative boilerplate of a disjunctive question, so that
 * "Do you prefer v2 or an optional field?" yields "v2", not the whole clause.
 * Applied repeatedly: "est-ce que tu préfères X" sheds both layers.
 */
const QUESTION_LEADS = [
  /^est-ce (?:que|qu')\s*/i,
  /^(?:do|would|should|shall|could|can) (?:you|i|we)\s+/i,
  /^(?:want|prefer|rather|like) (?:to\s+)?/i,
  /^(?:tu|vous|on|je|nous)\s+/i,
  /^(?:préférez|préfères|préférerais|préféreriez|veux|voulez|voudrais|voudriez|choisis|choisissez|prends|prenez|pars|partez|dois|devons|devrais|devrions|faut|peux|peut|pouvez|pouvons)(?:-(?:tu|vous|je|on|nous|il))?\s+/i,
  /^(?:plutôt|donc|alors|going with|go with|use|utiliser?)\s+/i,
  /^(?:que|qu')\s*/i,
  /^(?:sur|pour|avec|par|on|with|for)\s+/i,
  /^(?:la|le|les|l'|un|une|des|the|a|an)\s+/i,
]

/** A fragment that is a conditional lead-in ("Si tu veux, …"), not a choice. */
const CONDITIONAL_LEAD = /^(?:si|if|quand|when|lorsque)\s/i

/** Trims quotes, guillemets, trailing punctuation and markers off an option. */
function cleanOption(raw: string): string {
  return raw
    .replace(/^[\s"'«‹:·—-]+/, '')
    .replace(/[\s"'»›?!.,;:]+$/, '')
    .trim()
}

/** Strips the interrogative lead-in of the FIRST fragment of a disjunction. */
function stripQuestionLead(fragment: string): string {
  let text = fragment.trim()
  for (let pass = 0; pass < 4; pass++) {
    const before = text
    for (const lead of QUESTION_LEADS) {
      text = text.replace(lead, '')
    }
    if (text === before) {
      break
    }
  }
  return text.trim()
}

/** Keeps a candidate list only when EVERY entry reads as a short option. */
function validate(candidates: string[]): string[] {
  const seen = new Set<string>()
  const options: string[] = []
  for (const candidate of candidates) {
    const option = cleanOption(candidate)
    if (option.length === 0 || option.length > MAX_OPTION_LENGTH) {
      return []
    }
    const fold = option.toLowerCase()
    if (!seen.has(fold)) {
      seen.add(fold)
      options.push(option)
    }
  }
  return options.length >= 2 && options.length <= MAX_OPTIONS ? options : []
}

/** List items found across the question's lines, when there are enough. */
function listOptions(question: string): string[] {
  const items: string[] = []
  for (const line of question.split('\n')) {
    const match = LIST_ITEM.exec(line)
    if (match?.[1] !== undefined) {
      items.push(match[1])
    }
  }
  return validate(items)
}

/** The clause holding the choice: the last "?" sentence, question mark and
 * "Deux options :"-style preamble (before a colon) stripped; null when the
 * question has no "?" sentence or no ou/or disjunction inside it. */
function choiceClause(question: string): string | null {
  const sentences = question.match(/[^.?!\n]+\?/g)
  const last = sentences?.at(-1)?.trim()
  if (last === undefined) {
    return null
  }
  let clause = last.replace(/\?+$/, '')
  // "Deux options : A ou B ?" — the enumeration lives after the colon.
  const colonAt = clause.lastIndexOf(':')
  if (colonAt !== -1) {
    clause = clause.slice(colonAt + 1)
  }
  // No disjunction word → not an enumerated choice.
  return /\s(?:ou|or)\s/i.test(clause) ? clause : null
}

/** The choice clause split on its ou/or (and commas), lead-in stripped. */
function disjunctionOptions(question: string): string[] {
  const clause = choiceClause(question)
  if (clause === null) {
    return []
  }
  // "…, oui ou non ?" — the trailing yes/no IS the whole choice.
  const yesNo = /(?:^|[\s,])(oui\s+ou\s+non|yes\s+or\s+no)\s*$/i.exec(clause)
  if (yesNo?.[1] !== undefined) {
    return validate(yesNo[1].split(/\s+(?:ou|or)\s+/i))
  }
  const fragments = clause
    .split(/\s*,\s*|\s+(?:ou|or)\s+/i)
    .filter((f) => f.trim().length > 0)
    // "Si tu veux, A ou B ?" — the conditional lead-in is not an option.
    .filter((f) => !CONDITIONAL_LEAD.test(f.trim()))
  const head = fragments[0]
  if (fragments.length < 2 || head === undefined) {
    return []
  }
  const first = stripQuestionLead(head)
  if (first.length === 0) {
    return []
  }
  return validate([first, ...fragments.slice(1)])
}

/**
 * The enumerated options of a question, or [] when the question does not
 * enumerate any. Bulleted lists win over inline "A ou B ?" when both exist:
 * the list is the explicit enumeration.
 */
export function extractQuickReplies(question: string): string[] {
  const fromList = listOptions(question)
  if (fromList.length > 0) {
    return fromList
  }
  return disjunctionOptions(question)
}
