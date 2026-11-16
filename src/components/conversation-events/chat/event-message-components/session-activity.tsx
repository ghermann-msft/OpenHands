import { useOptionalConversationId } from "#/hooks/use-conversation-id";
import { useSessionActivities } from "#/hooks/use-session-activities";
import { useSessionActivityStore } from "#/stores/session-activity-store";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { DisclosureCaret } from "#/components/shared/disclosure-caret";
import type { SessionActivity } from "#/stores/session-activity-store";
import type {
  AppConversationStartTaskStatus,
  SandboxStartupPhase,
  SandboxStartupProgress,
} from "#/api/conversation-service/agent-server-conversation-service.types";
import type { TFunction } from "i18next";

const phaseLabels: Partial<
  Record<AppConversationStartTaskStatus, { live: I18nKey; detail: I18nKey }>
> = {
  WAITING_FOR_SANDBOX: {
    live: I18nKey.COMMON$WAITING_FOR_SANDBOX,
    detail: I18nKey.EVENT_GROUP$SANDBOX_CONNECTION,
  },
  PREPARING_REPOSITORY: {
    live: I18nKey.EVENT_GROUP$PREPARING_WORKSPACE,
    detail: I18nKey.EVENT_GROUP$WORKSPACE_PREPARATION,
  },
  RUNNING_SETUP_SCRIPT: {
    live: I18nKey.EVENT_GROUP$CHECKING_SETUP_SCRIPT,
    detail: I18nKey.EVENT_GROUP$SETUP_SCRIPT_CHECK,
  },
  SETTING_UP_GIT_HOOKS: {
    live: I18nKey.STATUS$SETTING_UP_GIT_HOOKS,
    detail: I18nKey.EVENT_GROUP$GIT_HOOKS,
  },
  SETTING_UP_SKILLS: {
    live: I18nKey.STATUS$SETTING_UP_SKILLS,
    detail: I18nKey.EVENT_GROUP$SKILLS,
  },
  STARTING_CONVERSATION: {
    live: I18nKey.EVENT_GROUP$CONNECTING_AGENT,
    detail: I18nKey.EVENT_GROUP$AGENT_CONNECTION,
  },
  READY: {
    live: I18nKey.EVENT_GROUP$CONNECTING_AGENT,
    detail: I18nKey.EVENT_GROUP$AGENT_CONNECTION,
  },
};

export function sessionActivityLiveTitle(session: SessionActivity): I18nKey {
  if (session.phase === "connecting")
    return I18nKey.EVENT_GROUP$CONNECTING_AGENT;
  if (session.phase !== "pending") return sessionActivityTitle(session);
  const status = session.currentStatus ?? session.steps.at(-1);
  return (status && phaseLabels[status]?.live) || sessionActivityTitle(session);
}

function sandboxProgressFallback(progress: SandboxStartupProgress): I18nKey {
  const phase: SandboxStartupPhase = progress.phase;
  switch (phase) {
    case "WAITING_FOR_CAPACITY":
    case "PROVISIONING_NODE":
    case "SCHEDULING":
    case "PULLING_IMAGE":
      return I18nKey.COMMON$WAITING_FOR_SANDBOX;
    case "PROVISIONING_STORAGE":
      return I18nKey.EVENT_GROUP$PREPARING_WORKSPACE;
    case "STARTING_CONTAINER":
      return I18nKey.COMMON$STARTING;
    case "WAITING_FOR_AGENT_SERVER":
      return I18nKey.CHAT_INTERFACE$CONNECTING;
    case "READY":
      return I18nKey.CONVERSATION$READY;
    case "FAILED":
      return I18nKey.COMMON$ERROR;
  }
}

export function sessionActivityLiveLabel(
  session: SessionActivity,
  t: TFunction,
): string {
  const progress = session.currentStartupProgress;
  if (progress?.message.trim()) return progress.message;
  return t(
    progress
      ? sandboxProgressFallback(progress)
      : sessionActivityLiveTitle(session),
  );
}

export function sessionActivityTitle(session: SessionActivity): I18nKey {
  if (session.phase === "failed") return I18nKey.COMMON$ERROR;
  if (session.phase === "pending" || session.phase === "connecting")
    return session.kind === "resume"
      ? I18nKey.EVENT_GROUP$SESSION_RESUMING
      : I18nKey.EVENT_GROUP$SESSION_INITIALIZING;
  return session.kind === "resume"
    ? I18nKey.EVENT_GROUP$SESSION_RESUMED
    : I18nKey.EVENT_GROUP$SESSION_INITIALIZED;
}

export function SessionActivityDetails({
  session,
  nested = true,
}: {
  session: SessionActivity;
  nested?: boolean;
}) {
  const { t } = useTranslation("openhands");
  const { conversationId } = useOptionalConversationId();
  const { key } = useSessionActivities(conversationId);
  const open = session.detailsOpen ?? false;
  const setOpen = (value: boolean) =>
    useSessionActivityStore.getState().setDetailsOpen(key, session.id, value);
  const steps = [
    ...new Set(
      session.steps.flatMap((step) => {
        const label = phaseLabels[step]?.detail;
        return label ? [label] : [];
      }),
    ),
  ];
  const startupDetails = (session.startupSteps ?? []).map(
    (progress) =>
      progress.message.trim() || t(sandboxProgressFallback(progress)),
  );
  const taskDetails = steps
    .filter(
      (step) =>
        !startupDetails.length ||
        step !== I18nKey.EVENT_GROUP$SANDBOX_CONNECTION,
    )
    .map((step) => t(step));
  const detailsList = [...new Set([...startupDetails, ...taskDetails])];
  const details = detailsList.length ? (
    <ul className="space-y-1 text-muted">
      {detailsList.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ul>
  ) : (
    <p className="text-muted">{sessionActivityLiveLabel(session, t)}</p>
  );
  return (
    <div className="py-2" data-testid="session-activity-details">
      {nested ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 text-muted"
          >
            <span>{t(sessionActivityTitle(session))}</span>
            <DisclosureCaret open={open} />
          </button>
          {open && <div className="mt-2">{details}</div>}
        </>
      ) : (
        details
      )}
    </div>
  );
}
