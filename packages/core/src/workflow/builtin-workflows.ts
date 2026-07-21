import type { WorkflowDefinition } from "./workflow.ts";

/**
 * Built-in workflow templates. "standard" is the full long-form episode pipeline (the same
 * shape as DEFAULT_PRODUCTION_PLAN, now with explicit dependency edges). "shorts" is a
 * vertical-video variant: 9:16, tighter duration, no background-music stage — demonstrating
 * that stages can be removed and parameterized per workflow. Channels can also store their
 * own custom workflows in memory (ChannelMemory.workflows), which shadow these by id.
 */

export const STANDARD_WORKFLOW: WorkflowDefinition = {
  id: "standard",
  name: "Standard episode",
  description: "Full long-form pipeline: story through publishing metadata.",
  stages: [
    { id: "story", kind: "story", label: "Story outline", dependsOn: [] },
    { id: "script", kind: "script", label: "Script & dialogue", dependsOn: ["story"] },
    { id: "storyboard", kind: "storyboard", label: "Storyboard beats", dependsOn: ["script"] },
    { id: "image", kind: "image", label: "Key frames per beat", dependsOn: ["storyboard"] },
    { id: "voice", kind: "voice", label: "Voice lines per beat", dependsOn: ["script"] },
    { id: "music", kind: "music", label: "Background music", dependsOn: ["story"] },
    { id: "video", kind: "video", label: "Animate beats", dependsOn: ["image"] },
    { id: "subtitles", kind: "subtitles", label: "Subtitles", dependsOn: ["voice"] },
    { id: "thumbnail", kind: "thumbnail", label: "Thumbnail", dependsOn: ["image"] },
    { id: "metadata", kind: "metadata", label: "Title, description, tags", dependsOn: ["script"] },
  ],
};

export const SHORTS_WORKFLOW: WorkflowDefinition = {
  id: "shorts",
  name: "Vertical short",
  description: "9:16 short-form cut: no background music, 45-second target.",
  stages: [
    { id: "story", kind: "story", label: "Short-form hook & story", dependsOn: [] },
    { id: "script", kind: "script", label: "Tight script", dependsOn: ["story"] },
    { id: "storyboard", kind: "storyboard", label: "Storyboard beats", dependsOn: ["script"] },
    {
      id: "image",
      kind: "image",
      label: "Vertical key frames",
      dependsOn: ["storyboard"],
      params: { aspect: "9:16" },
    },
    { id: "voice", kind: "voice", label: "Voice lines", dependsOn: ["script"] },
    {
      id: "video",
      kind: "video",
      label: "Animate vertical beats",
      dependsOn: ["image"],
      params: { aspect: "9:16", durationSec: 45 },
    },
    { id: "subtitles", kind: "subtitles", label: "Burn-in subtitles", dependsOn: ["voice"] },
    {
      id: "thumbnail",
      kind: "thumbnail",
      label: "Vertical cover",
      dependsOn: ["image"],
      params: { aspect: "9:16" },
    },
    { id: "metadata", kind: "metadata", label: "Shorts title & tags", dependsOn: ["script"] },
  ],
};

export const BUILTIN_WORKFLOWS: readonly WorkflowDefinition[] = [
  STANDARD_WORKFLOW,
  SHORTS_WORKFLOW,
];

export function findBuiltinWorkflow(id: string): WorkflowDefinition | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.id === id);
}

/** Channel-defined workflows shadow built-ins with the same id. */
export function resolveWorkflow(
  id: string,
  channelWorkflows?: Readonly<Record<string, WorkflowDefinition>>,
): WorkflowDefinition | undefined {
  return channelWorkflows?.[id] ?? findBuiltinWorkflow(id);
}
