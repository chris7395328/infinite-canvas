export function providerError(data, fallback = "") {
    const metadata = data?.ResponseMetadata || data?.data?.ResponseMetadata || data?.Response;
    const error = metadata?.Error || data?.error || data?.Error || data?.data?.error || data?.data?.Error;
    const message = [typeof error === "string" ? error : error?.message || error?.Message, data?.message, data?.Message, data?.msg]
        .find((value) => typeof value === "string" && value.trim()) || fallback;
    const code = error?.code || error?.Code || error?.type || error?.Type;
    const requestId = metadata?.RequestId || data?.request_id || data?.requestId || data?.data?.request_id;
    return [code, message, requestId && `Request ID: ${requestId}`].filter(Boolean).join("；");
}
