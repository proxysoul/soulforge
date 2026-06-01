import * as p from "@clack/prompts";
import { getCwd } from "../cwd.js";
import { resolvePresets } from "./loader.js";
import { appendPresets, listPresets, type PresetScope } from "./persist.js";
import { fetchRegistry } from "./registry.js";

export async function runPresetsWizard(): Promise<number> {
  p.intro("soulforge presets");

  const cwd = getCwd();
  const alreadyGlobal = new Set(listPresets("global"));
  const alreadyProject = new Set(listPresets("project", cwd));

  const spin = p.spinner();
  spin.start("Fetching registry");
  let registry: Awaited<ReturnType<typeof fetchRegistry>>;
  try {
    registry = await fetchRegistry(true);
  } catch (err) {
    spin.stop("Failed to fetch registry");
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Aborted");
    return 1;
  }
  const entries = Object.entries(registry.presets);
  spin.stop(`Found ${entries.length} preset${entries.length === 1 ? "" : "s"}`);

  if (entries.length === 0) {
    p.outro("Registry is empty");
    return 0;
  }

  const picked = await p.multiselect({
    message: "Pick presets to install (space to toggle, enter to confirm)",
    options: entries.map(([name, entry]) => {
      const installedTag =
        alreadyGlobal.has(name) && alreadyProject.has(name)
          ? " [global+project]"
          : alreadyGlobal.has(name)
            ? " [global]"
            : alreadyProject.has(name)
              ? " [project]"
              : "";
      const desc = entry.description ?? (entry.tags ?? []).join(", ");
      return {
        value: name,
        label: name + installedTag,
        hint: desc || undefined,
      };
    }),
    required: false,
  });

  if (p.isCancel(picked) || !Array.isArray(picked) || picked.length === 0) {
    p.outro("Nothing selected");
    return 0;
  }

  const scope = await p.select<PresetScope | "ephemeral">({
    message: "Where should these apply?",
    initialValue: "global",
    options: [
      { value: "global", label: "Global", hint: "every project (default)" },
      { value: "project", label: "Project", hint: `${cwd}/.soulforge/config.json` },
      { value: "ephemeral", label: "One-shot", hint: "this launch only, no persistence" },
    ],
  });

  if (p.isCancel(scope)) {
    p.outro("Aborted");
    return 0;
  }

  const fetchSpin = p.spinner();
  fetchSpin.start("Fetching presets");
  const result = await resolvePresets(picked as string[], {
    onProgress: (spec, status, detail) => {
      if (status === "ok") {
        fetchSpin.message(`ok ${spec} (${detail?.source ?? "?"})`);
      } else {
        fetchSpin.message(`fail ${spec}`);
      }
    },
  });
  const okNames = result.resolved.map((r) => r.preset.name);
  fetchSpin.stop(`Fetched ${okNames.length}/${(picked as string[]).length}`);

  for (const f of result.failures) {
    p.log.warn(`${f.spec}: ${f.error}`);
  }

  if (okNames.length === 0) {
    p.outro("Nothing installed");
    return 1;
  }

  if (scope === "ephemeral") {
    p.log.info(`Launch with: --plugin ${okNames.join(" --plugin ")}`);
    p.outro("Ready (not persisted)");
    return result.failures.length > 0 ? 1 : 0;
  }

  try {
    const saved = appendPresets(scope, okNames, cwd);
    const added = saved.after.length - saved.before.length;
    p.log.success(`${added} added, ${okNames.length - added} already present in ${saved.file}`);
  } catch (err) {
    p.log.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    p.outro("Save failed");
    return 1;
  }

  p.outro("Done");
  return result.failures.length > 0 ? 1 : 0;
}
