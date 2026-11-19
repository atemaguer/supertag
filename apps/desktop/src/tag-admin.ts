import type { TagAdmin } from "@supertag/client/model";
import { desktop } from "./desktop";

/** Tag creation over a connection; `local` when it is the local Gateway, which can add folders. */
export function tagAdminSession(connectionId: string, local = false): TagAdmin {
  const api = desktop();
  return {
    options: () => api.listTagOptions({ connectionId }),
    create: (tag) => api.createTag({ connectionId, tag }),
    ...(local && { addFolder: () => api.addLocalWorkspace({ connectionId }) }),
  };
}
