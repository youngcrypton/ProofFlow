import { describe, expect, it } from "vitest";
import { ApiResponseError, parseApiResponse } from "./api-response";

describe("API response parsing", () => {
  it("parses valid JSON responses", async () => {
    const response = Response.json({ data: { ok: true } }, { status: 200 });
    await expect(parseApiResponse(response)).resolves.toEqual({ data: { ok: true } });
  });

  it("reports empty responses with status and content type", async () => {
    const response = new Response(null, { status: 404, headers: { "content-type": "text/plain" } });
    const error = await parseApiResponse(response).catch((cause) => cause) as ApiResponseError;
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error.status).toBe(404);
    expect(error.contentType).toBe("text/plain");
    expect(error.responseText).toBe("");
  });

  it("reports non-JSON responses without discarding the response text", async () => {
    const response = new Response("<html>not json</html>", { status: 502, headers: { "content-type": "text/html" } });
    const error = await parseApiResponse(response).catch((cause) => cause) as ApiResponseError;
    expect(error.status).toBe(502);
    expect(error.contentType).toBe("text/html");
    expect(error.responseText).toBe("<html>not json</html>");
  });
});
