/** The opening of a held turn's resume note: the limit hold writes it, an engine that kept a cut-off turn's steps reads it. */
export const RESUME_OPENS = "[Metal: your previous turn here was cut off because ";
export const RESUME_CAUSE = "'s usage limit was reached. The limit has reset.";

/** whether a turn's text is a held turn's resume */
export function isLimitResume(text: string): boolean {
  return [RESUME_OPENS, "[dusk bot: your previous turn here was cut off because "].some((opening) => {
    const at = text.indexOf(opening);
    return at >= 0 && text.indexOf(RESUME_CAUSE, at) > at;
  });
}
