export type ModelPrice = { unit: "request" | "second"; amount: string };
export type ResolutionPrice = ModelPrice & { resolution: string };

export type GenerationCostSnapshot = {
    id: string;
    projectId: string;
    nodeId: string;
    itemId?: string;
    channelId: string;
    channelName: string;
    modelName: string;
    capability: "image" | "video" | "audio" | "text";
    resolution?: string;
    size?: string;
    price?: ModelPrice;
    seconds?: number;
    submittedAt?: string;
    prompt?: string;
    parameters?: Record<string, string | number | boolean>;
};

export type GenerationCostRecord = GenerationCostSnapshot & {
    status: "pending" | "success" | "cancelled";
    submittedAt: string;
    receivedAt?: string;
    originalPrice?: ModelPrice | null;
    repricedAt?: string;
};
