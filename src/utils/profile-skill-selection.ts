export function usesProfileSkillAllowList(isCloud: boolean): boolean {
  return (
    !isCloud || import.meta.env.VITE_HOSTED_PROFILE_SKILL_ALLOW_LIST === "true"
  );
}
