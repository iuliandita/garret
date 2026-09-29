/** Candidate confirmation/cancellation belongs to the input method, including
 * engines that only expose the legacy composition key code on the final key. */
export function isCompositionKey(event: { readonly isComposing?: boolean; readonly keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
