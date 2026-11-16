import { useTranslation } from "react-i18next";
import { useSandboxSpecs } from "#/hooks/query/use-sandbox-specs";
import { I18nKey } from "#/i18n/declaration";

interface ExecutionProfileSelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  includeSavedDefault?: boolean;
}

function formatResources(
  cpu: string | null | undefined,
  memory: string | null | undefined,
) {
  return [cpu ? `${cpu} CPU` : null, memory].filter(Boolean).join(" / ");
}

export function ExecutionProfileSelect({
  value,
  onChange,
  disabled,
  includeSavedDefault = false,
}: ExecutionProfileSelectProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useSandboxSpecs();
  const profiles = (data?.items ?? []).filter(
    (profile) => profile.enabled && profile.published,
  );
  const selected = profiles.find((profile) => profile.id === value);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium" htmlFor="execution-profile-select">
        {t(I18nKey.SETTINGS$EXECUTION_PROFILE)}
      </label>
      <select
        id="execution-profile-select"
        data-testid="execution-profile-select"
        className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || isLoading}
      >
        {includeSavedDefault && (
          <option value="">
            {t(I18nKey.SETTINGS$USE_DEFAULT_EXECUTION_PROFILE)}
          </option>
        )}
        {profiles.map((profile) => (
          <option
            key={profile.id}
            value={profile.id}
            disabled={profile.availability !== "available"}
          >
            {profile.display_name}
            {profile.availability === "available"
              ? ` (${formatResources(
                  String(profile.cpu_cores),
                  `${profile.memory_gib} GiB`,
                )})`
              : ` - ${
                  profile.availability_reason ??
                  t(I18nKey.SETTINGS$EXECUTION_PROFILE_UNAVAILABLE)
                }`}
          </option>
        ))}
      </select>
      {selected && (
        <p className="text-xs text-text-secondary" role="status">
          {selected.operating_system} / {selected.resource_class}
          {` - ${formatResources(
            String(selected.cpu_cores),
            `${selected.memory_gib} GiB`,
          )}`}
          {selected.capabilities.length
            ? ` - ${selected.capabilities.join(", ")}`
            : ""}
        </p>
      )}
      {!isLoading && profiles.length === 0 && (
        <p className="text-xs text-text-secondary">
          {t(I18nKey.SETTINGS$EXECUTION_PROFILE_DESCRIPTION)}
        </p>
      )}
    </div>
  );
}
