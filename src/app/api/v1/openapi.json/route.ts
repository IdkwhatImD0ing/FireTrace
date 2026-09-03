import { serverEnv } from "@/lib/env/server";
import { ingestResultSchema, openApiDocument } from "@/lib/firetrace/openapi";

export const runtime = "nodejs";

/** Public OpenAPI 3.1 document for the key-authenticated API. */
export async function GET(request: Request) {
  let baseUrl: string;
  try {
    baseUrl = serverEnv().appUrl;
  } catch {
    baseUrl = new URL(request.url).origin;
  }
  const doc = openApiDocument(baseUrl) as {
    components: { schemas: Record<string, unknown> };
  };
  doc.components.schemas.IngestResult = ingestResultSchema;
  return Response.json(doc, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
