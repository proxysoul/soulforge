import { tool } from "ai";
import { z } from "zod";

/**
 * `final_response` — call this ONCE as the last tool of a turn, immediately
 * before writing the final answer text. Tells the renderer where the rail
 * ends and the streamed final answer begins.
 *
 * No arguments — calling the tool IS the signal. Skip entirely for
 * zero-tool / single-tool turns.
 */
export function createFinalResponseTool() {
  return tool({
    description:
      "Signal the start of your final answer for this tab. " +
      "Tool calls render as a collapsed rail; this call tells the renderer where the final-answer text begins so it streams visibly. " +
      "Call ONCE as your last tool, immediately before writing the final answer. " +
      "Skip entirely for zero-tool or single-tool turns.",
    inputSchema: z.object({}).optional(),
    execute: async () => "final response — answer streaming",
  });
}
