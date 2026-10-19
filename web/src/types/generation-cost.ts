export type ModelPrice = { unit: "request" | "second"; amount: string };

export type GenerationCostSnapshot = {
    id: string;
    projectId: string;
    nodeId: string;
    itemId?: string;
    channelId: string;
    channelName: string;
    modelName: string;
    capability: "image" | "video" | "audio" | "text";
    price?: ModelPrice;
    seconds?: number;
    submittedAt?: string;
};

export type GenerationCostRecord = GenerationCostSnapshot & {
    status: "pending" | "success" | "cancelled";
    submittedAt: string;
    receivedAt?: string;
};
