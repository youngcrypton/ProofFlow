export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly contentType: string,
    readonly responseText: string
  ) {
    super(message);
    this.name = "ApiResponseError";
  }
}

export async function parseApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "unknown";
  const responseText = await response.text();
  if (!responseText.trim()) {
    throw new ApiResponseError(`Request failed (${response.status}): empty response (${contentType})`, response.status, contentType, responseText);
  }
  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new ApiResponseError(`Request failed (${response.status}): expected JSON but received ${contentType}`, response.status, contentType, responseText);
  }
}
