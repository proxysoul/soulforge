import { getCwd } from "../cwd.js";
import { getIntelligenceRouter } from "../intelligence/index.js";
import type { TrackedResult } from "../workers/intelligence-client.js";

/** Fallback: use main-thread router when worker client is unavailable */
export async function fallbackTracked<T>(
  file: string | undefined,
  operation: string & keyof import("../intelligence/types.js").IntelligenceBackend,
  fn: (b: import("../intelligence/types.js").IntelligenceBackend) => Promise<T | null>,
): Promise<TrackedResult<T>> {
  const router = getIntelligenceRouter(getCwd());
  const language = router.detectLanguage(file);
  return router.executeWithFallbackTracked(language, operation, fn);
}
