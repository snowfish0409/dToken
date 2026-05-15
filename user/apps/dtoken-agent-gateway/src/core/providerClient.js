import { providerPath } from "./profileStore.js";
import { formatHeaders } from "./formatBridge.js";

export async function forwardChatCompletion(profile, body, { stream, clientFormat }) {
  const forwarded = {
    ...body,
    model: profile.dtoken.model,
    stream: !!stream,
  };
  return fetch(providerPath(profile, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${profile.dtoken.apiKey}`,
      ...formatHeaders(profile, clientFormat),
    },
    body: JSON.stringify(forwarded),
  });
}
