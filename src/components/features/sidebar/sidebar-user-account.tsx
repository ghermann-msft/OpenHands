import { LogOut, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MAIN_APP_LOGOUT_PATH } from "#/api/main-app-auth";
import { StyledTooltip } from "#/components/shared/buttons/styled-tooltip";
import { useMainAppUser } from "#/hooks/query/use-main-app-user";
import { I18nKey } from "#/i18n/declaration";
import {
  sidebarNavLabelClassName,
  sidebarNavRowClassName,
} from "./sidebar-layout";
import { SidebarCollapsedIconSlot } from "./sidebar-collapsed-icon-slot";

const ICON_SIZE = 18;

interface SidebarUserAccountProps {
  collapsed: boolean;
}

export function SidebarUserAccount({ collapsed }: SidebarUserAccountProps) {
  const { t } = useTranslation("openhands");
  const { data: user } = useMainAppUser();

  if (!user) return null;

  const normalizedUsername = user.username?.trim() ?? "";
  const displayName = user.name?.trim() || normalizedUsername || user.id;
  const username =
    normalizedUsername && normalizedUsername !== displayName
      ? normalizedUsername
      : null;

  if (collapsed) {
    return (
      <StyledTooltip
        content={
          <div className="flex flex-col">
            <span>{displayName}</span>
            {username ? <span>{username}</span> : null}
            <span>{t(I18nKey.ACCOUNT$SIGN_OUT)}</span>
          </div>
        }
        placement="right"
      >
        <a
          href={MAIN_APP_LOGOUT_PATH}
          data-testid="sidebar-sign-out"
          className={sidebarNavRowClassName({ collapsed: true })}
        >
          <SidebarCollapsedIconSlot active={false}>
            <LogOut width={ICON_SIZE} height={ICON_SIZE} />
          </SidebarCollapsedIconSlot>
          <span className={sidebarNavLabelClassName(true)}>{displayName}</span>
          <span className="sr-only">{t(I18nKey.ACCOUNT$SIGN_OUT)}</span>
        </a>
      </StyledTooltip>
    );
  }

  return (
    <div
      data-testid="sidebar-user-account"
      className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5"
    >
      <UserRound
        width={ICON_SIZE}
        height={ICON_SIZE}
        className="shrink-0 text-muted"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-contrast">{displayName}</span>
        {username ? (
          <span className="truncate text-xs text-muted">{username}</span>
        ) : null}
      </div>
      <a
        href={MAIN_APP_LOGOUT_PATH}
        data-testid="sidebar-sign-out"
        aria-label={t(I18nKey.ACCOUNT$SIGN_OUT)}
        title={t(I18nKey.ACCOUNT$SIGN_OUT)}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-none hover:bg-surface-raised hover:text-contrast"
      >
        <LogOut width={16} height={16} />
      </a>
    </div>
  );
}
