import { createContext } from "react";
import type { NodeGenerationInput } from "./canvas-node-generation";
import type { GeminiAudioReference } from "@/lib/gemini-audio";

export const CanvasAudioInputsContext = createContext<GeminiAudioReference[]>([]);

export function audioReferencesFromInputs(inputs: NodeGenerationInput[]): GeminiAudioReference[] {
    const resources = inputs.flatMap((input) => input.type === "group" ? input.children : [input]);
    return [...new Map(resources.flatMap((input) => input.audio ? [[input.nodeId, { nodeId: input.nodeId, title: input.title, audio: input.audio }] as const] : [])).values()];
}
