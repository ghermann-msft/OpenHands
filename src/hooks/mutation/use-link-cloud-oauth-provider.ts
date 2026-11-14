import { useMutation } from "@tanstack/react-query";
import { linkCloudOAuthProvider } from "#/api/cloud/oauth-service.api";
import { requireAbsoluteHttpsUrl } from "#/utils/absolute-https-url";

export function useLinkCloudOAuthProvider() {
  return useMutation({
    mutationFn: async (providerId: number) =>
      requireAbsoluteHttpsUrl(await linkCloudOAuthProvider(providerId)),
    onSuccess: (startUrl) => window.location.assign(startUrl),
    meta: { disableToast: true },
  });
}
