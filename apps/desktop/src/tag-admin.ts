import type { TagAdmin } from "@supertag/client/model";
import { desktop } from "./desktop";

/**
 * Creating Tags and saving their portraits over one connection; `local` when it is the local
 * Gateway, which can add folders. A call for a connection the app has since left is refused.
 */
export function tagAdminSession(connectionId: string, local = false): TagAdmin {
  const api = desktop();
  return {
    options: () => api.listTagOptions({ connectionId }),
    create: (tag) => api.createTag({ connectionId, tag }),
    setAppearance: (tagId, appearance, expectedRevision) =>
      api.setTagAppearance({ connectionId, tagId, appearance, expectedRevision }),
    tag: (tagId) => api.getTag({ connectionId, tagId }),
    ...(local && { addFolder: () => api.addLocalWorkspace({ connectionId }) }),
  };
}
