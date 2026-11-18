import { useTranslation } from "react-i18next";
import type { CloudOrganizationRole } from "#/api/cloud/types";
import { useUpdateCloudOrganizationMemberRole } from "#/hooks/mutation/use-update-cloud-organization-member-role";
import {
  useCloudOrganizationMe,
  useCloudOrganizationMembers,
} from "#/hooks/query/use-cloud-organization-members";
import { I18nKey } from "#/i18n/declaration";
import { retrieveAxiosErrorMessage } from "#/utils/retrieve-axios-error-message";

const ORGANIZATION_ROLES: CloudOrganizationRole[] = [
  "owner",
  "admin",
  "member",
];
const MANAGE_MEMBERS_PERMISSION = "organization:manage_members";

function roleLabelKey(role: CloudOrganizationRole): I18nKey {
  if (role === "owner") return I18nKey.SETTINGS$ORGANIZATION_ROLE_OWNER;
  if (role === "admin") return I18nKey.SETTINGS$ORGANIZATION_ROLE_ADMIN;
  return I18nKey.SETTINGS$ORGANIZATION_ROLE_MEMBER;
}

export default function OrganizationSettingsScreen() {
  const { t } = useTranslation("openhands");
  const me = useCloudOrganizationMe();
  const isSharedOrganization =
    me.data !== undefined && me.data.orgId !== me.data.userId;
  const members = useCloudOrganizationMembers(isSharedOrganization);
  const updateRole = useUpdateCloudOrganizationMemberRole();

  if (me.isLoading) return <p>{t(I18nKey.HOME$LOADING)}</p>;
  if (me.error) {
    return (
      <p role="alert" className="text-sm text-feedback-error">
        {retrieveAxiosErrorMessage(me.error) || t(I18nKey.ERROR$GENERIC)}
      </p>
    );
  }
  if (!isSharedOrganization) return null;

  const canManageMembers =
    me.data?.permissions?.includes(MANAGE_MEMBERS_PERMISSION) === true;
  const error = members.error ?? updateRole.error;
  const errorMessage = error
    ? retrieveAxiosErrorMessage(error) || t(I18nKey.ERROR$GENERIC)
    : null;

  return (
    <div data-testid="organization-settings" className="flex flex-col gap-6">
      {!canManageMembers && (
        <p
          data-testid="organization-members-read-only"
          className="text-sm text-tertiary-light"
        >
          {t(I18nKey.SETTINGS$ORGANIZATION_READ_ONLY)}
        </p>
      )}

      {errorMessage && (
        <p role="alert" className="text-sm text-feedback-error">
          {errorMessage}
        </p>
      )}

      {members.isLoading ? (
        <p>{t(I18nKey.HOME$LOADING)}</p>
      ) : members.data?.length ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-base-secondary text-tertiary-light">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t(I18nKey.SETTINGS$ORGANIZATION_IDENTITY)}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t(I18nKey.SETTINGS$ORGANIZATION_ROLE)}
                </th>
              </tr>
            </thead>
            <tbody>
              {members.data.map((member) => (
                <tr
                  key={member.user_id}
                  className="border-t border-border align-top"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium">{member.identity.provider}</p>
                    {member.identity.tenant_id && (
                      <code className="mt-1 block break-all text-xs text-tertiary-light">
                        {member.identity.tenant_id}
                      </code>
                    )}
                    <code className="mt-1 block break-all text-xs text-tertiary-light">
                      {member.identity.subject_id}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      data-testid={`organization-role-${member.user_id}`}
                      aria-label={t(I18nKey.SETTINGS$ORGANIZATION_ROLE)}
                      className="rounded border border-border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-70"
                      value={member.role}
                      disabled={!canManageMembers || updateRole.isPending}
                      onChange={(event) => {
                        void updateRole
                          .mutateAsync({
                            userId: member.user_id,
                            role: event.target.value as CloudOrganizationRole,
                          })
                          .catch(() => undefined);
                      }}
                    >
                      {ORGANIZATION_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(roleLabelKey(role))}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{t(I18nKey.SETTINGS$ORGANIZATION_NO_MEMBERS)}</p>
      )}
    </div>
  );
}
