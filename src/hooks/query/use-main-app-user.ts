import { useQuery } from "@tanstack/react-query";
import { isEntraBffEnabled } from "#/api/agent-server-config";
import { getCurrentMainAppUser } from "#/api/main-app-auth";
import { QUERY_KEYS } from "./query-keys";

export function useMainAppUser() {
  return useQuery({
    queryKey: QUERY_KEYS.MAIN_APP_USER,
    queryFn: getCurrentMainAppUser,
    enabled: isEntraBffEnabled(),
    staleTime: 1000 * 60 * 5,
    retry: false,
    meta: { disableToast: true },
  });
}
