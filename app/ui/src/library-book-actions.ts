import { t } from "./i18n";
import type { Invoke } from "./project";
import type { ProjectSwitchOutcome } from "./project-switch";
import { registrationNotice, type ProjectSummary } from "./switcher";

export type LibraryCreateResult = "opened" | "unattributed" | "unopened";

export function createLibraryBookActions(deps: {
  invoke: Invoke;
  switchProject(path: string, name?: string): Promise<ProjectSwitchOutcome>;
  refresh(): void;
  onNotice(message: string): void;
  onPendingRegistration?(): void;
  currentWorkspace?(): unknown;
  canReportCreated?(): Promise<boolean>;
}): {
  openBook(path: string, name?: string): Promise<boolean>;
  createBook(name: string, identityId: string | null): Promise<LibraryCreateResult>;
} {
  const opened = (outcome: ProjectSwitchOutcome): boolean => outcome === "switched" || outcome === "same";
  return {
    async openBook(path, name) {
      const result = await deps.switchProject(path, name);
      deps.refresh();
      return opened(result);
    },
    async createBook(name, identityId) {
      const workspace = deps.currentWorkspace?.();
      const created = await deps.invoke("project_create", { name }) as ProjectSummary;
      const warning = registrationNotice(created);
      if (warning) {
        try {
          if (!(await deps.canReportCreated?.() ?? true) || deps.currentWorkspace?.() !== workspace) return "unopened";
        } catch { return "unopened"; }
        deps.refresh();
        deps.onNotice(warning);
        deps.onPendingRegistration?.();
        return "unopened";
      }
      const result = await deps.switchProject(created.path, created.name);
      deps.refresh();
      if (!opened(result)) {
        deps.onNotice(t("library.created-unopened", { name: created.name }));
        return "unopened";
      }
      if (identityId !== null) {
        try {
          const preview = await deps.invoke("identity_pin_preview", { id: identityId }) as { token: string };
          await deps.invoke("identity_pin", { id: identityId, token: preview.token });
        } catch (error: unknown) {
          deps.onNotice(t("library.error.pin", { error: error instanceof Error ? error.message : String(error) }));
          return "unattributed";
        }
      }
      return "opened";
    },
  };
}
