import { loadAgentServerInfo } from "../agent-server-compatibility";
import { getActiveBackend } from "../backend-registry/active-store";
import { callCloudProxy } from "../cloud/proxy";
import { WebClientConfig } from "./option.types";

class OptionService {
  static async getConfig(): Promise<WebClientConfig> {
    const { backend } = getActiveBackend();
    if (backend.kind === "cloud") {
      return callCloudProxy<WebClientConfig>({
        backend,
        method: "GET",
        path: "/api/v1/web-client/config",
      });
    }

    await loadAgentServerInfo();

    return {
      feature_flags: {
        hide_llm_settings: false,
        hide_users_page: true,
      },
      providers_configured: [],
      maintenance_start_time: null,
      recaptcha_site_key: null,
      faulty_models: [],
      error_message: null,
      updated_at: new Date().toISOString(),
    };
  }
}

export default OptionService;
