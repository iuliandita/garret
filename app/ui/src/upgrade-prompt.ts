/** App-owned consent, independent of webview JavaScript-dialog policy. */
export function askUpgrade(message: string, cancel: string, upgrade: string): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "upgrade-prompt";
  dialog.setAttribute("aria-label", upgrade);
  const explanation = document.createElement("p");
  explanation.textContent = message;
  const actions = document.createElement("div");
  const no = document.createElement("button");
  no.type = "button";
  no.textContent = cancel;
  no.autofocus = true;
  const yes = document.createElement("button");
  yes.type = "button";
  yes.textContent = upgrade;
  actions.append(no, yes);
  dialog.append(explanation, actions);
  document.body.append(dialog);
  return new Promise(resolve => {
    const finish = (answer: boolean): void => { dialog.close(); dialog.remove(); resolve(answer); };
    no.addEventListener("click", () => finish(false));
    yes.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    dialog.showModal();
  });
}
